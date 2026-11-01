/* Generated sample dataset. Uses only OffscreenCanvas, so it renders on the page and in web workers alike. */
export type ImageClass = 'Clean' | 'Defective';
export interface GeneratedImage { id: number; shape: string; group: string; imageClass: ImageClass; }
type Context = OffscreenCanvasRenderingContext2D;
export const SHAPES = ['Circle', 'Square', 'Triangle', 'Hexagon', 'Star'];
export const GROUPS = ['HighQuality', 'Icons'];
// Bumped whenever generated images change; a dataset folder written by an older generator is rewritten once.
export const SAMPLE_VERSION = 5;
const CLASSES: ImageClass[] = ['Clean', 'Defective'];
// HighQuality: large, mostly sharp renders. Icons: small, blurred and noisy renders.
const PER_CLASS: Record<string, number> = { HighQuality: 300, Icons: 200 };
export function sampleDataset(): GeneratedImage[] {
  const images: GeneratedImage[] = [];
  for (const shape of SHAPES) for (const group of GROUPS) for (const imageClass of CLASSES)
    for (let i = 0; i < PER_CLASS[group]; i++) images.push({ id: images.length + 1, shape, group, imageClass });
  return images;
}
export const generatedName = (item: GeneratedImage) => `${item.shape}_${item.group}_${item.imageClass}_${String(item.id).padStart(4, '0')}.png`;

