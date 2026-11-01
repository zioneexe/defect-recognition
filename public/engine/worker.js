importScripts('brain.js', 'processing.js', 'gpu-network.js', 'localization.js');

// Browser allows ~6 parallel requests per host.
const PARALLEL_LOADS = 6;

let network = null;
let scaling = null;
let samples = [];
let loading = [];
let failure = null;
let prep = emptyPrep();

function emptyPrep() {
  return { load: 0, difference: 0, loaded: 0, started: performance.now() };
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// ---- Preparation ----

function startRunIfIdle() {
  if (!samples.length && !loading.length) prep = emptyPrep();
}

function toSample(pixels, data) {
  const start = performance.now();
  const sample = {
    input: differenceGrid(pixels).grid,
    output: [data.imageClass === 'Defective' ? 1 : 0],
    shape: data.shape,
    group: data.group,
  };
  prep.difference += performance.now() - start;
  return sample;
}

function addSample(sample) {
  samples.push(sample);
  self.postMessage({ type: 'prepared', count: samples.length });
}

async function fetchWithRetry(url, name) {
  // Dev server sometimes drops requests, so retry.
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      if (attempt === 3) throw Error(`Cannot load ${name}: ${error.message}.`);
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

// Images are loaded here so a background tab doesn't slow them down.
async function loadPixels(url) {
  const name = decodeURIComponent(url.split('?')[0].split('/').pop());
  const response = await fetchWithRetry(url, name);
  if (!response.ok) throw Error(`Cannot read ${name}.`);

  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, SIZE, SIZE);
  context.drawImage(bitmap, 0, 0, SIZE, SIZE);
  bitmap.close();

  return context.getImageData(0, 0, SIZE, SIZE).data;
}

// Simple semaphore: at most PARALLEL_LOADS loads at a time.
let activeLoads = 0;
const waiting = [];

function acquire() {
  if (activeLoads < PARALLEL_LOADS) {
    activeLoads++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else activeLoads--;
}

function queueLoad(data) {
  startRunIfIdle();

  const task = acquire()
    .then(async () => {
      const start = performance.now();
      const pixels = await loadPixels(data.url);
      prep.load += performance.now() - start;
      prep.loaded++;
      addSample(toSample(pixels, data));
    })
    .catch((error) => {
      failure ||= error;
    })
    .finally(release);

  loading.push(task);
}

async function finishPreparation() {
  await Promise.all(loading);

  if (failure) {
    const error = failure;
    failure = null;
    loading = [];
    samples = [];
    throw error;
  }

  const prepared = samples;
  const stats = {
    images: prepared.length,
    wall: performance.now() - prep.started,
    load: prep.loaded ? prep.load / prep.loaded : 0,
    difference: prep.difference / prepared.length,
    parallelLoads: prep.loaded ? PARALLEL_LOADS : 0,
  };

  samples = [];
  loading = [];
  return { prepared, stats };
}

// ---- Training ----

// Shuffle before the split, otherwise validation gets only some shapes.
function splitByClass(prepared) {
  const classes = [
    shuffle(prepared.filter((s) => !s.output[0])),
    shuffle(prepared.filter((s) => s.output[0])),
  ];
  if (classes.some((items) => items.length < 2)) {
    throw Error('Select at least two Clean and two Defective images for training and validation.');
  }

  const training = [];
  const validation = [];
  for (const items of classes) {
    const count = Math.max(1, Math.floor(items.length * 0.2));
    validation.push(...items.slice(0, count));
    training.push(...items.slice(count));
  }
  return { training, validation };
}

function createNetwork(training, learningRate) {
  const options = { hiddenLayers: [12], activation: 'sigmoid' };

  try {
    const webgl =
      typeof OffscreenCanvas !== 'undefined' && new OffscreenCanvas(1, 1).getContext('webgl2');
    if (!webgl) throw Error('GPU unavailable');

    const gpu = new IntensityNetworkGPU({ ...options, mode: 'gpu' });
    gpu.train(training, { iterations: 1, learningRate });
    return { network: gpu, mode: 'GPU' };
  } catch {
    return { network: new brain.NeuralNetwork(options), mode: 'CPU' };
  }
}

function accuracyBy(items, predict, key) {
  const values = [...new Set(items.map((s) => s[key]).filter(Boolean))].sort();

  return Object.fromEntries(
    values.map((value) => {
      const subset = items.filter((s) => s[key] === value);
      const correct = subset.filter((s) => predict(s) === Boolean(s.output[0])).length;
      return [value, { accuracy: correct / subset.length, count: subset.length }];
    }),
  );
}

function evaluate(validation) {
  const start = performance.now();
  const predictions = new Map(validation.map((s) => [s, network.run(s.input)[0] >= 0.5]));
  const predict = (s) => predictions.get(s);

  const confusion = { tp: 0, tn: 0, fp: 0, fn: 0 };
  for (const s of validation) {
    const defective = Boolean(s.output[0]);
    if (predict(s)) confusion[defective ? 'tp' : 'fp']++;
    else confusion[defective ? 'fn' : 'tn']++;
  }

  return {
    accuracy: (confusion.tp + confusion.tn) / validation.length,
    stats: {
      time: performance.now() - start,
      confusion,
      byGroup: accuracyBy(validation, predict, 'group'),
      byShape: accuracyBy(validation, predict, 'shape'),
    },
  };
}

async function train(data) {
  network = null;
  for (const image of data.images || []) {
    startRunIfIdle();
    addSample(toSample(image.pixels, image));
  }
  const { prepared, stats: preparation } = await finishPreparation();

  const start = performance.now();
  const { training, validation } = splitByClass(prepared);
  scaling = fitScaling(training.map((sample) => sample.input));
  for (const sample of [...training, ...validation]) {
    sample.input = features(sample.input, scaling);
  }
  const featureTime = performance.now() - start;

  shuffle(training);
  const created = createNetwork(training, data.learningRate);
  network = created.network;
  network.errorCheckInterval = 1;
  self.postMessage({ type: 'mode', mode: created.mode });

  const trainingStart = performance.now();
  const result = network.train(training, {
    iterations: data.epochs,
    learningRate: data.learningRate,
    errorThresh: 0.000001,
    callbackPeriod: 1,
    callback: ({ iterations, error }) =>
      self.postMessage({
        type: 'epoch',
        epoch: iterations,
        loss: error,
        elapsed: performance.now() - start,
      }),
  });
  const trainingTime = performance.now() - trainingStart;

  const { accuracy, stats: validationStats } = evaluate(validation);

  self.postMessage({
    type: 'trained',
    epoch: result.iterations,
    loss: result.error,
    accuracy,
    validationCount: validation.length,
    elapsed: performance.now() - start,
    stats: {
      mode: created.mode,
      preparation,
      features: featureTime,
      training: {
        time: trainingTime,
        epochs: result.iterations,
        images: training.length,
        inputs: training[0].input.length,
      },
      validation: validationStats,
    },
  });
}

// ---- Recognition ----

function predictGrid(grid) {
  return Number(network.run(features(grid, scaling))[0]);
}

async function recognize(data) {
  if (!network) throw Error('Train a model before recognition.');

  const start = performance.now();
  const pixels = data.url ? await loadPixels(data.url) : data.pixels;
  const loaded = performance.now();

  const { grid, reference, difference } = differenceGrid(pixels);
  const differenced = performance.now();
  self.postMessage({ type: 'recognitionProgress', progress: 50 });

  const score = predictGrid(grid);
  const defective = score >= 0.5;
  const classified = performance.now();
  self.postMessage({ type: 'recognitionProgress', progress: 75 });

  const defects = defective ? localize(grid, predictGrid, score, data.width, data.height) : [];
  const end = performance.now();

  let localizationStatus = 'not-needed';
  if (defective) localizationStatus = defects.length ? 'localized' : 'failed';

  const message = {
    type: 'recognized',
    grid,
    reference,
    difference,
    referenceMethod: REFERENCE,
    defects,
    score,
    confidence: Math.max(score, 1 - score),
    classification: defective ? 'Defective' : 'Clean',
    localizationStatus,
    elapsed: end - start,
    timings: {
      load: loaded - start,
      difference: differenced - loaded,
      network: classified - differenced,
      localization: end - classified,
      total: end - start,
    },
  };
  self.postMessage(message, [reference.buffer, difference.buffer]);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'sample' && data.url) {
      queueLoad(data);
    } else if (data.type === 'sample') {
      startRunIfIdle();
      addSample(toSample(data.pixels, data));
    } else if (data.type === 'train') {
      await train(data);
    } else if (data.type === 'recognize') {
      await recognize(data);
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
