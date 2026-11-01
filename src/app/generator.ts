export type ImageClass = 'Clean' | 'Defective';

export interface GeneratedImage {
  id: number;
  shape: string;
  group: string;
  imageClass: ImageClass;
}

export const SHAPES = ['Circle', 'Square', 'Triangle', 'Hexagon', 'Star'];
export const GROUPS = ['HighQuality', 'Icons'];

// Bump when generated images change, the folder is rewritten once.
export const SAMPLE_VERSION = 5;

const CLASSES: ImageClass[] = ['Clean', 'Defective'];
const PER_CLASS: Record<string, number> = { HighQuality: 300, Icons: 200 };

export function sampleDataset(): GeneratedImage[] {
  const images: GeneratedImage[] = [];
  for (const shape of SHAPES) {
    for (const group of GROUPS) {
      for (const imageClass of CLASSES) {
        for (let i = 0; i < PER_CLASS[group]; i++) {
          images.push({ id: images.length + 1, shape, group, imageClass });
        }
      }
    }
  }
  return images;
}

export const generatedName = (item: GeneratedImage) =>
  `${item.shape}_${item.group}_${item.imageClass}_${String(item.id).padStart(4, '0')}.png`;

type Context = OffscreenCanvasRenderingContext2D;
type Random = () => number;
type Point = [number, number];

interface Colour {
  hue: number;
  sat: number;
  light: number;
}

interface Shape {
  cx: number;
  cy: number;
  radius: number;
  path: Path2D;
}

// Seeded by id, so the same image is rendered every time.
// Note: changing the order of random calls changes every image (bump SAMPLE_VERSION then).
function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: Random, min: number, max: number) => min + r() * (max - min);
const pick = <T>(r: Random, items: T[]) => items[Math.floor(r() * items.length)];

function hsl(h: number, s: number, l: number, a = 1) {
  return `hsla(${h % 360}, ${s}%, ${Math.max(0, Math.min(100, l))}%, ${a})`;
}

// Grayscale of an HSL colour, as the recognition sees it.
function grayOf({ hue, sat, light }: Colour) {
  const l = Math.max(0, Math.min(100, light)) / 100;
  const a = (sat / 100) * Math.min(l, 1 - l);
  const k = (n: number) => (n + (((hue % 360) + 360) % 360) / 30) % 12;
  const channel = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return (channel(0) + channel(8) + channel(4)) / 3;
}

// ---- Image ----

export function renderImage(item: GeneratedImage): OffscreenCanvas {
  const r = seeded(item.id * 2654435761);
  const icon = item.group === 'Icons';
  const width = Math.round(icon ? between(r, 64, 128) : between(r, 320, 480));
  const height = icon ? width : Math.round(width * between(r, 0.8, 1.2));

  const canvas = new OffscreenCanvas(width, height);
  // willReadFrequently keeps the canvas on CPU, readback is much faster.
  const c = canvas.getContext('2d', { willReadFrequently: true })!;

  const background = { hue: r() * 360, sat: between(r, 0, 60), light: between(r, 4, 96) };
  c.fillStyle = gradient(c, r, background, 0, 0, width, height);
  c.fillRect(0, 0, width, height);

  const colour = shapeColour(r, background.light);
  const shape = placeShape(r, item.shape, width, height, icon);
  fillShape(c, r, shape, colour, icon);

  c.save();
  c.clip(shape.path);
  texture(c, r, shape, colour);

  // Blur is picked before the defects so they can be sized to survive it.
  const noise = icon ? between(r, 4, 14) : between(r, 0, 6);
  const blur = icon ? between(r, 0.4, 1.4) : r() < 0.3 ? between(r, 0.3, 0.9) : 0;

  if (item.imageClass === 'Defective') {
    // Separate random stream, so defects don't change the rest of the image.
    const defects = seeded(item.id * 2246822519 + 1);
    holes(c, defects, shape, grayOf(colour), { pixel: Math.min(width, height) / 200, blur });
  }
  c.restore();

  if (r() < 0.5) {
    c.lineWidth = between(r, 1, Math.max(1.5, shape.radius * 0.04));
    c.strokeStyle = hsl(colour.hue, colour.sat, colour.light - 20);
    c.stroke(shape.path);
  }

  const pixelNoise = r() < (icon ? 0.6 : 0.35) ? noise * between(r, 0.5, 1.2) : 0;
  return degrade(canvas, r, blur, noise, pixelNoise);
}

