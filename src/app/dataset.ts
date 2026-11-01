/* Client for the dataset folder server (server/dataset.mjs), reached through the /api proxy. */
import type { ImageClass } from './generator';

export interface FolderImage { path: string; shape: string; group: string; imageClass: ImageClass; size: number; modified: number; }
// `groups` lists every group folder; `folders` the group folders of each shape.
export interface Listing { root: string; shapes: string[]; groups: string[]; folders: Record<string, string[]>; images: FolderImage[]; ignored: number; }

export const fileUrl = (path: string) => `/api/files/${path.split('/').map(encodeURIComponent).join('/')}`;
async function call<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init), value = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(value.error || `Dataset server error ${response.status}.`);
  return value;
}
export const listDataset = () => call<Listing>('/api/dataset');
/** Notes kept with the folder: which sample generator wrote it and whether writing finished. */
export interface FolderMeta { sampleVersion?: number; samples?: 'writing' | 'complete'; started?: number; rewrite?: boolean; }
export const readMeta = () => call<FolderMeta>('/api/meta');
export const writeMeta = (meta: FolderMeta) => call<FolderMeta>('/api/meta', { method: 'PUT', body: JSON.stringify(meta) });
/** Writes an image; with `unique`, an existing name gets a numeric suffix. Resolves to the stored path. */
export const writeImage = async (path: string, data: Blob, unique = true) => (await call<{ path: string }>(fileUrl(path) + (unique ? '?unique=1' : ''), { method: 'PUT', body: data })).path;
export const makeFolder = (path: string) => call('/api/folders', { method: 'POST', body: JSON.stringify({ path }) });
/** Shows a dataset folder ('' for the root) in the system file manager. */
export const openFolder = (path: string) => call('/api/open', { method: 'POST', body: JSON.stringify({ path }) });
/** Moves images into the folder's .removed/ trash. Resolves to how many were moved. */
export const removeImages = async (paths: string[]) => (await call<{ removed: number }>('/api/remove', { method: 'POST', body: JSON.stringify({ paths }) })).removed;
/** Calls back after any change in the dataset folder; returns a function that stops watching. */
export function watchDataset(onChange: () => void) { const source = new EventSource('/api/events'); source.addEventListener('change', onChange); return () => source.close(); }