type Random = () => number;
type Point = [number, number];
// Seeded by image id, so an image renders identically for training, preview and export.
function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const between = (r: Random, min: number, max: number) => min + r() * (max - min);
const pick = <T>(r: Random, items: T[]) => items[Math.floor(r() * items.length)];
const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h % 360}, ${s}%, ${Math.max(0, Math.min(100, l))}%, ${a})`;
// Grayscale (mean of RGB, 0–1) of an HSL colour: what the recognition pipeline actually sees.
function gray(h: number, s: number, l: number) {
  const L = Math.max(0, Math.min(100, l)) / 100, a = s / 100 * Math.min(L, 1 - L), k = (n: number) => (n + ((h % 360) + 360) % 360 / 30) % 12;
  return [0, 8, 4].reduce((sum, n) => sum + L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)), 0) / 3;
}

/** Renders a generated dataset image: shape, colours, texture, holes, blur and noise all vary per id. */
export function renderImage(item: GeneratedImage): OffscreenCanvas {
  const r = seeded(item.id * 2654435761), icon = item.group === 'Icons';
  const width = Math.round(icon ? between(r, 64, 128) : between(r, 320, 480)), height = icon ? width : Math.round(width * between(r, .8, 1.2));
  const canvas = new OffscreenCanvas(width, height);
  // CPU-backed canvases: every image is read back for training, and GPU readback dominates the cost.
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  const bgHue = r() * 360, bgSat = between(r, 0, 60), bgLight = between(r, 4, 96);
  c.fillStyle = gradient(c, r, bgHue, bgSat, bgLight, 0, 0, width, height); c.fillRect(0, 0, width, height);
  // Shape lightness stays below the white holes and apart from the background in grayscale.
  const hue = r() * 360, sat = between(r, 15, 90);
  let light = between(r, 8, 66);
  if (Math.abs(light - bgLight) < 18) light = bgLight > 50 ? bgLight - between(r, 25, 40) : Math.min(68, bgLight + between(r, 25, 40));
  const stretch = item.shape === 'Circle' ? between(r, .8, 1) : between(r, .85, 1.15);
  const radius = Math.min(width, height) * between(r, .22, .36), slack = Math.max(0, Math.min(width, height) / 2 - radius * Math.max(1, stretch) * 1.12);
  const cx = width / 2 + (r() - .5) * 2 * slack, cy = height / 2 + (r() - .5) * 2 * slack;
  const path = outline(item.shape, r, cx, cy, radius, r() * Math.PI * 2, stretch, icon ? .015 : between(r, 0, .05));
  if (!icon && r() < .5) { c.shadowColor = hsl(0, 0, 0, .35); c.shadowBlur = radius * .15; c.shadowOffsetX = c.shadowOffsetY = radius * .04; }
  c.fillStyle = gradient(c, r, hue, sat, light, cx - radius, cy - radius, cx + radius, cy + radius); c.fill(path);
  c.shadowColor = 'transparent';
  c.save(); c.clip(path);
  texture(c, r, hue, sat, light, cx, cy, radius);
  // Blur and noise are drawn before the defects: defects are sized so they survive them.
  const noise = icon ? between(r, 4, 14) : between(r, 0, 6), blur = icon ? between(r, .4, 1.4) : r() < .3 ? between(r, .3, .9) : 0;
  // Defects use their own random stream, so a defective image is its clean counterpart plus defects.
  if (item.imageClass === 'Defective') holes(c, seeded(item.id * 2246822519 + 1), path, cx, cy, radius, gray(hue, sat, light), { pixel: Math.min(width, height) / 200, blur });
  c.restore();
  if (r() < .5) { c.lineWidth = between(r, 1, Math.max(1.5, radius * .04)); c.strokeStyle = hsl(hue, sat, light - 20); c.stroke(path); }
  return degrade(canvas, r, blur, noise, r() < (icon ? .6 : .35) ? noise * between(r, .5, 1.2) : 0);
}
function gradient(c: Context, r: Random, hue: number, sat: number, light: number, x0: number, y0: number, x1: number, y1: number) {
  const kind = pick(r, ['solid', 'solid', 'linear', 'radial']), shift = between(r, 6, 18), hueShift = between(r, -25, 25);
  if (kind === 'solid') return hsl(hue, sat, light);
  const g = kind === 'linear' ? c.createLinearGradient(between(r, x0, x1), y0, between(r, x0, x1), y1)
    : c.createRadialGradient(between(r, x0, x1), between(r, y0, y1), 0, (x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) * .75);
  g.addColorStop(0, hsl(hue, sat, light + shift / 2)); g.addColorStop(1, hsl(hue + 360 + hueShift, sat, light - shift / 2));
  return g;
}
// Unit-radius vertices with a wobbling, uneven edge; circles are dense polygons so they wobble too.
function outline(shape: string, r: Random, cx: number, cy: number, radius: number, rotation: number, stretch: number, rough: number) {
  const polygon = (n: number, size = (i: number) => 1) => Array.from({ length: n }, (_, i): Point => [Math.cos(i / n * Math.PI * 2) * size(i), Math.sin(i / n * Math.PI * 2) * size(i)]);
  const inner = between(r, .42, .6);
  const base = shape === 'Circle' ? polygon(72) : shape === 'Square' ? polygon(4) : shape === 'Triangle' ? polygon(3) : shape === 'Hexagon' ? polygon(6) : polygon(10, i => i % 2 ? inner : 1);
  const points: Point[] = [], steps = shape === 'Circle' ? 1 : 12;
  base.forEach(([x0, y0], i) => { const [x1, y1] = base[(i + 1) % base.length]; for (let s = 0; s < steps; s++) points.push([x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps]); });
  const waves = Array.from({ length: 3 }, () => ({ k: 2 + Math.floor(r() * 6), phase: r() * Math.PI * 2, amp: r() * rough }));
  const cos = Math.cos(rotation), sin = Math.sin(rotation), path = new Path2D();
  points.forEach(([x, y], i) => {
    const angle = Math.atan2(y, x), scale = 1 + waves.reduce((sum, w) => sum + w.amp * Math.sin(w.k * angle + w.phase), 0) + (r() - .5) * rough * .3;
    const px = x * scale * stretch * radius, py = y * scale * radius, X = cx + px * cos - py * sin, Y = cy + px * sin + py * cos;
    if (i) path.lineTo(X, Y); else path.moveTo(X, Y);
  });
  path.closePath();
  return path;
}
// Surface imperfections. Never white, so a clean image cannot contain hole-like pixels.
function texture(c: Context, r: Random, hue: number, sat: number, light: number, cx: number, cy: number, radius: number) {
  const kind = pick(r, ['none', 'none', 'hatch', 'speckle', 'smudge']);
  if (kind === 'hatch') {
    const gap = radius * between(r, .06, .15), angle = r() * Math.PI;
    c.strokeStyle = hsl(hue, sat, light - between(r, 8, 20), .35); c.lineWidth = gap * .3; c.beginPath();
    for (let d = -radius * 1.5; d < radius * 1.5; d += gap) { const x = cx + Math.cos(angle + Math.PI / 2) * d, y = cy + Math.sin(angle + Math.PI / 2) * d; c.moveTo(x - Math.cos(angle) * radius * 2, y - Math.sin(angle) * radius * 2); c.lineTo(x + Math.cos(angle) * radius * 2, y + Math.sin(angle) * radius * 2); }
    c.stroke();
  } else if (kind === 'speckle') {
    for (let i = 0, n = 40 + r() * 80; i < n; i++) { c.fillStyle = hsl(hue, sat, Math.min(70, light + between(r, -15, 15)), .6); c.beginPath(); c.arc(cx + between(r, -1, 1) * radius, cy + between(r, -1, 1) * radius, radius * between(r, .005, .02), 0, Math.PI * 2); c.fill(); }
  } else if (kind === 'smudge') {
    for (let i = 0, n = 1 + r() * 3; i < n; i++) {
      const x = cx + between(r, -.6, .6) * radius, y = cy + between(r, -.6, .6) * radius, size = radius * between(r, .2, .5), g = c.createRadialGradient(x, y, 0, x, y, size);
      g.addColorStop(0, hsl(hue, sat, light - 25, .3)); g.addColorStop(1, hsl(hue, sat, light - 25, 0)); c.fillStyle = g; c.fillRect(x - size, y - size, size * 2, size * 2);
    }
  }
}
// Inclusions inside the shape: round spots, irregular blobs, scratches, thin cracks and tiny specks; about a
// quarter are small, so the network also learns defects that cover only part of one grid cell. Each defect stays
// visible after the 200 × 200 resize and the blur: its size has a floor in recognition pixels and blurred pixels,
// and its colour differs from the shape by at least 0.3 in grayscale. White holes on darker shapes, dark
// inclusions (soot, burns, dark scratches) on lighter ones, either on mid-tone shapes.
// Defects keep a gap from the outline: one that reaches a background of its own tone merges with it, and then
// it is indistinguishable from a notch in the outline, both for the eye and for the reference.
function holes(c: Context, r: Random, path: Path2D, cx: number, cy: number, radius: number, shade: number, { pixel, blur }: { pixel: number; blur: number }) {
  // Native pixels for one pixel of the 200 × 200 recognition image, widened by the blur.
  const least = (normalized: number) => Math.max(normalized * pixel, blur * 2.2), gap = least(3);
  // The point and everything within `reach` of it lie inside the shape.
  const inside = (x: number, y: number, reach: number) => c.isPointInPath(path, x, y) && Array.from({ length: 12 }, (_, k) => k / 12 * Math.PI * 2).every(a => c.isPointInPath(path, x + Math.cos(a) * reach, y + Math.sin(a) * reach));
  const place = (reach: number): [number, number] | undefined => {
    for (let attempt = 0; attempt < 40; attempt++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * radius * .75, x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d; if (inside(x, y, reach + gap)) return [x, y]; }
    return undefined;
  };
  for (let i = 0, count = 1 + Math.floor(r() ** 2 * 4); i < count; i++) {
    const dark = shade > .62 || shade >= .35 && r() < .4, small = r() < .25, kind = pick(r, ['spot', 'blob', 'scratch', 'crack', 'speck']);
    let size = Math.max(radius * (small ? between(r, .025, .06) : between(r, .07, .16)), least(small ? 2.2 : 3.5));
    const level = dark ? between(r, 0, Math.max(0, shade - .3)) : between(r, Math.min(.94, shade + .3), 1);
    c.fillStyle = c.strokeStyle = `rgb(${Array(3).fill(Math.round(level * 255)).join(', ')})`;
    const width = Math.max(radius * (small ? between(r, .02, .035) : kind === 'crack' ? between(r, .03, .05) : between(r, .045, .08)), least(small ? 1.8 : 2.4));
    const lines = kind === 'scratch' || kind === 'crack', reach = lines ? width / 2 : kind === 'blob' ? size * 1.3 : kind === 'speck' ? size * .6 : size;
    // The shape's centre always has room; the first defect falls back to it, shrunk if it must.
    let at = place(reach);
    if (!at && i === 0) { while (size > least(2.2) && !inside(cx, cy, size + gap)) size *= .8; at = [cx, cy]; }
    if (!at) continue;
    let [x, y] = at, drawn = false;
    c.beginPath();
    if (lines) {
      const crack = kind === 'crack', steps = crack ? 6 : 3, length = Math.max(radius * (small ? between(r, .12, .3) : between(r, .4, .9)), least(8));
      let a = r() * Math.PI * 2; c.moveTo(x, y);
      // Each segment that would come near the outline turns back; the line ends where no direction fits.
      for (let s = 0; s < steps; s++) {
        a += (r() - .5) * (crack ? 1.6 : .5);
        let step: [number, number] | undefined;
        for (let turn = 0; turn < 6 && !step; turn++) { const b = a + turn * Math.PI / 3, nx = x + Math.cos(b) * length / steps, ny = y + Math.sin(b) * length / steps; if (inside(nx, ny, reach + gap) && inside((x + nx) / 2, (y + ny) / 2, reach + gap)) { step = [nx, ny]; a = b; } }
        if (!step) break;
        [x, y] = step; c.lineTo(x, y); drawn = true;
      }
      if (drawn) { c.lineWidth = width; c.lineCap = c.lineJoin = 'round'; c.stroke(); continue; }
      size = Math.max(width, least(2.2));
    }
    if (kind === 'speck') c.ellipse(x, y, size * .6, size * between(r, .2, .6), r() * Math.PI, 0, Math.PI * 2);
    else if (kind === 'blob') { for (let k = 0; k < 9; k++) { const b = k / 9 * Math.PI * 2, d = size * between(r, .6, 1.3); c.lineTo(x + Math.cos(b) * d, y + Math.sin(b) * d); } c.closePath(); }
    else c.ellipse(x, y, size, size * between(r, .5, 1), r() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }
}
function degrade(canvas: OffscreenCanvas, r: Random, blur: number, noise: number, pixelNoise: number) {
  let out = canvas;
  if (blur) {
    out = new OffscreenCanvas(canvas.width, canvas.height);
    // The sharp copy underneath keeps blurred borders from fading to transparent.
    const c = out.getContext('2d', { willReadFrequently: true })!; c.drawImage(canvas, 0, 0); c.filter = `blur(${blur}px)`; c.drawImage(canvas, 0, 0);
    release(canvas);
  }
  if (noise) {
    // Film-like grain from a shared tile.
    const c = out.getContext('2d', { willReadFrequently: true })!, pattern = c.createPattern(grain(), 'repeat')!;
    pattern.setTransform(new DOMMatrix().translate(r() * GRAIN, r() * GRAIN));
    c.globalCompositeOperation = 'overlay'; c.globalAlpha = Math.min(1, noise / 14); c.fillStyle = pattern; c.fillRect(0, 0, out.width, out.height);
  }
  if (pixelNoise) {
    // Independent per-pixel sensor noise, only on part of the images.
    const c = out.getContext('2d', { willReadFrequently: true })!, image = c.getImageData(0, 0, out.width, out.height), d = image.data;
    for (let i = 0; i < d.length; i += 4) { const n = (r() + r() - 1) * pixelNoise; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    c.putImageData(image, 0, 0);
  }
  return out;
}
const GRAIN = 256;
let grainTile: OffscreenCanvas | undefined;
function grain() {
  if (grainTile) return grainTile;
  const r = seeded(1), canvas = new OffscreenCanvas(GRAIN, GRAIN);
  const c = canvas.getContext('2d')!, image = c.createImageData(GRAIN, GRAIN), d = image.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 128 + (r() + r() - 1) * 60; d[i + 3] = 255; }
  c.putImageData(image, 0, 0);
  return grainTile = canvas;
}

/** Frees a canvas's pixel buffer now. Thousands of renders otherwise pile up buffers the small JS heap never collects. */
export function release(canvas: { width: number; height: number }) { canvas.width = canvas.height = 0; }
/** Encodes a generated image as PNG and frees its canvas. */
export async function renderPng(item: GeneratedImage): Promise<Blob> {
  const canvas = renderImage(item);
  try { return await canvas.convertToBlob({ type: 'image/png' }); } finally { release(canvas); }
}
