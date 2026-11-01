import type { ImageClass } from './generator';

export interface FolderImage {
  path: string;
  shape: string;
  group: string;
  imageClass: ImageClass;
  size: number;
  modified: number;
}

export interface Listing {
  root: string;
  shapes: string[];
  groups: string[];
  folders: Record<string, string[]>;
  images: FolderImage[];
  ignored: number;
}

export interface FolderMeta {
  sampleVersion?: number;
  samples?: 'writing' | 'complete';
  started?: number;
  rewrite?: boolean;
}

export function fileUrl(path: string) {
  return `/api/files/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(value.error || `Dataset server error ${response.status}.`);
  return value;
}

const post = <T>(url: string, body: unknown) =>
  call<T>(url, { method: 'POST', body: JSON.stringify(body) });

export const listDataset = () => call<Listing>('/api/dataset');

export const readMeta = () => call<FolderMeta>('/api/meta');

export const writeMeta = (meta: FolderMeta) =>
  call<FolderMeta>('/api/meta', { method: 'PUT', body: JSON.stringify(meta) });

export const makeFolder = (path: string) => post('/api/folders', { path });

export const openFolder = (path: string) => post('/api/open', { path });

// Returns the saved path; with `unique` an existing name gets a _1, _2 ... suffix.
export async function writeImage(path: string, data: Blob, unique = true) {
  const url = fileUrl(path) + (unique ? '?unique=1' : '');
  const result = await call<{ path: string }>(url, { method: 'PUT', body: data });
  return result.path;
}

export async function removeImages(paths: string[]) {
  const result = await post<{ removed: number }>('/api/remove', { paths });
  return result.removed;
}

export function watchDataset(onChange: () => void) {
  const source = new EventSource('/api/events');
  source.addEventListener('change', onChange);
  return () => source.close();
}
