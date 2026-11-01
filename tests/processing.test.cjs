const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { differenceGrid, features, fitScaling, SIZE, GRID, CELL } = require('../public/engine/processing.js');
const blank = (value = 0) => { const data = new Uint8ClampedArray(SIZE * SIZE * 4); for (let i = 0; i < data.length; i += 4) { data[i] = data[i+1] = data[i+2] = value; data[i+3] = 255; } return data; };
function paint(data, inside, value) { for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (inside(x, y)) { const p = (y * SIZE + x) * 4; data[p] = data[p+1] = data[p+2] = value; } return data; }
const disc = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 < r * r;
// A grey rotated triangle on a darker background: sharp corners a plain opening would cut off.
const triangle = (x, y) => { const s = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]); const a = [40, 170], b = [160, 150], c = [90, 30], d = [s(a, b), s(b, c), s(c, a)]; return d.every(v => v >= 0) || d.every(v => v <= 0); };
const shape = () => paint(blank(50), triangle, 140);
const withHole = (cx = 95, cy = 120, r = 6) => paint(shape(), disc(cx, cy, r), 255);
const cellOf = (x, y) => Math.floor(y / CELL) * GRID + Math.floor(x / CELL);
function worker() { const messages = []; const context = vm.createContext({ console, performance, Float32Array, Int32Array, Uint8Array, Uint8ClampedArray, Infinity, self: { postMessage: message => messages.push(message) } }); context.importScripts = (...names) => names.forEach(name => vm.runInContext(fs.readFileSync('public/engine/'+name, 'utf8'), context)); vm.runInContext(fs.readFileSync('public/engine/worker.js', 'utf8'), context); return { messages, send: async data => { await context.self.onmessage({data}); } }; }

