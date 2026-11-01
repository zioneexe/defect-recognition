import { GeneratedImage, generatedName, renderPng } from './generator';
export { SHAPES, GROUPS, SAMPLE_VERSION, sampleDataset, renderImage, renderPng, release } from './generator';
export type { ImageClass } from './generator';

export interface ImageAsset { name: string; url: string; width: number; height: number; size: number; }
// `path` is set for images in the dataset folder; images without path or asset are generated from their id.
export interface DatasetImage extends GeneratedImage { asset?: ImageAsset; path?: string; size?: number; modified?: number; }
export function imageName(item: DatasetImage) { return item.path?.split('/').pop() || item.asset?.name || generatedName(item); }

/** A generated image as a PNG object URL, for preview and recognition. */
export async function generateImage(item: DatasetImage): Promise<ImageAsset> {
  const blob = await renderPng(item), url = URL.createObjectURL(blob), image = await decode(url);
  return { name: imageName(item), url, width: image.naturalWidth, height: image.naturalHeight, size: blob.size };
}
export async function loadImage(file: File): Promise<ImageAsset> {
  if (!/\.(png|jpe?g|bmp)$/i.test(file.name)) throw Error('Choose a PNG, JPG or BMP image.');
  const url = URL.createObjectURL(file);
  try { const image = await decode(url); return { name: file.name, url, width: image.naturalWidth, height: image.naturalHeight, size: file.size }; }
  catch { URL.revokeObjectURL(url); throw Error(`Cannot read ${file.name}. Use a supported image file.`); }
}
export function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; });
}
export async function pixels(asset: Pick<ImageAsset, 'url'>): Promise<Uint8ClampedArray> { return normalize(await decode(asset.url)); }
/** An image from the dataset folder, copied into memory so the preview survives the file being removed. */
export async function urlAsset(url: string, name: string): Promise<ImageAsset> {
  const response = await fetch(url);
  if (!response.ok) throw Error(`Cannot read ${name}: it is no longer in the dataset folder.`);
  const blob = await response.blob(), local = URL.createObjectURL(blob);
  const image = await decode(local).catch(() => { URL.revokeObjectURL(local); throw Error(`Cannot read ${name}. Use a supported image file.`); });
  return { name, url: local, width: image.naturalWidth, height: image.naturalHeight, size: blob.size };
}
export function normalize(source: CanvasImageSource): Uint8ClampedArray {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 200;
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  c.fillStyle = '#fff'; c.fillRect(0, 0, 200, 200); c.drawImage(source, 0, 0, 200, 200);
  const data = c.getImageData(0, 0, 200, 200).data;
  canvas.width = canvas.height = 0;
  return data;
}
/** Renders a 200 × 200 per-pixel field (the worker's reference or difference) as a PNG data URL. */
export function fieldImage(values: Float32Array, color: (value: number) => [number, number, number]): string {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 200;
  const c = canvas.getContext('2d')!, image = c.createImageData(200, 200);
  values.forEach((value, i) => { image.data.set(color(value), i * 4); image.data[i * 4 + 3] = 255; });
  c.putImageData(image, 0, 0);
  const url = canvas.toDataURL('image/png');
  canvas.width = canvas.height = 0;
  return url;
}