function gradient(
  c: Context,
  r: Random,
  colour: Colour,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  const { hue, sat, light } = colour;
  const kind = pick(r, ['solid', 'solid', 'linear', 'radial']);
  const shift = between(r, 6, 18);
  const hueShift = between(r, -25, 25);
  if (kind === 'solid') return hsl(hue, sat, light);

  let g: CanvasGradient;
  if (kind === 'linear') {
    g = c.createLinearGradient(between(r, x0, x1), y0, between(r, x0, x1), y1);
  } else {
    const fx = between(r, x0, x1);
    const fy = between(r, y0, y1);
    const size = Math.max(x1 - x0, y1 - y0) * 0.75;
    g = c.createRadialGradient(fx, fy, 0, (x0 + x1) / 2, (y0 + y1) / 2, size);
  }
  g.addColorStop(0, hsl(hue, sat, light + shift / 2));
  g.addColorStop(1, hsl(hue + 360 + hueShift, sat, light - shift / 2));
  return g;
}

function shapeColour(r: Random, backgroundLight: number): Colour {
  const hue = r() * 360;
  const sat = between(r, 15, 90);
  let light = between(r, 8, 66);

  // Keep the shape apart from the background in grayscale.
  if (Math.abs(light - backgroundLight) < 18) {
    light =
      backgroundLight > 50
        ? backgroundLight - between(r, 25, 40)
        : Math.min(68, backgroundLight + between(r, 25, 40));
  }
  return { hue, sat, light };
}

function placeShape(r: Random, kind: string, width: number, height: number, icon: boolean): Shape {
  const stretch = kind === 'Circle' ? between(r, 0.8, 1) : between(r, 0.85, 1.15);
  const side = Math.min(width, height);
  const radius = side * between(r, 0.22, 0.36);
  const slack = Math.max(0, side / 2 - radius * Math.max(1, stretch) * 1.12);
  const cx = width / 2 + (r() - 0.5) * 2 * slack;
  const cy = height / 2 + (r() - 0.5) * 2 * slack;
  const rotation = r() * Math.PI * 2;
  const rough = icon ? 0.015 : between(r, 0, 0.05);

  const path = outline(r, kind, { cx, cy, radius, rotation, stretch, rough });
  return { cx, cy, radius, path };
}

function fillShape(c: Context, r: Random, shape: Shape, colour: Colour, icon: boolean) {
  const { cx, cy, radius } = shape;

  if (!icon && r() < 0.5) {
    c.shadowColor = hsl(0, 0, 0, 0.35);
    c.shadowBlur = radius * 0.15;
    c.shadowOffsetX = c.shadowOffsetY = radius * 0.04;
  }

  c.fillStyle = gradient(c, r, colour, cx - radius, cy - radius, cx + radius, cy + radius);
  c.fill(shape.path);
  c.shadowColor = 'transparent';
}

// ---- Outline ----

function polygon(n: number, size = (i: number) => 1): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2;
    return [Math.cos(angle) * size(i), Math.sin(angle) * size(i)];
  });
}

interface Placement {
  cx: number;
  cy: number;
  radius: number;
  rotation: number;
  stretch: number;
  rough: number;
}

