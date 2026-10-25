function luminance(image) {
  const { width, height, rgb } = image ?? {};
  if (![width, height].every(Number.isSafeInteger) || width < 32 || height < 32 || width > 4096 || height > 4096
      || width * height > 4 * 1024 * 1024 || !(rgb instanceof Uint8Array)
      || rgb.length !== width * height * 3) throw new Error('invalid_pixel_image');
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) values[i] = (rgb[i * 3] * 3 + rgb[i * 3 + 1] * 6 + rgb[i * 3 + 2]) / 10;
  return { width, height, values };
}

function lineCandidates(gray, vertical, polarity) {
  const length = vertical ? gray.width : gray.height;
  const cross = vertical ? gray.height : gray.width;
  const scores = new Float32Array(length);
  const at = (a, b) => gray.values[vertical ? b * gray.width + a : a * gray.width + b];
  for (let a = 4; a < length - 4; a++) {
    let hits = 0;
    for (let b = 0; b < cross; b += 2) {
      const center = at(a, b);
      if ((center - at(a - 4, b)) * polarity > 30 && (center - at(a + 4, b)) * polarity > 30) hits++;
    }
    scores[a] = hits;
  }
  const max = Math.max(...scores);
  if (max < cross * 0.1) return [];
  const lines = [];
  let start = -1;
  for (let i = 0; i <= length; i++) {
    if (scores[i] >= max * 0.62 && i < length) { if (start < 0) start = i; }
    else if (start >= 0) {
      if (i - start <= 8) lines.push((start + i - 1) / 2);
      start = -1;
    }
  }
  return lines;
}

function axisGrids(lines, size) {
  const grids = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const step = (lines[j] - lines[i]) / (size - 1);
    if (step < 12) continue;
    const points = [];
    for (let n = 0; n < size; n++) {
      const expected = lines[i] + n * step;
      const closest = lines.find(value => Math.abs(value - expected) <= Math.max(1.5, step * 0.04));
      if (closest === undefined) break;
      points.push(closest);
    }
    if (points.length === size && !grids.some(grid => Math.abs(grid[0] - points[0]) < 2 && Math.abs(grid[1] - points[1]) < 2)) {
      grids.push(points);
    }
  }
  return grids;
}

export function locateGomokuBoard(image, boardSize = 15) {
  if (![15, 19].includes(boardSize)) throw new Error('unsupported_board_size');
  const gray = luminance(image);
  const candidates = [];
  for (const polarity of [-1, 1]) {
    const xs = axisGrids(lineCandidates(gray, true, polarity), boardSize);
    const ys = axisGrids(lineCandidates(gray, false, polarity), boardSize);
    for (const x of xs) for (const y of ys) {
      const dx = (x.at(-1) - x[0]) / (boardSize - 1);
      const dy = (y.at(-1) - y[0]) / (boardSize - 1);
      if (Math.abs(dx - dy) / Math.max(dx, dy) > 0.1) continue;
      if (x[0] < dx * 0.45 || y[0] < dy * 0.45 || x.at(-1) + dx * 0.45 >= gray.width
          || y.at(-1) + dy * 0.45 >= gray.height) continue;
      if (!candidates.some(value => Math.abs(value.x[0] - x[0]) < 2 && Math.abs(value.y[0] - y[0]) < 2)) {
        candidates.push({ x, y, spacing_x: dx, spacing_y: dy });
      }
    }
  }
  if (candidates.length !== 1) return { status: 'unknown', reason: candidates.length ? 'board_ambiguous' : 'board_not_found' };
  return { status: 'located', board_size: boardSize, ...candidates[0] };
}

function median(values) { return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]; }
function classifyCell(gray, cx, cy, spacing) {
  const at = (x, y) => gray.values[Math.round(y) * gray.width + Math.round(x)];
  const background = [];
  for (const dx of [-0.43, 0.43]) for (const dy of [-0.43, 0.43]) background.push(at(cx + dx * spacing, cy + dy * spacing));
  const base = median(background);
  const values = [];
  const radius = Math.max(3, Math.floor(spacing * 0.27));
  const gridBand = Math.max(1, Math.ceil(spacing * 0.065));
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (dx * dx + dy * dy > radius * radius || Math.abs(dx) <= gridBand || Math.abs(dy) <= gridBand) continue;
    values.push(at(cx + dx, cy + dy));
  }
  if (!values.length || !Number.isFinite(base)) return 'unknown';
  const dark = values.filter(value => value < 75 && base - value > 40).length / values.length;
  const light = values.filter(value => value > 175 && value - base > 30).length / values.length;
  if (dark >= 0.85) return 'black';
  if (light >= 0.85) return 'white';
  const spread = Math.max(...background) - Math.min(...background);
  if (spread > 40 || dark > 0.12 || light > 0.12 || values.some(value => Math.abs(value - base) > 45)) return 'unknown';
  // Very pale boards cannot reliably distinguish white stones from empty cells.
  if (base > 215 || base < 65) return 'unknown';
  return 'empty';
}

export function recognizeGomokuPixels(image, { boardSize = 15 } = {}) {
  const board = locateGomokuBoard(image, boardSize);
  if (board.status !== 'located') return board;
  const gray = luminance(image);
  const cells = board.y.flatMap(y => board.x.map(x => classifyCell(gray, x, y, Math.min(board.spacing_x, board.spacing_y))));
  return { status: 'observed', board, state: { board_size: boardSize, cells, turn: 'unknown',
    player_color: 'unknown', rules: 'unknown' }, unknown_cells: cells.filter(cell => cell === 'unknown').length,
    source: 'local_grid_pixels', rules_validation: 'not_performed' };
}
