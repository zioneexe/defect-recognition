// Dataset folder server. Layout: Shape/Group/Clean|Defective/image.png
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export const ROOT = path.resolve(process.env.DATASET_DIR || 'dataset');
export const PORT = Number(process.env.DATASET_PORT || 4310);

const IMAGE = /\.(png|jpe?g|bmp)$/i;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp' };
const CLASSES = ['Clean', 'Defective'];
const MAX_BODY = 50 * 1024 * 1024;
const REMOVED = '.removed';
const META = '.meta.json';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Paths ----

function validName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    !/[\\/:*?"<>|\x00-\x1f]/.test(name) &&
    !name.startsWith('.') &&
    name.trim() === name
  );
}

function canonicalClass(name) {
  return CLASSES.find((item) => item.toLowerCase() === String(name).toLowerCase());
}

function resolve(relative, depths) {
  const parts = String(relative).split('/');
  if (!parts.every(validName) || (depths && !depths.includes(parts.length))) {
    throw new HttpError(400, `Invalid dataset path: ${relative}`);
  }

  const absolute = path.resolve(ROOT, ...parts);
  if (!absolute.startsWith(ROOT + path.sep)) {
    throw new HttpError(400, 'Path escapes the dataset folder.');
  }
  return { parts, absolute };
}

const exists = (file) =>
  fsp.access(file).then(
    () => true,
    () => false,
  );

// ---- Listing ----

async function entries(folder) {
  return fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
}

async function directories(folder) {
  const all = await entries(folder);
  return all
    .filter((entry) => entry.isDirectory() && validName(entry.name))
    .map((entry) => entry.name);
}

async function scanClassFolder(shape, group, folder, result) {
  const imageClass = canonicalClass(folder);

  for (const file of await entries(path.join(ROOT, shape, group, folder))) {
    if (!file.isFile() || !validName(file.name)) continue;
    if (!IMAGE.test(file.name)) {
      result.ignored++;
      continue;
    }

    const stat = await fsp.stat(path.join(ROOT, shape, group, folder, file.name)).catch(() => null);
    if (!stat) continue;

    result.images.push({
      path: [shape, group, folder, file.name].join('/'),
      shape,
      group,
      imageClass,
      size: stat.size,
      modified: stat.mtimeMs,
    });
  }
}

export async function scan() {
  await fsp.mkdir(ROOT, { recursive: true });
  const result = { images: [], ignored: 0 };
  const groups = new Set();
  const folders = {};
  const shapes = await directories(ROOT);

  for (const shape of shapes) {
    for (const group of await directories(path.join(ROOT, shape))) {
      groups.add(group);
      (folders[shape] ||= []).push(group);

      for (const entry of await entries(path.join(ROOT, shape, group))) {
        if (!validName(entry.name)) continue;
        if (entry.isDirectory() && canonicalClass(entry.name)) {
          await scanClassFolder(shape, group, entry.name, result);
        } else {
          result.ignored++;
        }
      }
    }
  }

  return { root: ROOT, shapes, groups: [...groups], folders, ...result };
}

// ---- Writing and removing ----

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) throw new HttpError(413, 'File is larger than 50 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const readJson = async (request) => JSON.parse(await readBody(request));

// name.png -> name_1.png, name_2.png, ... until the name is free.
async function freeName(folder, name) {
  const extension = path.extname(name);
  const stem = name.slice(0, -extension.length);
  let candidate = name;
  for (let n = 1; await exists(path.join(folder, candidate)); n++) {
    candidate = `${stem}_${n}${extension}`;
  }
  return candidate;
}

// On Windows antivirus or indexer can lock the file for a moment, so retry.
async function replace(source, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(source, target);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      if (attempt === 8) return fsp.copyFile(source, target);
      await new Promise((done) => setTimeout(done, 50 * (attempt + 1)));
    }
  }
}