// Unit-size corners, with extra points along the edges so the outline can wobble.
function cornerPoints(kind: string, inner: number): Point[] {
  const sides: Record<string, number> = { Circle: 72, Square: 4, Triangle: 3, Hexagon: 6 };
  const corners = sides[kind] ? polygon(sides[kind]) : polygon(10, (i) => (i % 2 ? inner : 1));
  const steps = kind === 'Circle' ? 1 : 12;
  const points: Point[] = [];

  corners.forEach(([x0, y0], i) => {
    const [x1, y1] = corners[(i + 1) % corners.length];
    for (let s = 0; s < steps; s++) {
      points.push([x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps]);
    }
  });
  return points;
}

function outline(r: Random, kind: string, place: Placement): Path2D {
  const { cx, cy, radius, rotation, stretch, rough } = place;
  const inner = between(r, 0.42, 0.6);
  const points = cornerPoints(kind, inner);

  const waves = Array.from({ length: 3 }, () => ({
    k: 2 + Math.floor(r() * 6),
    phase: r() * Math.PI * 2,
    amp: r() * rough,
  }));
  const wobble = (angle: number) =>
    waves.reduce((sum, w) => sum + w.amp * Math.sin(w.k * angle + w.phase), 0);

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const path = new Path2D();

  points.forEach(([x, y], i) => {
    const scale = 1 + wobble(Math.atan2(y, x)) + (r() - 0.5) * rough * 0.3;
    const px = x * scale * stretch * radius;
    const py = y * scale * radius;
    const X = cx + px * cos - py * sin;
    const Y = cy + px * sin + py * cos;

    if (i === 0) path.moveTo(X, Y);
    else path.lineTo(X, Y);
  });

  path.closePath();
  return path;
}

// ---- Texture ----

// Texture is never white so it can't look like a hole.
function texture(c: Context, r: Random, shape: Shape, colour: Colour) {
  const kind = pick(r, ['none', 'none', 'hatch', 'speckle', 'smudge']);
  if (kind === 'hatch') hatch(c, r, shape, colour);
  if (kind === 'speckle') speckle(c, r, shape, colour);
  if (kind === 'smudge') smudge(c, r, shape, colour);
}

function hatch(c: Context, r: Random, { cx, cy, radius }: Shape, { hue, sat, light }: Colour) {
  const gap = radius * between(r, 0.06, 0.15);
  const angle = r() * Math.PI;
  c.strokeStyle = hsl(hue, sat, light - between(r, 8, 20), 0.35);
  c.lineWidth = gap * 0.3;

  const dx = Math.cos(angle) * radius * 2;
  const dy = Math.sin(angle) * radius * 2;
  c.beginPath();
  for (let d = -radius * 1.5; d < radius * 1.5; d += gap) {
    const x = cx + Math.cos(angle + Math.PI / 2) * d;
    const y = cy + Math.sin(angle + Math.PI / 2) * d;
    c.moveTo(x - dx, y - dy);
    c.lineTo(x + dx, y + dy);
  }
  c.stroke();
}

function speckle(c: Context, r: Random, { cx, cy, radius }: Shape, { hue, sat, light }: Colour) {
  const count = 40 + r() * 80;
  for (let i = 0; i < count; i++) {
    c.fillStyle = hsl(hue, sat, Math.min(70, light + between(r, -15, 15)), 0.6);
    const x = cx + between(r, -1, 1) * radius;
    const y = cy + between(r, -1, 1) * radius;
    const size = radius * between(r, 0.005, 0.02);

    c.beginPath();
    c.arc(x, y, size, 0, Math.PI * 2);
    c.fill();
  }
}

function smudge(c: Context, r: Random, { cx, cy, radius }: Shape, { hue, sat, light }: Colour) {
  const count = 1 + r() * 3;
  for (let i = 0; i < count; i++) {
    const x = cx + between(r, -0.6, 0.6) * radius;
    const y = cy + between(r, -0.6, 0.6) * radius;
    const size = radius * between(r, 0.2, 0.5);

    const g = c.createRadialGradient(x, y, 0, x, y, size);
    g.addColorStop(0, hsl(hue, sat, light - 25, 0.3));
    g.addColorStop(1, hsl(hue, sat, light - 25, 0));
    c.fillStyle = g;
    c.fillRect(x - size, y - size, size * 2, size * 2);
  }
}

