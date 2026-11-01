/* Second method of the ANN_defects article: the network reads mean values of grid
 * cells laid over a difference image (test − reference). The reference, a
 * defect-free estimate, is derived from the input itself by opening and closing
 * by reconstruction: bright and dark structures that a square element cannot fit
 * into (holes, scratches, specks) are removed, while the shape is restored whole,
 * including sharp corners that a plain opening would cut off.
 */
const SIZE = 200, GRID = 20, CELL = SIZE / GRID, RADIUS = 10, THRESHOLD = .1;
const REFERENCE = `Opening and closing by reconstruction of the input, ${RADIUS * 2 + 1} × ${RADIUS * 2 + 1} px square element`;
function grayscale(image) {
  if (!image || image.length !== SIZE * SIZE * 4) throw Error('Expected one normalized 200 × 200 RGBA image.');
  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < gray.length; i++) gray[i] = (image[i * 4] + image[i * 4 + 1] + image[i * 4 + 2]) / 765;
  return gray;
}
// Running minimum (erosion) or maximum (dilation) over a square window, rows then columns.
// Van Herk / Gil-Werman: block prefix and suffix extremes give each window in O(1), whatever the radius.
const prefix = new Float32Array(SIZE * 3), suffix = new Float32Array(SIZE * 3);
function line(source, target, start, step, radius, erode) {
  const width = radius * 2 + 1, length = SIZE + radius * 2, pad = erode ? Infinity : -Infinity;
  for (let j = 0; j < length; j++) {
    const i = j - radius, v = i >= 0 && i < SIZE ? source[start + i * step] : pad;
    prefix[j] = j % width === 0 ? v : erode ? (v < prefix[j - 1] ? v : prefix[j - 1]) : (v > prefix[j - 1] ? v : prefix[j - 1]);
  }
  for (let j = length - 1; j >= 0; j--) {
    const i = j - radius, v = i >= 0 && i < SIZE ? source[start + i * step] : pad;
    suffix[j] = j % width === width - 1 || j === length - 1 ? v : erode ? (v < suffix[j + 1] ? v : suffix[j + 1]) : (v > suffix[j + 1] ? v : suffix[j + 1]);
  }
  for (let i = 0; i < SIZE; i++) { const a = suffix[i], b = prefix[i + width - 1]; target[start + i * step] = erode ? (a < b ? a : b) : (a > b ? a : b); }
}
function morph(source, radius, erode) {
  const rows = new Float32Array(source.length), out = new Float32Array(source.length);
  for (let y = 0; y < SIZE; y++) line(source, rows, y * SIZE, 1, radius, erode);
  for (let x = 0; x < SIZE; x++) line(rows, out, x, SIZE, radius, erode);
  return out;
}
// Morphological reconstruction by dilation of marker under mask (Vincent's hybrid algorithm, 8-connected).
// Scans run over a 1-pixel padded copy so the hot loops need no bounds checks.
const W = SIZE + 2, BEFORE = [-W - 1, -W, -W + 1, -1], AFTER = [W + 1, W, W - 1, 1], AROUND = [...BEFORE, ...AFTER];
function reconstruct(marker, mask) {
  const out = new Float32Array(W * W).fill(-1), limit = new Float32Array(W * W).fill(-1);
  // FIFO of pixels to propagate from. A pixel can be queued again whenever it rises, so the queue grows when
  // needed, first by dropping the processed front, then by doubling.
  let queue = new Int32Array(W * W * 2), head = 0, length = 0;
  const push = p => {
    if (length === queue.length) {
      if (head > queue.length / 2) { queue.copyWithin(0, head, length); length -= head; head = 0; }
      else { const larger = new Int32Array(queue.length * 2); larger.set(queue); queue = larger; }
    }
    queue[length++] = p;
  };
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) { const i = y * SIZE + x, p = (y + 1) * W + x + 1; limit[p] = mask[i]; out[p] = Math.min(marker[i], mask[i]); }
  for (let y = 1; y <= SIZE; y++) for (let p = y * W + 1, end = p + SIZE; p < end; p++) {
    let value = out[p]; for (let k = 0; k < 4; k++) if (out[p + BEFORE[k]] > value) value = out[p + BEFORE[k]];
    out[p] = value < limit[p] ? value : limit[p];
  }
  for (let y = SIZE; y >= 1; y--) for (let p = y * W + SIZE; p > y * W; p--) {
    let value = out[p]; for (let k = 0; k < 4; k++) if (out[p + AFTER[k]] > value) value = out[p + AFTER[k]];
    out[p] = value < limit[p] ? value : limit[p];
    for (let k = 0; k < 4; k++) { const q = p + AFTER[k]; if (out[q] < out[p] && out[q] < limit[q]) { push(p); break; } }
  }
  for (; head < length; head++) {
    const p = queue[head];
    for (let k = 0; k < 8; k++) {
      const q = p + AROUND[k];
      if (out[q] < out[p] && limit[q] !== out[q]) { out[q] = out[p] < limit[q] ? out[p] : limit[q]; push(q); }
    }
  }
  const result = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) result[y * SIZE + x] = out[(y + 1) * W + x + 1];
  return result;
}
const openByReconstruction = (gray, radius) => reconstruct(morph(gray, radius, true), gray);
const invert = values => values.map(value => 1 - value);
// Opening removes small bright structures, closing (opening of the inverse) then removes small dark ones.
function reference(gray, radius = RADIUS) { return invert(openByReconstruction(invert(openByReconstruction(gray, radius)), radius)); }
/** Grayscale input, its reference, the signed difference and the 20 × 20 cell means of that difference.
 * A soft threshold drops weak residuals (sensor noise, surface texture, anti-aliased edges), which
 * would otherwise add a little to every cell and outweigh a small defect. */
