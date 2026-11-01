import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dataset-'));
process.env.DATASET_DIR = root; process.env.DATASET_PORT = '0';
const { createServer, scan, watch, setOpener } = await import('../server/dataset.mjs');
const opened = [];
setOpener(folder => opened.push(folder));
let server, base, watcher;
before(async () => { watcher = watch(); server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { watcher.close(); server.closeAllConnections(); server.close(); await fs.rm(root, { recursive: true, force: true }); });
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const put = (file, unique = false) => fetch(`${base}/api/files/${file.split('/').map(encodeURIComponent).join('/')}${unique ? '?unique=1' : ''}`, { method: 'PUT', body: png });
const post = (route, value) => fetch(base + route, { method: 'POST', body: JSON.stringify(value) });

test('writes images into Shape/Group/Class and lists them with their labels', async () => {
  assert.equal((await put('Circle/HighQuality/Defective/a.png')).status, 201);
  assert.equal((await (await put('Circle/HighQuality/Defective/a.png', true)).json()).path, 'Circle/HighQuality/Defective/a_1.png');
  await fs.mkdir(path.join(root, 'Ellipse', 'Rough', 'clean'), { recursive: true });
  await fs.writeFile(path.join(root, 'Ellipse', 'Rough', 'clean', 'by-hand.png'), png);
  await fs.writeFile(path.join(root, 'Ellipse', 'Rough', 'notes.txt'), 'x');
  const listing = await (await fetch(`${base}/api/dataset`)).json();
  assert.deepEqual(listing.images.map(image => image.path).sort(), ['Circle/HighQuality/Defective/a.png', 'Circle/HighQuality/Defective/a_1.png', 'Ellipse/Rough/clean/by-hand.png']);
  assert.equal(listing.images.find(image => image.shape === 'Ellipse').imageClass, 'Clean');
  assert.deepEqual(listing.groups.sort(), ['HighQuality', 'Rough']); assert.equal(listing.ignored, 1);
  assert.deepEqual(listing.folders, { Circle: ['HighQuality'], Ellipse: ['Rough'] });
});
test('serves image bytes with their media type', async () => {
  const response = await fetch(`${base}/api/files/Circle/HighQuality/Defective/a.png`);
  assert.equal(response.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/api/files/Circle/HighQuality/Defective/missing.png`)).status, 404);
});
test('rejects paths outside the layout or the folder', async () => {
  for (const file of ['Circle/HighQuality/Other/a.png', 'Circle/HighQuality/Clean/a.txt', 'Circle/a.png', 'Circle/HighQuality/Clean/.hidden.png']) assert.equal((await put(file)).status, 400, file);
  assert.equal((await fetch(`${base}/api/files/..%2F..%2Fetc/x/Clean/a.png`, { method: 'PUT', body: png })).status, 400);
  assert.equal((await post('/api/folders', { path: '../outside' })).status, 400);
});
test('creates folders and moves removed files into .removed instead of deleting them', async () => {
  assert.equal((await post('/api/folders', { path: 'Star' })).status, 201);
  assert.ok((await scan()).shapes.includes('Star'));
  assert.equal((await (await post('/api/remove', { paths: ['Circle/HighQuality/Defective/a_1.png', 'Circle/HighQuality/Defective/gone.png'] })).json()).removed, 1);
  assert.ok(!(await scan()).images.some(image => image.path.endsWith('a_1.png')));
  const [stamp] = await fs.readdir(path.join(root, '.removed'));
  await fs.access(path.join(root, '.removed', stamp, 'Circle', 'HighQuality', 'Defective', 'a_1.png'));
});
test('announces files dropped into the folder by hand', async () => {
  const controller = new AbortController(), response = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  await reader.read();
  setTimeout(() => fs.writeFile(path.join(root, 'Circle', 'HighQuality', 'Defective', 'dropped.png'), png), 100);
  let text = '';
  const deadline = Date.now() + 5000;
  while (!text.includes('event: change') && Date.now() < deadline) text += decoder.decode((await reader.read()).value);
  controller.abort();
  assert.match(text, /event: change/);
});
test('opens the deepest existing folder of a dataset path in the file manager', async () => {
  assert.equal((await (await post('/api/open', { path: 'Circle/HighQuality' })).json()).path, 'Circle/HighQuality');
  assert.equal((await (await post('/api/open', { path: 'Circle/Icons/Clean' })).json()).path, 'Circle');
  assert.equal((await (await post('/api/open', {})).json()).path, '');
  assert.deepEqual(opened, [path.join(root, 'Circle', 'HighQuality'), path.join(root, 'Circle'), root]);
  assert.equal((await post('/api/open', { path: '../..' })).status, 400); assert.equal(opened.length, 3);
});
test('keeps folder notes in a hidden file that is never listed', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/meta`)).json(), {});
  await fetch(`${base}/api/meta`, { method: 'PUT', body: JSON.stringify({ sampleVersion: 2, samples: 'complete' }) });
  assert.deepEqual(await (await fetch(`${base}/api/meta`)).json(), { sampleVersion: 2, samples: 'complete' });
  assert.ok(!(await scan()).images.some(image => image.path.includes('meta')));
});