async function write(relative, data, unique) {
  const { parts, absolute } = resolve(relative, [4]);
  if (!canonicalClass(parts[2]) || !IMAGE.test(parts[3])) {
    throw new HttpError(400, 'Images go into Shape/Group/Clean|Defective/ as PNG, JPG or BMP.');
  }

  const folder = path.dirname(absolute);
  await fsp.mkdir(folder, { recursive: true });
  if (unique) parts[3] = await freeName(folder, parts[3]);

  // Write to a temp file first so a half-written image is never listed.
  const temporary = path.join(folder, `.${parts[3]}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(temporary, data);
  try {
    await replace(temporary, path.join(folder, parts[3]));
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  return parts.join('/');
}

// Removed files go to .removed/ instead of being deleted.
async function remove(paths) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let removed = 0;

  for (const relative of paths) {
    const { absolute } = resolve(relative, [4]);
    const target = path.join(ROOT, REMOVED, stamp, ...relative.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });

    try {
      await fsp.rename(absolute, target);
      removed++;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

// ---- File manager ----

function systemOpener(folder) {
  const commands = { win32: 'explorer.exe', darwin: 'open' };
  const command = commands[process.platform] || 'xdg-open';
  spawn(command, [folder], { detached: true, stdio: 'ignore' })
    .on('error', () => {})
    .unref();
}

let opener = systemOpener;

export function setOpener(open) {
  opener = open;
}

async function open(relative) {
  let folder = relative ? resolve(relative, [1, 2, 3]).absolute : ROOT;

  // Go up until the folder exists.
  while (folder !== ROOT) {
    const stat = await fsp.stat(folder).catch(() => null);
    if (stat?.isDirectory()) break;
    folder = path.dirname(folder);
  }

  opener(folder);
  return path.relative(ROOT, folder).split(path.sep).filter(Boolean).join('/');
}

// ---- Watching ----

const clients = new Set();
let pending;

function notifyClients() {
  for (const client of clients) client.write('event: change\ndata: {}\n\n');
}

function changed(file) {
  const hidden =
    file &&
    String(file)
      .split(/[\\/]/)
      .some((part) => part.startsWith('.'));
  if (hidden) return;

  clearTimeout(pending);
  pending = setTimeout(notifyClients, 250);
}

export function watch() {
  try {
    const watcher = fs.watch(ROOT, { recursive: true }, (_, file) => changed(file));
    return { mode: 'fs.watch', close: () => watcher.close() };
  } catch {
    // Polling fallback where recursive fs.watch isn't supported.
    let last = '';
    const timer = setInterval(async () => {
      const { images } = await scan();
      const signature = JSON.stringify(
        images.map((image) => [image.path, image.size, image.modified]),
      );
      if (last && signature !== last) changed();
      last = signature;
    }, 2000);
    return { mode: 'polling', close: () => clearInterval(timer) };
  }
}

// ---- HTTP ----

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function subscribe(request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  response.write('retry: 2000\n\n');
  clients.add(response);
  request.on('close', () => clients.delete(response));
}

async function sendImage(response, file) {
  const { absolute } = resolve(file, [4]);
  const stat = await fsp.stat(absolute).catch(() => null);
  if (!stat?.isFile() || !IMAGE.test(absolute)) {
    return sendJson(response, 404, { error: `No such image: ${file}` });
  }

  response.writeHead(200, {
    'Content-Type': TYPES[path.extname(absolute).slice(1).toLowerCase()],
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
  });
  fs.createReadStream(absolute).pipe(response);
}

async function readMeta() {
  const text = await fsp.readFile(path.join(ROOT, META), 'utf8').catch(() => '{}');
  return JSON.parse(text);
}

async function writeMeta(value) {
  await fsp.writeFile(path.join(ROOT, META), JSON.stringify(value, null, 2));
  return value;
}

const routes = {
  'GET /api/dataset': async () => [200, await scan()],
  'GET /api/meta': async () => [200, await readMeta()],
  'PUT /api/meta': async (request) => [200, await writeMeta(await readJson(request))],
  'POST /api/folders': async (request) => {
    const { absolute } = resolve((await readJson(request)).path, [1, 2, 3]);
    await fsp.mkdir(absolute, { recursive: true });
    return [201, {}];
  },
  'POST /api/open': async (request) => [
    200,
    { path: await open((await readJson(request)).path || '') },
  ],
  'POST /api/remove': async (request) => [
    200,
    { removed: await remove((await readJson(request)).paths || []) },
  ],
};

async function handle(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const route = url.pathname;

  if (request.method === 'GET' && route === '/api/events') return subscribe(request, response);

  if (route.startsWith('/api/files/')) {
    const file = route.slice('/api/files/'.length).split('/').map(decodeURIComponent).join('/');
    if (request.method === 'GET') return sendImage(response, file);
    if (request.method === 'PUT') {
      const unique = url.searchParams.get('unique') === '1';
      const saved = await write(file, await readBody(request), unique);
      return sendJson(response, 201, { path: saved });
    }
  }

  const handler = routes[`${request.method} ${route}`];
  if (!handler) return sendJson(response, 404, { error: 'Not found.' });

  const [status, value] = await handler(request);
  sendJson(response, status, value);
}

export function createServer() {
  return http.createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.message });
    }
  });
}

export async function start() {
  await fsp.mkdir(ROOT, { recursive: true });
  const { mode } = watch();
  await new Promise((done) => createServer().listen(PORT, '127.0.0.1', done));
  console.log(`Dataset folder ${ROOT} · http://127.0.0.1:${PORT}/api · watching with ${mode}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) start();