test('rejects missing or incorrectly normalized input', () => { assert.throws(() => differenceGrid()); assert.throws(() => differenceGrid(new Uint8ClampedArray(16))); });
test('reference restores a defect-free shape, sharp corners included', () => {
  const { grid, difference } = differenceGrid(shape());
  assert.equal(grid.length, GRID * GRID);
  assert.ok(difference.every(value => value === 0), 'clean shape leaves no difference');
});
test('reference survives heavy per-pixel noise, which re-queues pixels many times', () => {
  for (let k = 0; k < 5; k++) { const noisy = blank(); for (let i = 0; i < noisy.length; i += 4) noisy[i] = noisy[i+1] = noisy[i+2] = Math.random() * 255; assert.equal(differenceGrid(noisy).grid.length, GRID * GRID); }
});
test('a white inclusion becomes positive difference in exactly its cells', () => {
  const { gray, reference: ref, grid } = differenceGrid(withHole());
  const centre = 120 * SIZE + 95;
  assert.ok(gray[centre] > .99 && Math.abs(ref[centre] - 140 / 255) < 1e-6, 'reference fills the hole with the shape level');
  const marked = grid.map((value, i) => [i, value]).filter(([, value]) => value !== 0).map(([i]) => i).sort((a, b) => a - b);
  assert.deepEqual(marked, [cellOf(90, 115), cellOf(100, 115), cellOf(90, 125), cellOf(100, 125)].sort((a, b) => a - b));
  assert.ok(marked.every(i => grid[i] > 0));
});
test('a dark inclusion becomes negative difference', () => {
  const { grid } = differenceGrid(paint(shape(), disc(80, 140, 5), 10));
  assert.ok(grid[cellOf(80, 140)] < 0); assert.ok(grid.every(value => value <= 0));
});
test('a cell feature measures how far the cell stands out from its 8 neighbours', () => {
  const lone = Array(GRID * GRID).fill(0), flat = Array(GRID * GRID).fill(.05); lone[cellOf(95, 125)] = .05;
  assert.ok(features(lone)[cellOf(95, 125)] > .1); assert.ok(features(flat)[cellOf(95, 125)] < 1e-6);
  assert.ok(features(flat)[GRID * GRID] > features(lone)[GRID * GRID], 'a broad residual still shows in the total');
});
test('grid-wide features grow with the total difference and its strongest cell', () => {
  const small = features(differenceGrid(withHole(95, 120, 4)).grid), large = features(differenceGrid(withHole(95, 120, 9)).grid);
  assert.ok(large[GRID * GRID] > small[GRID * GRID] && large[GRID * GRID + 1] >= small[GRID * GRID + 1] && small[GRID * GRID + 2] > 0);
});
test('network features weigh dark and bright defects of equal contrast alike', () => {
  const bright = differenceGrid(paint(shape(), disc(95, 120, 6), 230)).grid, dark = differenceGrid(paint(shape(), disc(95, 120, 6), 50)).grid;
  assert.ok(bright[cellOf(95, 120)] > 0 && dark[cellOf(95, 120)] < 0);
  features(bright).forEach((value, i) => assert.ok(Math.abs(value - features(dark)[i]) < 1e-6));
});
test('weak residuals below the soft threshold are ignored', () => {
  const { grid } = differenceGrid(paint(shape(), disc(95, 120, 6), 160));
  assert.ok(grid.every(value => value === 0));
});
test('a clean grid gives all-zero features: 400 cells plus 3 grid-wide ones', () => {
  const scaling = fitScaling([differenceGrid(withHole()).grid, differenceGrid(withHole(60, 150)).grid]);
  assert.ok(scaling.scale > .02);
  const input = features(Array(GRID * GRID).fill(0), scaling);
  assert.equal(input.length, GRID * GRID + 3); assert.ok(input.every(value => value === 0));
});
test('worker rejects inference without a model and single-class training', async () => { const w = worker(); await w.send({type:'recognize',pixels:blank()}); assert.equal(w.messages.at(-1).type,'error'); await w.send({type:'train',images:Array.from({length:4},()=>({pixels:shape(),imageClass:'Clean'})),epochs:100,learningRate:.05}); assert.match(w.messages.at(-1).message,/two Clean and two Defective/); });
test('Brain.js CPU worker trains on streamed images and classifies and localizes unseen inputs', async () => {
  // Holes on a lattice over the triangle, so every interior cell is seen with a defect during training.
  const w = worker(), spots = [];
  for (let y = 70; y <= 155; y += 10) for (let x = 60; x <= 140; x += 10) if (triangle(x - 8, y) && triangle(x + 8, y) && triangle(x, y - 8) && triangle(x, y + 8)) spots.push([x, y]);
  // Two hole sizes per position, so a held-out defect's cells are still covered by training.
  for (let i = 0; i < spots.length * 4; i++) await w.send({ type: 'sample', pixels: i % 2 ? withHole(...spots[i >> 2], i % 4 === 1 ? 5 : 7) : shape(), imageClass: i % 2 ? 'Defective' : 'Clean' });
  await w.send({ type: 'train', epochs: 150, learningRate: .1 });
  const trained = w.messages.find(m => m.type === 'trained'); assert.ok(trained, JSON.stringify(w.messages.at(-1)));
  assert.ok(trained.accuracy >= .9, String(trained.accuracy)); assert.equal(trained.validationCount, Math.floor(spots.length * 2 * .2) * 2);
  assert.equal(w.messages.filter(m => m.type === 'prepared').length, spots.length * 4); assert.equal(w.messages.filter(m => m.type === 'epoch').length, 150);
  await w.send({ type: 'recognize', pixels: withHole(105, 125, 7), width: 400, height: 400 });
  let result = w.messages.at(-1);
  assert.equal(result.classification, 'Defective'); assert.equal(result.localizationStatus, 'localized'); assert.equal(result.defects.length, 1);
  assert.ok(result.defects[0].cells.includes(cellOf(105, 125))); assert.equal(result.grid.length, GRID * GRID);
  assert.equal(result.reference.length, SIZE * SIZE); assert.match(result.referenceMethod, /reconstruction/);
  const { bounds } = result.defects[0]; assert.ok(bounds.x <= 210 && bounds.x + bounds.width >= 210 && bounds.y <= 250 && bounds.y + bounds.height >= 250, JSON.stringify(bounds));
  await w.send({ type: 'recognize', pixels: shape(), width: 400, height: 400 });
  result = w.messages.at(-1); assert.equal(result.classification, 'Clean'); assert.equal(result.localizationStatus, 'not-needed'); assert.equal(result.defects.length, 0);
});
test('stratified holdout supports the minimum two images per class', async () => { const w = worker(); await w.send({type:'train',images:[{pixels:shape(),imageClass:'Clean'},{pixels:shape(),imageClass:'Clean'},{pixels:withHole(),imageClass:'Defective'},{pixels:withHole(),imageClass:'Defective'}],epochs:2,learningRate:.05}); assert.equal(w.messages.at(-1).type,'trained'); assert.equal(w.messages.at(-1).validationCount,2); });

test('GPU adapter retains late-grid cells with a smaller hidden layer', () => {
  const context = vm.createContext({console,performance,Float32Array,Uint8Array,Uint8ClampedArray});
  vm.runInContext(fs.readFileSync('public/engine/brain.js','utf8'),context);
  vm.runInContext(fs.readFileSync('public/engine/gpu-network.js','utf8'),context);
  const output = vm.runInContext(`(() => {
    const network = new IntensityNetworkGPU({mode:'cpu',hiddenLayers:[12]});
    const clean = Array(400).fill(0), defective = Array(400).fill(0); defective[395] = 1;
    network.train([{input:clean,output:[0]},{input:defective,output:[1]}],{iterations:400,learningRate:.3});
    return {width:network.texturizeInputData.output[0],clean:network.run(clean)[0],defective:network.run(defective)[0]};
  })()`,context);
  assert.equal(output.width,400);
  assert.ok(output.clean<.5,JSON.stringify(output));
  assert.ok(output.defective>.5,JSON.stringify(output));
});
