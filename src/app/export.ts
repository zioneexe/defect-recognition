export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export function bitmap(canvas: HTMLCanvasElement): Blob {
  const { width: w, height: h } = canvas, stride = (w * 3 + 3) & ~3;
  const buffer = new ArrayBuffer(54 + stride * h), v = new DataView(buffer);
  v.setUint16(0, 0x4d42, true); v.setUint32(2, buffer.byteLength, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true);
  v.setInt32(18, w, true); v.setInt32(22, h, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, stride * h, true);
  const rgba = canvas.getContext('2d')!.getImageData(0, 0, w, h).data, bytes = new Uint8Array(buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, t = 54 + (h - y - 1) * stride + x * 3; bytes[t] = rgba[s+2]; bytes[t+1] = rgba[s+1]; bytes[t+2] = rgba[s]; }
  return new Blob([buffer], { type: 'image/bmp' });
}
