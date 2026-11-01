/* Localization on the difference grid. The reference already removed the shape and
 * background, so any cell whose mean difference passes the threshold departs from
 * the defect-free estimate. Adjacent cells form one region; regions are ranked by
 * how much clearing them lowers the network's defective score, then by strength.
 */
const CELL_THRESHOLD = .008;
function localize(grid, predict, score, width, height) {
  if (!width || !height) return [];
  const suspicious = grid.map(value => Math.abs(value) >= CELL_THRESHOLD);
  const visited = new Set(), results = [];
  for (let start = 0; start < grid.length; start++) {
    if (!suspicious[start] || visited.has(start)) continue;
    const cells = [start]; visited.add(start);
    for (let k = 0; k < cells.length; k++) {
      const row = Math.floor(cells[k] / GRID), col = cells[k] % GRID;
      for (const [r, c] of [[row-1,col],[row+1,col],[row,col-1],[row,col+1],[row-1,col-1],[row-1,col+1],[row+1,col-1],[row+1,col+1]]) {
        const index = r * GRID + c;
        if (r >= 0 && r < GRID && c >= 0 && c < GRID && suspicious[index] && !visited.has(index)) { visited.add(index); cells.push(index); }
      }
    }
    const rows = cells.map(i => Math.floor(i / GRID)), cols = cells.map(i => i % GRID);
    const left = Math.floor(Math.min(...cols) * width / GRID), top = Math.floor(Math.min(...rows) * height / GRID);
    const right = Math.ceil((Math.max(...cols) + 1) * width / GRID), bottom = Math.ceil((Math.max(...rows) + 1) * height / GRID);
    const representative = cells.reduce((best, i) => Math.abs(grid[i]) > Math.abs(grid[best]) ? i : best, cells[0]);
    const cleared = [...grid]; cells.forEach(i => cleared[i] = 0);
    results.push({ index: 0, x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2),
      cell: representative, cells, row: Math.floor(representative / GRID) + 1, col: representative % GRID + 1,
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
      gridBounds: { rowStart: Math.min(...rows) + 1, rowEnd: Math.max(...rows) + 1, colStart: Math.min(...cols) + 1, colEnd: Math.max(...cols) + 1 },
      area: cells.length * width * height / (GRID * GRID),
      intensity: cells.reduce((sum, i) => sum + grid[i], 0) / cells.length,
      strength: cells.reduce((sum, i) => sum + Math.abs(grid[i]), 0),
      anomalyScore: cells.reduce((sum, i) => sum + Math.abs(grid[i]) / (Math.abs(grid[i]) + CELL_THRESHOLD), 0) / cells.length,
      contribution: Math.max(0, score - predict(cleared)) });
  }
  // A saturated score barely moves when one region is cleared, so strength breaks near-ties.
  return results.sort((a, b) => (b.contribution - a.contribution) || (b.strength - a.strength)).map((region, i) => ({ ...region, index: i + 1 }));
}
