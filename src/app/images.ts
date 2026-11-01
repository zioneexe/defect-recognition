import { GeneratedImage, generatedName, renderPng } from './generator';

export {
  SHAPES,
  GROUPS,
  SAMPLE_VERSION,
  sampleDataset,
  renderImage,
  renderPng,
  release,
} from './generator';
export type { ImageClass } from './generator';

export interface ImageAsset {
  name: string;
  url: string;
  width: number;
  height: number;
  size: number;
}

// path: file in the dataset folder; without path or asset the image is generated.
export interface DatasetImage extends GeneratedImage {
  asset?: ImageAsset;
  path?: string;
  size?: number;
  modified?: number;
}

const SIZE = 200;

export function imageName(item: DatasetImage) {
  return item.path?.split('/').pop() || item.asset?.name || generatedName(item);
}

export function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

async function toAsset(name: string, url: string, size: number): Promise<ImageAsset> {
  try {
    const image = await decode(url);
    return { name, url, width: image.naturalWidth, height: image.naturalHeight, size };
  } catch {
    URL.revokeObjectURL(url);
    throw Error(`Cannot read ${name}. Use a supported image file.`);
  }
}

export async function generateImage(item: DatasetImage): Promise<ImageAsset> {
  const blob = await renderPng(item);
  return toAsset(imageName(item), URL.createObjectURL(blob), blob.size);
}

export async function loadImage(file: File): Promise<ImageAsset> {
  if (!/\.(png|jpe?g|bmp)$/i.test(file.name)) throw Error('Choose a PNG, JPG or BMP image.');
  return toAsset(file.name, URL.createObjectURL(file), file.size);
}

// Copied into memory so the preview still works if the file is deleted.
export async function urlAsset(url: string, name: string): Promise<ImageAsset> {
  const response = await fetch(url);
  if (!response.ok) throw Error(`Cannot read ${name}: it is no longer in the dataset folder.`);

  const blob = await response.blob();
  return toAsset(name, URL.createObjectURL(blob), blob.size);
}

function squareCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  return canvas;
}

// 200 × 200 RGBA pixels, transparent areas over white.
export function normalize(source: CanvasImageSource): Uint8ClampedArray {
  const canvas = squareCanvas();
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  c.fillStyle = '#fff';
  c.fillRect(0, 0, SIZE, SIZE);
  c.drawImage(source, 0, 0, SIZE, SIZE);

  const data = c.getImageData(0, 0, SIZE, SIZE).data;
  canvas.width = canvas.height = 0;
  return data;
}

// Paints a per-pixel field (reference or difference) as a PNG data URL.
export function fieldImage(
  values: Float32Array,
  color: (value: number) => [number, number, number],
) {
  const canvas = squareCanvas();
  const c = canvas.getContext('2d')!;
  const image = c.createImageData(SIZE, SIZE);
  values.forEach((value, i) => {
    image.data.set(color(value), i * 4);
    image.data[i * 4 + 3] = 255;
  });
  c.putImageData(image, 0, 0);

  const url = canvas.toDataURL('image/png');
  canvas.width = canvas.height = 0;
  return url;
}