// ---- Defects ----

const DEFECT_KINDS = ['spot', 'blob', 'scratch', 'crack', 'speck'];
const SPREAD: Record<string, number> = { spot: 1, blob: 1.3, speck: 0.6 };

// Defects are big enough to survive resize and blur, differ from the shape by >= 0.3 in gray
// and stay away from the outline (otherwise they merge with the background).
function holes(
  c: Context,
  r: Random,
  shape: Shape,
  shade: number,
  { pixel, blur }: { pixel: number; blur: number },
) {
  const { cx, cy, radius, path } = shape;
  const least = (normalized: number) => Math.max(normalized * pixel, blur * 2.2);
  const gap = least(3);

  // Point and the circle of `reach` around it are inside the shape.
  const inside = (x: number, y: number, reach: number) => {
    if (!c.isPointInPath(path, x, y)) return false;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      if (!c.isPointInPath(path, x + Math.cos(a) * reach, y + Math.sin(a) * reach)) return false;
    }
    return true;
  };

  const place = (reach: number): Point | undefined => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * radius * 0.75;
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      if (inside(x, y, reach + gap)) return [x, y];
    }
    return undefined;
  };

  const count = 1 + Math.floor(r() ** 2 * 4);
  for (let i = 0; i < count; i++) {
    const dark = shade > 0.62 || (shade >= 0.35 && r() < 0.4);
    const small = r() < 0.25;
    const kind = pick(r, DEFECT_KINDS);
    let size = Math.max(
      radius * (small ? between(r, 0.025, 0.06) : between(r, 0.07, 0.16)),
      least(small ? 2.2 : 3.5),
    );

    const level = dark
      ? between(r, 0, Math.max(0, shade - 0.3))
      : between(r, Math.min(0.94, shade + 0.3), 1);
    const gray = Math.round(level * 255);
    c.fillStyle = c.strokeStyle = `rgb(${gray}, ${gray}, ${gray})`;

    const [low, high] = small ? [0.02, 0.035] : kind === 'crack' ? [0.03, 0.05] : [0.045, 0.08];
    const width = Math.max(radius * between(r, low, high), least(small ? 1.8 : 2.4));
    const lines = kind === 'scratch' || kind === 'crack';
    const reach = lines ? width / 2 : size * SPREAD[kind];

    let at = place(reach);
    if (!at && i === 0) {
      // The centre always has room for the first defect.
      while (size > least(2.2) && !inside(cx, cy, size + gap)) size *= 0.8;
      at = [cx, cy];
    }
    if (!at) continue;

    if (lines) {
      const fits = (x: number, y: number) => inside(x, y, reach + gap);
      const line = { crack: kind === 'crack', small, radius, width, minLength: least(8) };
      if (drawLine(c, r, at, line, fits)) continue;
      size = Math.max(width, least(2.2));
    }
    drawSpot(c, r, kind, at, size);
  }
}

interface Line {
  crack: boolean;
  small: boolean;
  radius: number;
  width: number;
  minLength: number;
}

