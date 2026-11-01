const CELL_THRESHOLD = 0.008;
const NEIGHBOURS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

function neighbourCells(index) {
  const row = Math.floor(index / GRID);
  const col = index % GRID;
  const result = [];

  for (const [dr, dc] of NEIGHBOURS) {
    const r = row + dr;
    const c = col + dc;
    if (r >= 0 && r < GRID && c >= 0 && c < GRID) result.push(r * GRID + c);
  }
  return result;
}

// Groups suspicious cells that touch, diagonals included.
function findRegions(suspicious) {
  const visited = new Set();
  const regions = [];

  for (let start = 0; start < suspicious.length; start++) {
    if (!suspicious[start] || visited.has(start)) continue;

    const cells = [start];
    visited.add(start);
    for (let k = 0; k < cells.length; k++) {
      for (const next of neighbourCells(cells[k])) {
        if (suspicious[next] && !visited.has(next)) {
          visited.add(next);
          cells.push(next);
        }
      }
    }
    regions.push(cells);
  }
  return regions;
}

function describeRegion(cells, grid, predict, score, width, height) {
  const rows = cells.map((i) => Math.floor(i / GRID));
  const cols = cells.map((i) => i % GRID);
  const left = Math.floor((Math.min(...cols) * width) / GRID);
  const top = Math.floor((Math.min(...rows) * height) / GRID);
  const right = Math.ceil(((Math.max(...cols) + 1) * width) / GRID);
  const bottom = Math.ceil(((Math.max(...rows) + 1) * height) / GRID);

  const magnitudes = cells.map((i) => Math.abs(grid[i]));
  const strongest = cells.reduce((best, i) =>
    Math.abs(grid[i]) > Math.abs(grid[best]) ? i : best,
  );

  // How much the network's score drops when this region is cleared.
  const cleared = [...grid];
  for (const i of cells) cleared[i] = 0;

  return {
    index: 0,
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2),
    cell: strongest,
    cells,
    row: Math.floor(strongest / GRID) + 1,
    col: (strongest % GRID) + 1,
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    gridBounds: {
      rowStart: Math.min(...rows) + 1,
      rowEnd: Math.max(...rows) + 1,
      colStart: Math.min(...cols) + 1,
      colEnd: Math.max(...cols) + 1,
    },
    area: (cells.length * width * height) / (GRID * GRID),
    intensity: cells.reduce((sum, i) => sum + grid[i], 0) / cells.length,
    strength: magnitudes.reduce((sum, value) => sum + value, 0),
    anomalyScore:
      magnitudes.reduce((sum, value) => sum + value / (value + CELL_THRESHOLD), 0) / cells.length,
    contribution: Math.max(0, score - predict(cleared)),
  };
}

function localize(grid, predict, score, width, height) {
  if (!width || !height) return [];

  const suspicious = grid.map((value) => Math.abs(value) >= CELL_THRESHOLD);
  const regions = findRegions(suspicious).map((cells) =>
    describeRegion(cells, grid, predict, score, width, height),
  );

  // A saturated score barely changes, so strength decides near-ties.
  regions.sort((a, b) => b.contribution - a.contribution || b.strength - a.strength);
  return regions.map((region, i) => ({ ...region, index: i + 1 }));
}
