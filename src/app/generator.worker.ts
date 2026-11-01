/// <reference lib="webworker" />
import { GeneratedImage, renderPng } from './generator';
import { writeImage } from './dataset';

addEventListener(
  'message',
  async ({ data }: MessageEvent<{ item: GeneratedImage; path: string }>) => {
    try {
      const start = performance.now();
      const blob = await renderPng(data.item);
      const rendered = performance.now();
      // Dev server sometimes drops requests, so retry.
      for (let attempt = 1; ; attempt++) {
        try {
          await writeImage(data.path, blob, false);
          break;
        } catch (e) {
          if (attempt === 3) throw e;
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
      postMessage({
        ok: true,
        render: rendered - start,
        write: performance.now() - rendered,
        size: blob.size,
      });
    } catch (e) {
      postMessage({ error: (e as Error).message });
    }
  },
);
