// Second method from the ANN_defects article: grid of mean values of (image - reference).
const SIZE = 200;
const GRID = 20;
const CELL = SIZE / GRID;
const RADIUS = 10;
const THRESHOLD = 0.1;
const ELEMENT = RADIUS * 2 + 1;
const REFERENCE = `Opening and closing by reconstruction of the input, ${ELEMENT} × ${ELEMENT} px square element`;

function grayscale(image) {
  if (!image || image.length !== SIZE * SIZE * 4) {
    throw Error('Expected one normalized 200 × 200 RGBA image.');
  }

  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (image[i * 4] + image[i * 4 + 1] + image[i * 4 + 2]) / 765;
  }
  return gray;
}

// Min/max filter (van Herk / Gil-Werman), O(1) per pixel for any window size.
const prefix = new Float32Array(SIZE * 3);
const suffix = new Float32Array(SIZE * 3);

function filterLine(source, target, start, step, radius, erode) {
  const width = radius * 2 + 1;
  const length = SIZE + radius * 2;
  const pad = erode ? Infinity : -Infinity;
  const pick = erode ? Math.min : Math.max;

  const value = (j) => {
    const i = j - radius;
    return i >= 0 && i < SIZE ? source[start + i * step] : pad;
  };

  for (let j = 0; j < length; j++) {
    const blockStart = j % width === 0;
    prefix[j] = blockStart ? value(j) : pick(prefix[j - 1], value(j));
  }

  for (let j = length - 1; j >= 0; j--) {
    const blockEnd = j % width === width - 1 || j === length - 1;
    suffix[j] = blockEnd ? value(j) : pick(suffix[j + 1], value(j));
  }

  for (let i = 0; i < SIZE; i++) {
    target[start + i * step] = pick(suffix[i], prefix[i + width - 1]);
  }
}

function morph(source, radius, erode) {
  const rows = new Float32Array(source.length);
  const result = new Float32Array(source.length);

  for (let y = 0; y < SIZE; y++) {
    filterLine(source, rows, y * SIZE, 1, radius, erode);
  }
  for (let x = 0; x < SIZE; x++) {
    filterLine(rows, result, x, SIZE, radius, erode);
  }
  return result;
}

// Morphological reconstruction (Vincent's hybrid algorithm).
// Works on a copy with a 1 px border, so neighbours never need bounds checks.
const W = SIZE + 2;
const BEFORE = [-W - 1, -W, -W + 1, -1];
const AFTER = [W + 1, W, W - 1, 1];
const AROUND = [...BEFORE, ...AFTER];

function createQueue() {
  let items = new Int32Array(W * W * 2);
  let head = 0;
  let tail = 0;

  return {
    get empty() {
      return head === tail;
    },
    take() {
      return items[head++];
    },
    push(value) {
      if (tail === items.length) {
        if (head > items.length / 2) {
          items.copyWithin(0, head, tail);
          tail -= head;
          head = 0;
        } else {
          const larger = new Int32Array(items.length * 2);
          larger.set(items);
          items = larger;
        }
      }
      items[tail++] = value;
    },
  };
}

function maxOfNeighbours(out, p, offsets) {
  let value = out[p];
  for (let k = 0; k < offsets.length; k++) {
    if (out[p + offsets[k]] > value) value = out[p + offsets[k]];
  }
  return value;
}

// True if pixel p can still raise one of the pixels after it.
function canSpread(out, limit, p) {
  for (let k = 0; k < AFTER.length; k++) {
    const q = p + AFTER[k];
    if (out[q] < out[p] && out[q] < limit[q]) return true;
  }
  return false;
}

