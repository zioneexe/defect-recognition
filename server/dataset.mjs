/* Dataset folder server: the folder layout Shape/Group/Clean|Defective/image.png is the
 * source of truth for the dataset tree. Lists, serves, writes and removes images, and
 * pushes a server-sent event whenever anything in the folder changes, so files dropped
 * in by hand show up in the app automatically. Binds to localhost only.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export const ROOT = path.resolve(process.env.DATASET_DIR || 'dataset');
export const PORT = Number(process.env.DATASET_PORT || 4310);
const IMAGE = /\.(png|jpe?g|bmp)$/i, TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp' };
const CLASSES = ['Clean', 'Defective'], MAX_BODY = 50 * 1024 * 1024;
const REMOVED = '.removed', META = '.meta.json';

// One folder or file name: no separators, no dot-prefixed (hidden, temporary or trash) entries.
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\\/:*?"<>|\x00-\x1f]/.test(name) && !name.startsWith('.') && name.trim() === name;
const canonicalClass = name => CLASSES.find(item => item.toLowerCase() === String(name).toLowerCase());
function resolve(relative, depth) {
  const parts = String(relative).split('/');
  if (!parts.every(validName) || (depth && !depth.includes(parts.length))) throw Object.assign(Error(`Invalid dataset path: ${relative}`), { status: 400 });
  const absolute = path.resolve(ROOT, ...parts);
  if (!absolute.startsWith(ROOT + path.sep)) throw Object.assign(Error('Path escapes the dataset folder.'), { status: 400 });
  return { parts, absolute };
}
const directories = async folder => (await fsp.readdir(folder, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && validName(entry.name)).map(entry => entry.name);

/** Walks Shape/Group/Class/file. Files elsewhere, or in folders other than Clean/Defective, are counted as ignored. */
export async function scan() {
  await fsp.mkdir(ROOT, { recursive: true });
  const images = [], groups = new Set(), folders = {};
  let ignored = 0;
  const shapes = await directories(ROOT);
  for (const shape of shapes) for (const group of await directories(path.join(ROOT, shape))) {
    groups.add(group); (folders[shape] ||= []).push(group);
    for (const entry of await fsp.readdir(path.join(ROOT, shape, group), { withFileTypes: true })) {
      if (!validName(entry.name)) continue;
      const imageClass = entry.isDirectory() && canonicalClass(entry.name);
      if (!imageClass) { ignored++; continue; }
      for (const file of await fsp.readdir(path.join(ROOT, shape, group, entry.name), { withFileTypes: true })) {
        if (!file.isFile() || !validName(file.name)) continue;
        if (!IMAGE.test(file.name)) { ignored++; continue; }
        const stat = await fsp.stat(path.join(ROOT, shape, group, entry.name, file.name)).catch(() => null);
        if (stat) images.push({ path: [shape, group, entry.name, file.name].join('/'), shape, group, imageClass, size: stat.size, modified: stat.mtimeMs });
      }
    }
  }
  return { root: ROOT, shapes, groups: [...groups], folders, images, ignored };
}

