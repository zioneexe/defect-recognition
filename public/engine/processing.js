/* One fixed 10 × 10 grid is shared by preparation and inference. */
const SIZE = 200, GRID = 10;
// Fit per-cell scaling only on training images; reuse it unchanged at inference.
// The source representation remains the single image's absolute cell averages.
function fitScaling(grids) {
  return Array.from({ length: GRID * GRID }, (_, i) => {
    const values = grids.map(grid => grid[i]);
    const min = Math.min(...values), max = Math.max(...values);
    return { center: (min + max) / 2, scale: Math.max(.02, max - min) };
  });
}
function features(grid, scaling) { return grid.map((value, i) => scaling ? (value - scaling[i].center) / scaling[i].scale : value); }
function intensityGrid(image) {
  if (!image || image.length !== SIZE * SIZE * 4) throw Error('Expected one normalized 200 × 200 RGBA image.');
  const pixels = new Float32Array(SIZE * SIZE);
  const grid = Array(GRID * GRID).fill(0);
  for (let i = 0; i < pixels.length; i++) {
    const p = i * 4;
    const value = (image[p] + image[p+1] + image[p+2]) / 765;
    pixels[i] = value;
    grid[Math.floor(Math.floor(i / SIZE) / 20) * GRID + Math.floor((i % SIZE) / 20)] += value / 400;
  }
  return { pixels, grid };
}
function regions(pixels, grid) {
  const visited = new Uint8Array(pixels.length), results = [];
  for (let i = 0; i < pixels.length; i++) {
    if (visited[i] || pixels[i] < .8) continue;
    const queue = [i]; visited[i] = 1;
    let x = 0, y = 0, touchesEdge = false;
    const cells = new Set();
    for (let k = 0; k < queue.length; k++) {
      const index = queue[k], px = index % SIZE, py = Math.floor(index / SIZE);
      x += px; y += py;
      touchesEdge ||= px === 0 || py === 0 || px === SIZE - 1 || py === SIZE - 1;
      cells.add(Math.floor(py / 20) * GRID + Math.floor(px / 20));
      for (const [nx, ny] of [[px-1,py],[px+1,py],[px,py-1],[px,py+1]]) {
        const n = ny * SIZE + nx;
        if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && !visited[n] && pixels[n] >= .8) { visited[n] = 1; queue.push(n); }
      }
    }
    // Border-connected white backgrounds and large solid shapes are not holes.
    // Localization is a heuristic, independent of the image-level NN prediction.
    if (touchesEdge || queue.length < 3 || queue.length > SIZE * SIZE * .1) continue;
    x = Math.round(x / queue.length); y = Math.round(y / queue.length);
    const cell = Math.floor(y / 20) * GRID + Math.floor(x / 20);
    results.push({ x, y, cell, cells: [...cells], row: Math.floor(y / 20) + 1, col: Math.floor(x / 20) + 1, intensity: grid[cell], area: queue.length });
  }
  return results.sort((a,b) => b.area - a.area);
}
if (typeof module !== 'undefined') module.exports = { intensityGrid, regions, features, fitScaling, SIZE, GRID };
