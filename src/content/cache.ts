import { fromBase64 } from '../core/base64.ts';
import { Lru } from '../core/lru.ts';
import { type ImageBytes, type ImageResult } from '../platform/messages.ts';

const CACHE_LIMIT = 12;

type Translated = Extract<ImageResult, { ok: true }>;

/** A result whose image the page can hand straight to an <img>. */
export type Ready = Translated & { image: string | null };

/**
 * Translated images, most recently used last. Whatever the worker sent — bytes
 * or base64 — becomes a blob URL here, so the full image never sits in the DOM
 * and there is one place that knows to revoke it.
 */
export class ResultCache {
  private results: Lru<Ready>;

  constructor(limit = CACHE_LIMIT) {
    this.results = new Lru<Ready>(limit, (dropped) => {
      if (dropped.image) URL.revokeObjectURL(dropped.image);
    });
  }

  get size(): number {
    return this.results.size;
  }

  get(key: string): Ready | null {
    return this.results.get(key);
  }

  set(key: string, response: Translated): Ready {
    return this.results.set(key,
      { ...response, image: response.image ? blobUrl(response.image) : null });
  }

  /** Whatever is in here was made by settings that no longer apply. */
  clear(): void {
    this.results.clear();
  }
}

function blobUrl(image: ImageBytes): string {
  if (image instanceof Blob) return URL.createObjectURL(image);
  const [header, encoded] = image.split(',', 2);
  const bytes = fromBase64(encoded);
  const type = header.match(/^data:([^;]+)/)?.[1] || 'application/octet-stream';
  return URL.createObjectURL(new Blob([bytes], { type }));
}
