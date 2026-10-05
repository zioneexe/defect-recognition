const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { intensityGrid, regions, features, SIZE } = require('../public/engine/processing.js');
const blank = (value = 0) => { const data = new Uint8ClampedArray(SIZE * SIZE * 4); for (let i = 0; i < data.length; i += 4) { data[i] = data[i+1] = data[i+2] = value; data[i+3] = 255; } return data; };
function paint(data, x, y, width = 8, height = 8, value = 255) { for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) { const p = ((y+dy)*SIZE+x+dx)*4; data[p] = data[p+1] = data[p+2] = value; } return data; }
const inclusion = (x = 82, y = 82) => paint(blank(), x, y);
function worker() { const messages = []; const context = vm.createContext({ console, performance, Float32Array, Uint8Array, Uint8ClampedArray, self: { postMessage: message => messages.push(message) } }); context.importScripts = (...names) => names.forEach(name => vm.runInContext(fs.readFileSync('public/engine/'+name, 'utf8'), context)); vm.runInContext(fs.readFileSync('public/engine/worker.js', 'utf8'), context); return { messages, send: data => context.self.onmessage({data}) }; }

test('one input produces 100 averages of its absolute pixel intensities', () => { const {pixels, grid} = intensityGrid(blank(128)); assert.equal(grid.length, 100); grid.forEach(value => assert.ok(Math.abs(value - 128/255) < 1e-6)); assert.ok(Math.abs(pixels[0]-128/255)<1e-6); assert.deepEqual(regions(pixels, grid), []); });
test('black and white inputs stay distinct without clipping features', () => { assert.equal(features(intensityGrid(blank()).grid)[0], 0); assert.ok(Math.abs(features(intensityGrid(blank(255)).grid)[0]-1)<1e-6); });
test('rejects missing or incorrectly normalized input', () => { assert.throws(() => intensityGrid()); assert.throws(() => intensityGrid(new Uint8ClampedArray(16))); });
test('white inclusion maps to its actual cell average and coordinates', () => { const {pixels, grid} = intensityGrid(inclusion()); assert.ok(Math.abs(grid[44]-.16)<1e-6); const r = regions(pixels, grid); assert.equal(r.length,1); assert.equal(r[0].area,64); assert.equal(r[0].row,5); assert.equal(r[0].col,5); assert.equal(r[0].x,86); assert.deepEqual(r[0].cells,[44]); });
test('region spanning grid boundaries highlights every occupied cell', () => { const {pixels,grid} = intensityGrid(inclusion(96,96)); assert.deepEqual(regions(pixels,grid)[0].cells.sort(),[44,45,54,55]); });
test('white background and large white shape are not inclusions', () => { const whiteBackground = paint(blank(255),50,50,100,100,0); paint(whiteBackground,82,82); const p = intensityGrid(whiteBackground); assert.equal(regions(p.pixels,p.grid).length,1); const solid = intensityGrid(paint(blank(),50,50,100,100)); assert.equal(regions(solid.pixels,solid.grid).length,0); });
test('multiple enclosed inclusions stay distinct; border-connected bright areas are excluded', () => { const image = inclusion(30,30); paint(image,150,150); paint(image,0,0); const p = intensityGrid(image); assert.equal(regions(p.pixels,p.grid).length,2); });
test('worker rejects inference without a model and single-class training', () => { const w = worker(); w.send({type:'recognize',pixels:blank()}); assert.equal(w.messages.at(-1).type,'error'); w.send({type:'train',images:Array.from({length:4},()=>({pixels:blank(),imageClass:'Clean'})),epochs:100,learningRate:.05}); assert.match(w.messages.at(-1).message,/two Clean and two Defective/); });
test('Brain.js CPU worker trains on individual images and classifies unseen clean/defective inputs', () => { const w = worker(); const images = Array.from({length:40},(_,i)=>({pixels:i%2?inclusion(81+i%3,82):blank(),imageClass:i%2?'Defective':'Clean'})); w.send({type:'train',images,epochs:150,learningRate:.05}); const trained = w.messages.find(m=>m.type==='trained'); assert.ok(trained,JSON.stringify(w.messages)); assert.equal(trained.accuracy,1); assert.equal(trained.validationCount,8); assert.equal(w.messages.filter(m=>m.type==='prepared').length,40); assert.equal(w.messages.filter(m=>m.type==='epoch').length,150); w.send({type:'recognize',pixels:inclusion(83,83)}); let result = w.messages.at(-1); assert.equal(result.classification,'Defect detected'); assert.equal(result.defects.length,1); assert.equal(result.grid.length,100); assert.ok(result.confidence>.5 && result.confidence<=1); w.send({type:'recognize',pixels:blank()}); result = w.messages.at(-1); assert.equal(result.classification,'No defect detected'); assert.equal(result.defects.length,0); });
test('stratified holdout supports the minimum two images per class', () => { const w = worker(); w.send({type:'train',images:[{pixels:blank(),imageClass:'Clean'},{pixels:blank(),imageClass:'Clean'},{pixels:inclusion(),imageClass:'Defective'},{pixels:inclusion(),imageClass:'Defective'}],epochs:2,learningRate:.05}); assert.equal(w.messages.at(-1).type,'trained'); assert.equal(w.messages.at(-1).validationCount,2); });


test('GPU adapter retains late-grid cells with a smaller hidden layer', () => {
  const context = vm.createContext({console,performance,Float32Array,Uint8Array,Uint8ClampedArray});
  vm.runInContext(fs.readFileSync('public/engine/brain.js','utf8'),context);
  vm.runInContext(fs.readFileSync('public/engine/gpu-network.js','utf8'),context);
  const output = vm.runInContext(`(() => {
    const network = new IntensityNetworkGPU({mode:'cpu',hiddenLayers:[12]});
    const clean = Array(100).fill(0), defective = Array(100).fill(0); defective[95] = 1;
    network.train([{input:clean,output:[0]},{input:defective,output:[1]}],{iterations:400,learningRate:.3});
    return {width:network.texturizeInputData.output[0],clean:network.run(clean)[0],defective:network.run(defective)[0]};
  })()`,context);
  assert.equal(output.width,100);
  assert.ok(output.clean<.5,JSON.stringify(output));
  assert.ok(output.defective>.5,JSON.stringify(output));
});
