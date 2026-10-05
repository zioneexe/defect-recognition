importScripts('brain.js', 'processing.js', 'gpu-network.js', 'localization.js');
let network = null, scaling = null, cleanPatterns = [];
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'train') {
      const start = performance.now();
      network = null;
      const samples = data.images.map((image, i) => {
        const { grid } = intensityGrid(image.pixels);
        self.postMessage({ type: 'prepared', count: i + 1 });
        return { input: grid, output: [image.imageClass === 'Defective' ? 1 : 0] };
      });
      // Stratify so both classes occur in training and held-out validation.
      const classes = [samples.filter(s => !s.output[0]), samples.filter(s => s.output[0])];
      if (classes.some(items => items.length < 2)) throw Error('Select at least two Clean and two Defective images for training and validation.');
      const validation = [], training = [];
      for (const items of classes) {
        const count = Math.max(1, Math.floor(items.length * .2));
        validation.push(...items.slice(0, count)); training.push(...items.slice(count));
      }
      scaling = fitScaling(training.map(sample => sample.input));
      cleanPatterns = training.filter(sample => !sample.output[0]).map(sample => [...sample.input]);
      for (const sample of [...training, ...validation]) sample.input = features(sample.input, scaling);
      // Interleave classes; grouped tree order must not bias the last updates.
      for (let i = training.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [training[i], training[j]] = [training[j], training[i]]; }
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
      const result = network.train(training, {
        iterations: data.epochs, learningRate: data.learningRate, errorThresh: 0.000001,
        callbackPeriod: 1,
        callback: ({ iterations, error }) => self.postMessage({ type: 'epoch', epoch: iterations, loss: error, elapsed: performance.now() - start })
      });
      const accuracy = validation.filter(s => (network.run(s.input)[0] >= .5) === Boolean(s.output[0])).length / validation.length;
      self.postMessage({ type: 'trained', epoch: result.iterations, loss: result.error, accuracy, validationCount: validation.length, elapsed: performance.now() - start });
    } else if (data.type === 'recognize') {
      if (!network) throw Error('Train a model before recognition.');
      const start = performance.now();
      const { grid } = intensityGrid(data.pixels);
      self.postMessage({ type: 'recognitionProgress', progress: 50 });
      const score = Number(network.run(features(grid, scaling))[0]);
      self.postMessage({ type: 'recognitionProgress', progress: 75 });
      const defects = score >= .5 ? localize(grid, cleanPatterns, values => Number(network.run(features(values, scaling))[0]), score, data.width, data.height) : [];
      const localizationStatus = score < .5 ? 'not-needed' : defects.length ? 'localized' : 'failed';
      self.postMessage({ type: 'recognized', grid, defects, score, confidence: Math.max(score, 1 - score), classification: score >= .5 ? 'Defective' : 'Clean', localizationStatus, elapsed: performance.now() - start });
    }
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
