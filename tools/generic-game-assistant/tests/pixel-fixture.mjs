// Raster fixtures are generated independently of the board detector.
export function boardImage({ width = 640, height = 640, size = 15, left = 60, top = 60,
  extent = 520, background = [205, 170, 115], line = [35, 35, 35], pieces = [], noise = 0 } = {}) {
  const rgb = new Uint8Array(width * height * 3);
  const pixel = (x, y, color) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 3;
    rgb.set(color, at);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixel(x, y, background.map(value => Math.max(0, Math.min(255, value + ((x * 7 + y * 11) % 5 - 2) * noise))));
  }
  const step = extent / (size - 1);
  for (let n = 0; n < size; n++) {
    for (let y = Math.round(top); y <= top + extent; y++) pixel(left + n * step, y, line);
    for (let x = Math.round(left); x <= left + extent; x++) pixel(x, top + n * step, line);
  }
  for (const piece of pieces) {
    const cx = left + piece.col * step, cy = top + piece.row * step, radius = step * 0.37;
    for (let y = Math.floor(cy - radius); y <= cy + radius; y++) for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 && (!piece.half || x < cx)) {
        pixel(x, y, piece.color === 'black' ? [18, 18, 18] : [245, 245, 245]);
      }
    }
  }
  return { width, height, rgb };
}
