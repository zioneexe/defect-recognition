export interface ImageAsset { name: string; url: string; width: number; height: number; size: number; }
export type ImageClass = 'Clean' | 'Defective';
export interface DatasetImage { id: number; shape: string; group: string; imageClass: ImageClass; asset?: ImageAsset; }
export function sampleDataset(): DatasetImage[] {
  return Array.from({ length: 250 }, (_, i) => ({ id: i + 1, shape: i < 125 ? 'Circle' : 'Square', group: i % 125 < 80 ? 'HighQuality' : 'Icons', imageClass: i % 2 === 0 ? 'Clean' : 'Defective' }));
}
export function generateImage(item: DatasetImage): ImageAsset {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 400;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#080e1d'; c.fillRect(0, 0, 400, 400);
  c.fillStyle = '#010407'; c.strokeStyle = '#21a1c3'; c.lineWidth = 1.5;
  c.beginPath();
  if (item.shape === 'Circle') c.arc(200, 200, 91, 0, Math.PI * 2); else c.rect(109, 109, 182, 182);
  c.fill(); c.stroke();
  if (item.imageClass === 'Defective') {
    for (let j = 0; j < 1 + item.id % 3; j++) {
      const angle = (item.id * 2.4 + j * 2.2), radius = 25 + (item.id * 13 + j * 9) % 32;
      c.beginPath(); c.arc(200 + Math.cos(angle) * radius, 200 + Math.sin(angle) * radius, 4 + (item.id + j) % 8, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill();
    }
  }
  const url = canvas.toDataURL('image/png');
  return { name: `${item.shape}_${item.imageClass}_${String(item.id).padStart(3, '0')}.png`, url, width: 400, height: 400, size: Math.round((url.length - 22) * .75) };
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
export async function pixels(asset: ImageAsset): Promise<Uint8ClampedArray> {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 200;
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  c.fillStyle = '#fff'; c.fillRect(0, 0, 200, 200); c.drawImage(await decode(asset.url), 0, 0, 200, 200);
  return c.getImageData(0, 0, 200, 200).data;
}
