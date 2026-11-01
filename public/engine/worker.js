importScripts('brain.js', 'processing.js', 'gpu-network.js', 'localization.js');
let network = null, scaling = null, samples = [];
const shuffle = items => { for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; } return items; };
// Timings of the current preparation, reported with the trained model: summed per-image times and wall time.
let prep = { load: 0, difference: 0, loaded: 0, started: 0 };
const toSample = (pixels, data) => {
  const start = performance.now(), sample = { input: differenceGrid(pixels).grid, output: [data.imageClass === 'Defective' ? 1 : 0], shape: data.shape, group: data.group };
  prep.difference += performance.now() - start;
  return sample;
};
// The first image of a run starts the preparation clock.
const begin = () => { if (!samples.length && !loading.length) prep = { load: 0, difference: 0, loaded: 0, started: performance.now() }; };
const add = sample => { samples.push(sample); self.postMessage({ type: 'prepared', count: samples.length }); };
// Loads an image by URL (dataset file, blob or data URL) and normalizes it like the page does: 200 × 200,
// transparent areas over white. Done here, a background tab cannot slow the preparation down.
async function pixels(url) {
  const name = decodeURIComponent(url.split('?')[0].split('/').pop());
  // A busy dev server can drop a request now and then; retry before failing the whole run.
  let response;
  for (let attempt = 1; !response; attempt++) {
    try { response = await fetch(url); }
    catch (error) { if (attempt === 3) throw Error(`Cannot load ${name}: ${error.message}.`); await new Promise(resolve => setTimeout(resolve, 300 * attempt)); }
  }
  if (!response.ok) throw Error(`Cannot read ${name}.`);
  const bitmap = await createImageBitmap(await response.blob()), canvas = new OffscreenCanvas(SIZE, SIZE), c = canvas.getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#fff'; c.fillRect(0, 0, SIZE, SIZE); c.drawImage(bitmap, 0, 0, SIZE, SIZE); bitmap.close();
  return c.getImageData(0, 0, SIZE, SIZE).data;
}
// Up to six images load at once (the browser's limit of parallel requests to one host); training waits for all.
const PARALLEL_LOADS = 6;
let loading = [], active = 0, failure = null;
const slots = [];
const slot = () => active < PARALLEL_LOADS ? (active++, Promise.resolve()) : new Promise(resolve => slots.push(resolve));
const free = () => { const next = slots.shift(); if (next) next(); else active--; };
function load(data) {
  begin();
  loading.push(slot().then(async () => {
    const start = performance.now(), image = await pixels(data.url);
    prep.load += performance.now() - start; prep.loaded++;
    add(toSample(image, data));
  }).catch(error => { failure ||= error; }).finally(free));
}
// Share of correct predictions per value of `key` (group or shape).
const breakdown = (items, predict, key) => Object.fromEntries([...new Set(items.map(s => s[key]).filter(Boolean))].sort().map(value => {
  const subset = items.filter(s => s[key] === value);
  return [value, { accuracy: subset.filter(s => predict(s) === Boolean(s.output[0])).length / subset.length, count: subset.length }];
}));
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'sample') {
      if (data.url) return load(data);
      begin(); add(toSample(data.pixels, data));
    } else if (data.type === 'train') {
      network = null;
      for (const image of data.images || []) { begin(); add(toSample(image.pixels, image)); }
      await Promise.all(loading);
      if (failure) { const error = failure; failure = null; loading = []; samples = []; throw error; }
      const prepared = samples, preparation = { images: prepared.length, wall: performance.now() - prep.started, load: prep.loaded ? prep.load / prep.loaded : 0, difference: prep.difference / prepared.length, parallelLoads: prep.loaded ? PARALLEL_LOADS : 0 };
      samples = []; loading = [];
      const start = performance.now();
      // Stratify so both classes occur in training and held-out validation.
      // Shuffle first: tree order groups images by shape and quality, which would bias the held-out set.
      const classes = [shuffle(prepared.filter(s => !s.output[0])), shuffle(prepared.filter(s => s.output[0]))];
      if (classes.some(items => items.length < 2)) throw Error('Select at least two Clean and two Defective images for training and validation.');
      const validation = [], training = [];
      for (const items of classes) {
        const count = Math.max(1, Math.floor(items.length * .2));
        validation.push(...items.slice(0, count)); training.push(...items.slice(count));
      }
      scaling = fitScaling(training.map(sample => sample.input));
      for (const sample of [...training, ...validation]) sample.input = features(sample.input, scaling);
      const featureTime = performance.now() - start;
      // Interleave classes; grouped tree order must not bias the last updates.
      shuffle(training);
      let mode = 'CPU';
      const options = { hiddenLayers: [12], activation: 'sigmoid' };
      try {
        if (typeof OffscreenCanvas === 'undefined' || !new OffscreenCanvas(1,1).getContext('webgl2')) throw Error('GPU unavailable');
        network = new IntensityNetworkGPU({ ...options, mode: 'gpu' });
        network.train(training, { iterations: 1, learningRate: data.learningRate });
        mode = 'GPU';
      } catch { network = new brain.NeuralNetwork(options); }
      network.errorCheckInterval = 1;
      self.postMessage({ type: 'mode', mode });
      const trainingStart = performance.now();
      const result = network.train(training, {
        iterations: data.epochs, learningRate: data.learningRate, errorThresh: 0.000001,
        callbackPeriod: 1,
        callback: ({ iterations, error }) => self.postMessage({ type: 'epoch', epoch: iterations, loss: error, elapsed: performance.now() - start })
      });
      const trainingTime = performance.now() - trainingStart, validationStart = performance.now();
      const predicted = new Map(validation.map(s => [s, network.run(s.input)[0] >= .5])), predict = s => predicted.get(s);
      const confusion = { tp: 0, tn: 0, fp: 0, fn: 0 };
      for (const s of validation) { const defective = Boolean(s.output[0]); confusion[predict(s) ? (defective ? 'tp' : 'fp') : (defective ? 'fn' : 'tn')]++; }
      const accuracy = (confusion.tp + confusion.tn) / validation.length;
      self.postMessage({ type: 'trained', epoch: result.iterations, loss: result.error, accuracy, validationCount: validation.length, elapsed: performance.now() - start,
        stats: { mode, preparation, features: featureTime, training: { time: trainingTime, epochs: result.iterations, images: training.length, inputs: training[0].input.length },
          validation: { time: performance.now() - validationStart, confusion, byGroup: breakdown(validation, predict, 'group'), byShape: breakdown(validation, predict, 'shape') } } });
    } else if (data.type === 'recognize') {
      if (!network) throw Error('Train a model before recognition.');
      const start = performance.now();
      const image = data.url ? await pixels(data.url) : data.pixels, loaded = performance.now();
      const { grid, reference, difference } = differenceGrid(image), differenced = performance.now();
      self.postMessage({ type: 'recognitionProgress', progress: 50 });
      const score = Number(network.run(features(grid, scaling))[0]), classified = performance.now();
      self.postMessage({ type: 'recognitionProgress', progress: 75 });
      const defects = score >= .5 ? localize(grid, values => Number(network.run(features(values, scaling))[0]), score, data.width, data.height) : [];
      const localizationStatus = score < .5 ? 'not-needed' : defects.length ? 'localized' : 'failed', end = performance.now();
      self.postMessage({ type: 'recognized', grid, reference, difference, referenceMethod: REFERENCE, defects, score, confidence: Math.max(score, 1 - score), classification: score >= .5 ? 'Defective' : 'Clean', localizationStatus, elapsed: end - start,
        timings: { load: loaded - start, difference: differenced - loaded, network: classified - differenced, localization: end - classified, total: end - start } }, [reference.buffer, difference.buffer]);
    }
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