async function body(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > MAX_BODY) throw Object.assign(Error('File is larger than 50 MB.'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
// Written to a hidden temporary file first, so a half-written image is never listed.
async function write(relative, data, unique) {
  let { parts, absolute } = resolve(relative, [4]);
  if (!canonicalClass(parts[2]) || !IMAGE.test(parts[3])) throw Object.assign(Error('Images go into Shape/Group/Clean|Defective/ as PNG, JPG or BMP.'), { status: 400 });
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  if (unique) {
    const extension = path.extname(parts[3]), stem = parts[3].slice(0, -extension.length);
    for (let n = 1; await fsp.access(absolute).then(() => true, () => false); n++) { parts[3] = `${stem}_${n}${extension}`; absolute = path.join(path.dirname(absolute), parts[3]); }
  }
  const temporary = path.join(path.dirname(absolute), `.${parts[3]}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(temporary, data);
  try { await replace(temporary, absolute); } finally { await fsp.rm(temporary, { force: true }); }
  return parts.join('/');
}
// On Windows, replacing a file fails while another process (antivirus, search indexer, a viewer) briefly
// holds it open. Retry for about two seconds, then fall back to copying over it.
async function replace(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { return await fsp.rename(source, target); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      if (attempt === 8) return fsp.copyFile(source, target);
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
// Removal moves files into .removed/<timestamp>/ inside the dataset folder, so nothing is lost by accident.
async function remove(paths) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let removed = 0;
  for (const relative of paths) {
    const { absolute } = resolve(relative, [4]), target = path.join(ROOT, REMOVED, stamp, ...relative.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (await fsp.rename(absolute, target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) removed++;
  }
  return removed;
}

// Shows a folder in the system file manager (Explorer, Finder or the desktop's default).
let opener = folder => spawn(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [folder], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
export function setOpener(open) { opener = open; }
// Opens the deepest existing folder of a dataset path ('' is the dataset folder itself).
async function open(relative) {
  let folder = relative ? resolve(relative, [1, 2, 3]).absolute : ROOT;
  while (folder !== ROOT && !(await fsp.stat(folder).catch(() => null))?.isDirectory()) folder = path.dirname(folder);
  opener(folder);
  return path.relative(ROOT, folder).split(path.sep).filter(Boolean).join('/');
}

const clients = new Set();
let pending;
function changed(file) {
  if (file && String(file).split(/[\\/]/).some(part => part.startsWith('.'))) return;
  clearTimeout(pending);
  pending = setTimeout(() => { for (const client of clients) client.write('event: change\ndata: {}\n\n'); }, 250);
}
// Recursive fs.watch where the platform has it; otherwise compare folder listings every 2 seconds.
export function watch() {
  try { const watcher = fs.watch(ROOT, { recursive: true }, (_, file) => changed(file)); return { mode: 'fs.watch', close: () => watcher.close() }; }
  catch {
    let last = '';
    const timer = setInterval(async () => { const signature = JSON.stringify((await scan()).images.map(image => [image.path, image.size, image.modified])); if (last && signature !== last) changed(); last = signature; }, 2000);
    return { mode: 'polling', close: () => clearInterval(timer) };
  }
}

const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
export function createServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'), route = url.pathname;
      const file = route.startsWith('/api/files/') ? route.slice('/api/files/'.length).split('/').map(decodeURIComponent).join('/') : null;
      if (request.method === 'GET' && route === '/api/dataset') return json(response, 200, await scan());
      if (request.method === 'GET' && route === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        response.write('retry: 2000\n\n'); clients.add(response); request.on('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'GET' && file) {
        const { absolute } = resolve(file, [4]), stat = await fsp.stat(absolute).catch(() => null);
        if (!stat?.isFile() || !IMAGE.test(absolute)) return json(response, 404, { error: `No such image: ${file}` });
        response.writeHead(200, { 'Content-Type': TYPES[path.extname(absolute).slice(1).toLowerCase()], 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'Last-Modified': stat.mtime.toUTCString() });
        return fs.createReadStream(absolute).pipe(response);
      }
      if (request.method === 'PUT' && file) return json(response, 201, { path: await write(file, await body(request), url.searchParams.get('unique') === '1') });
      if (request.method === 'POST' && route === '/api/folders') {
        const { absolute } = resolve(JSON.parse(await body(request)).path, [1, 2, 3]);
        await fsp.mkdir(absolute, { recursive: true });
        return json(response, 201, {});
      }
      // Small JSON notes about the folder (sample generator version, writing state), kept in a hidden file.
      if (request.method === 'GET' && route === '/api/meta') return json(response, 200, JSON.parse(await fsp.readFile(path.join(ROOT, META), 'utf8').catch(() => '{}')));
      if (request.method === 'PUT' && route === '/api/meta') { const value = JSON.parse(await body(request)); await fsp.writeFile(path.join(ROOT, META), JSON.stringify(value, null, 2)); return json(response, 200, value); }
      if (request.method === 'POST' && route === '/api/open') return json(response, 200, { path: await open(JSON.parse(await body(request)).path || '') });
      if (request.method === 'POST' && route === '/api/remove') return json(response, 200, { removed: await remove(JSON.parse(await body(request)).paths || []) });
      json(response, 404, { error: 'Not found.' });
    } catch (error) { json(response, error.status || 500, { error: error.message }); }
  });
}

export async function start() {
  await fsp.mkdir(ROOT, { recursive: true });
  const { mode } = watch();
  await new Promise(done => createServer().listen(PORT, '127.0.0.1', done));
  console.log(`Dataset folder ${ROOT} · http://127.0.0.1:${PORT}/api · watching with ${mode}`);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) start();