function reconstruct(marker, mask) {
  const out = new Float32Array(W * W).fill(-1);
  const limit = new Float32Array(W * W).fill(-1);
  const queue = createQueue();

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const p = (y + 1) * W + x + 1;
      limit[p] = mask[i];
      out[p] = Math.min(marker[i], mask[i]);
    }
  }

  // Forward raster scan.
  for (let y = 1; y <= SIZE; y++) {
    for (let p = y * W + 1; p <= y * W + SIZE; p++) {
      out[p] = Math.min(maxOfNeighbours(out, p, BEFORE), limit[p]);
    }
  }

  // Backward scan; pixels that can still spread go to the queue.
  for (let y = SIZE; y >= 1; y--) {
    for (let p = y * W + SIZE; p > y * W; p--) {
      out[p] = Math.min(maxOfNeighbours(out, p, AFTER), limit[p]);
      if (canSpread(out, limit, p)) queue.push(p);
    }
  }

  while (!queue.empty) {
    const p = queue.take();
    for (let k = 0; k < AROUND.length; k++) {
      const q = p + AROUND[k];
      if (out[q] < out[p] && limit[q] !== out[q]) {
        out[q] = Math.min(out[p], limit[q]);
        queue.push(q);
      }
    }
  }

  const result = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      result[y * SIZE + x] = out[(y + 1) * W + x + 1];
    }
  }
  return result;
}

const openByReconstruction = (gray, radius) => reconstruct(morph(gray, radius, true), gray);
const invert = (values) => values.map((value) => 1 - value);

// Opening removes small bright spots, closing removes small dark ones.
function reference(gray, radius = RADIUS) {
  const opened = openByReconstruction(gray, radius);
  return invert(openByReconstruction(invert(opened), radius));
}

const cellOf = (i) =>
  Math.floor(Math.floor(i / SIZE) / CELL) * GRID + Math.floor((i % SIZE) / CELL);

function differenceGrid(image) {
  const gray = grayscale(image);
  const ref = reference(gray);
  const difference = new Float32Array(gray.length);
  const grid = Array(GRID * GRID).fill(0);

  for (let i = 0; i < gray.length; i++) {
    const d = gray[i] - ref[i];
    // Soft threshold cuts off noise and texture.
    difference[i] = Math.sign(d) * Math.max(0, Math.abs(d) - THRESHOLD);
    grid[cellOf(i)] += difference[i] / (CELL * CELL);
  }

  return { gray, reference: ref, difference, grid };
}

// One scale for all cells, fitted on training data only.
function fitScaling(grids) {
  const magnitudes = grids
    .flatMap((grid) => grid.map(Math.abs).filter(Boolean))
    .sort((a, b) => a - b);
  const percentile99 = magnitudes[Math.floor(magnitudes.length * 0.99)] || 0;
  return { scale: Math.max(0.02, percentile99) };
}

function neighbourMean(magnitude, index) {
  const row = Math.floor(index / GRID);
  const col = index % GRID;
  let sum = 0;
  let count = 0;

  for (let r = Math.max(0, row - 1); r <= Math.min(GRID - 1, row + 1); r++) {
    for (let c = Math.max(0, col - 1); c <= Math.min(GRID - 1, col + 1); c++) {
      if (r === row && c === col) continue;
      sum += magnitude[r * GRID + c];
      count++;
    }
  }
  return sum / count;
}

// 400 cell features (how much a cell stands out from its neighbours) + total, max and count.
function features(grid, scaling) {
  const scale = scaling ? scaling.scale : 1;
  const magnitude = grid.map(Math.abs);

  const cells = magnitude.map((value, i) => {
    const standsOut = Math.max(0, value - neighbourMean(magnitude, i));
    return Math.sqrt(standsOut / scale);
  });

  const total = magnitude.reduce((sum, value) => sum + value, 0);
  const strongest = Math.max(...magnitude);
  const nonZero = magnitude.filter((value) => value > 0).length;

  return [
    ...cells,
    Math.sqrt(total / scale / 4),
    Math.sqrt(strongest / scale),
    Math.min(1, nonZero / 20),
  ];
}

if (typeof module !== 'undefined') {
  module.exports = {
    grayscale,
    reference,
    differenceGrid,
    features,
    fitScaling,
    SIZE,
    GRID,
    CELL,
    RADIUS,
    THRESHOLD,
    REFERENCE,
  };
}
