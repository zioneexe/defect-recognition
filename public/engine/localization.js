/* Grid-based localization against the nearest clean training pattern. */
function localize(grid, cleanPatterns, predict, score, width, height) {
  if (!cleanPatterns.length || !width || !height) return [];
  const expected = cleanPatterns.reduce((best, candidate) => {
    const distance = candidate.reduce((sum, value, i) => sum + (value - grid[i]) ** 2, 0);
    return distance < best.distance ? { grid: candidate, distance } : best;
  }, { grid: null, distance: Infinity }).grid;
  if (!expected) return [];
  const threshold = .015;
  const deviations = grid.map((value, i) => Math.abs(value - expected[i]));
  // Replace one cell with its learned clean value and measure its contribution.
  const contributions = grid.map((value, i) => {
    if (deviations[i] < .001) return 0;
    const corrected = [...grid]; corrected[i] = expected[i];
    return Math.max(0, score - predict(corrected));
  });
  const suspicious = deviations.map((value, i) => value >= threshold && contributions[i] > .00001);
  if (!suspicious.some(Boolean)) {
    const strongest = contributions.indexOf(Math.max(...contributions));
    if (contributions[strongest] > .00001 && deviations[strongest] >= .001) suspicious[strongest] = true;
  }
  const visited = new Set(), results = [];
  for (let start = 0; start < grid.length; start++) {
    if (!suspicious[start] || visited.has(start)) continue;
    const cells = [start]; visited.add(start);
    for (let k = 0; k < cells.length; k++) {
      const row = Math.floor(cells[k] / GRID), col = cells[k] % GRID;
      for (const [r, c] of [[row-1,col],[row+1,col],[row,col-1],[row,col+1]]) {
        const index = r * GRID + c;
        if (r >= 0 && r < GRID && c >= 0 && c < GRID && suspicious[index] && !visited.has(index)) { visited.add(index); cells.push(index); }
      }
    }
    const rows = cells.map(i => Math.floor(i / GRID)), cols = cells.map(i => i % GRID);
    const left = Math.floor(Math.min(...cols) * width / GRID), top = Math.floor(Math.min(...rows) * height / GRID);
    const right = Math.ceil((Math.max(...cols) + 1) * width / GRID), bottom = Math.ceil((Math.max(...rows) + 1) * height / GRID);
    const representative = cells.reduce((best, i) => contributions[i] > contributions[best] ? i : best, cells[0]);
    const corrected = [...grid]; cells.forEach(i => corrected[i] = expected[i]);
    results.push({ index: 0, x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2),
      cell: representative, cells, row: Math.floor(representative / GRID) + 1, col: representative % GRID + 1,
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
      gridBounds: { rowStart: Math.min(...rows) + 1, rowEnd: Math.max(...rows) + 1, colStart: Math.min(...cols) + 1, colEnd: Math.max(...cols) + 1 },
      area: cells.length * width * height / (GRID * GRID),
      intensity: cells.reduce((sum, i) => sum + grid[i], 0) / cells.length,
      anomalyScore: cells.reduce((sum, i) => sum + deviations[i] / (deviations[i] + threshold), 0) / cells.length,
      contribution: Math.max(0, score - predict(corrected)) });
  }
  return results.sort((a,b) => b.contribution - a.contribution).map((region, i) => ({ ...region, index: i + 1 }));
}
