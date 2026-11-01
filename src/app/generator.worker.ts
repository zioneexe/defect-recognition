/// <reference lib="webworker" />
/* Renders one generated image and writes it to the dataset folder, off the main thread: pages in a
 * background tab are throttled, workers are not, and several workers use several cores. */
import { GeneratedImage, renderPng } from './generator';
import { writeImage } from './dataset';

addEventListener('message', async ({ data }: MessageEvent<{ item: GeneratedImage; path: string }>) => {
  try {
    const start = performance.now(), blob = await renderPng(data.item), rendered = performance.now();
    // A busy dev server can drop a request; retry before giving up on the whole run.
    for (let attempt = 1; ; attempt++) {
      try { await writeImage(data.path, blob, false); break; }
      catch (e) { if (attempt === 3) throw e; await new Promise(resolve => setTimeout(resolve, 500 * attempt)); }
    }
    postMessage({ ok: true, render: rendered - start, write: performance.now() - rendered, size: blob.size });
  } catch (e) { postMessage({ error: (e as Error).message }); }
});