function differenceGrid(image) {
  const gray = grayscale(image), ref = reference(gray), difference = new Float32Array(gray.length), grid = Array(GRID * GRID).fill(0);
  for (let i = 0; i < gray.length; i++) {
    const d = gray[i] - ref[i];
    difference[i] = Math.sign(d) * Math.max(0, Math.abs(d) - THRESHOLD);
    grid[Math.floor(Math.floor(i / SIZE) / CELL) * GRID + Math.floor((i % SIZE) / CELL)] += difference[i] / (CELL * CELL);
  }
  return { gray, reference: ref, difference, grid };
}
// One scale for every cell, fitted on the training partition only (99th percentile of non-zero magnitudes):
// a defect must weigh the same wherever it appears.
function fitScaling(grids) {
  const magnitudes = grids.flatMap(grid => grid.map(Math.abs).filter(Boolean)).sort((a, b) => a - b);
  return { scale: Math.max(.02, magnitudes[Math.floor(magnitudes.length * .99)] || 0) };
}
/** Network input: 400 cell features plus 3 grid-wide ones.
 * Each cell is compared with its 8 neighbours: the feature is how far the cell's magnitude rises above their
 * mean, square-rooted after scaling. A defect stands out from the cells around it, while a broad residual
 * (a slightly off reference, a gradient) does not; magnitudes make a dark defect weigh as much as a bright one,
 * and the square root keeps a defect covering part of one cell well above the zero of a clean cell.
 * The grid-wide features are the total difference, the strongest cell and the number of non-zero cells,
 * which do not depend on where a defect is ("the more pixels the difference contains, the more likely
 * a defect") and keep large defects, whose inner cells match their neighbours, visible.
 * The signed grid stays for display and localization. */
function features(grid, scaling) {
  const scale = scaling ? scaling.scale : 1, magnitude = grid.map(Math.abs);
  let sum = 0, max = 0, count = 0;
  const cells = magnitude.map((value, i) => {
    sum += value; if (value > max) max = value; if (value > 0) count++;
    const row = Math.floor(i / GRID), col = i % GRID;
    let around = 0, neighbours = 0;
    for (let r = Math.max(0, row - 1); r <= Math.min(GRID - 1, row + 1); r++) for (let c = Math.max(0, col - 1); c <= Math.min(GRID - 1, col + 1); c++) if (r !== row || c !== col) { around += magnitude[r * GRID + c]; neighbours++; }
    return Math.sqrt(Math.max(0, value - around / neighbours) / scale);
  });
  return [...cells, Math.sqrt(sum / scale / 4), Math.sqrt(max / scale), Math.min(1, count / 20)];
}
if (typeof module !== 'undefined') module.exports = { grayscale, reference, differenceGrid, features, fitScaling, SIZE, GRID, CELL, RADIUS, THRESHOLD, REFERENCE };