// A scratch or crack; each segment turns away from the outline if it has to.
function drawLine(
  c: Context,
  r: Random,
  start: Point,
  line: Line,
  fits: (x: number, y: number) => boolean,
) {
  const steps = line.crack ? 6 : 3;
  const length = Math.max(
    line.radius * (line.small ? between(r, 0.12, 0.3) : between(r, 0.4, 0.9)),
    line.minLength,
  );
  let [x, y] = start;
  let angle = r() * Math.PI * 2;
  let drawn = false;

  c.beginPath();
  c.moveTo(x, y);
  for (let s = 0; s < steps; s++) {
    angle += (r() - 0.5) * (line.crack ? 1.6 : 0.5);

    let next: Point | undefined;
    for (let turn = 0; turn < 6 && !next; turn++) {
      const b = angle + (turn * Math.PI) / 3;
      const nx = x + (Math.cos(b) * length) / steps;
      const ny = y + (Math.sin(b) * length) / steps;
      if (fits(nx, ny) && fits((x + nx) / 2, (y + ny) / 2)) {
        next = [nx, ny];
        angle = b;
      }
    }
    if (!next) break;

    [x, y] = next;
    c.lineTo(x, y);
    drawn = true;
  }

  if (drawn) {
    c.lineWidth = line.width;
    c.lineCap = c.lineJoin = 'round';
    c.stroke();
  }
  return drawn;
}

function drawSpot(c: Context, r: Random, kind: string, [x, y]: Point, size: number) {
  c.beginPath();
  if (kind === 'speck') {
    const ry = size * between(r, 0.2, 0.6);
    c.ellipse(x, y, size * 0.6, ry, r() * Math.PI, 0, Math.PI * 2);
  } else if (kind === 'blob') {
    for (let k = 0; k < 9; k++) {
      const angle = (k / 9) * Math.PI * 2;
      const d = size * between(r, 0.6, 1.3);
      c.lineTo(x + Math.cos(angle) * d, y + Math.sin(angle) * d);
    }
    c.closePath();
  } else {
    const ry = size * between(r, 0.5, 1);
    c.ellipse(x, y, size, ry, r() * Math.PI, 0, Math.PI * 2);
  }
  c.fill();
}

// ---- Blur and noise ----

function degrade(
  canvas: OffscreenCanvas,
  r: Random,
  blur: number,
  noise: number,
  pixelNoise: number,
) {
  const out = blur ? blurred(canvas, blur) : canvas;
  if (noise) addGrain(out, r, noise);
  if (pixelNoise) addPixelNoise(out, r, pixelNoise);
  return out;
}

function blurred(canvas: OffscreenCanvas, blur: number) {
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const c = out.getContext('2d', { willReadFrequently: true })!;
  // Sharp copy underneath so blurred edges don't fade out.
  c.drawImage(canvas, 0, 0);
  c.filter = `blur(${blur}px)`;
  c.drawImage(canvas, 0, 0);
  release(canvas);
  return out;
}

function addGrain(canvas: OffscreenCanvas, r: Random, noise: number) {
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  const pattern = c.createPattern(grainTile(), 'repeat')!;
  pattern.setTransform(new DOMMatrix().translate(r() * GRAIN, r() * GRAIN));
  c.globalCompositeOperation = 'overlay';
  c.globalAlpha = Math.min(1, noise / 14);
  c.fillStyle = pattern;
  c.fillRect(0, 0, canvas.width, canvas.height);
}

function addPixelNoise(canvas: OffscreenCanvas, r: Random, amount: number) {
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  const image = c.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (r() + r() - 1) * amount;
    data[i] += n;
    data[i + 1] += n;
    data[i + 2] += n;
  }
  c.putImageData(image, 0, 0);
}

const GRAIN = 256;
let grain: OffscreenCanvas | undefined;

function grainTile() {
  if (grain) return grain;

  const r = seeded(1);
  grain = new OffscreenCanvas(GRAIN, GRAIN);
  const c = grain.getContext('2d')!;
  const image = c.createImageData(GRAIN, GRAIN);
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = image.data[i + 1] = image.data[i + 2] = 128 + (r() + r() - 1) * 60;
    image.data[i + 3] = 255;
  }
  c.putImageData(image, 0, 0);
  return grain;
}

// Free canvas memory right away, GC is too slow with thousands of images.
export function release(canvas: { width: number; height: number }) {
  canvas.width = canvas.height = 0;
}

export async function renderPng(item: GeneratedImage): Promise<Blob> {
  const canvas = renderImage(item);
  try {
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    release(canvas);
  }
}
