import { Lru } from '../core/lru.ts';
import { type ImageResult } from '../platform/messages.ts';

const CACHE_LIMIT = 12;

/**
 * Translated images, most recently used last. Extension messages are
 * JSON-serialized so the worker sends base64; the page keeps only a blob URL,
 * which avoids putting the full image string in the DOM.
 */
export class ResultCache {
  private results: Lru<ImageResult>;

  constructor(limit = CACHE_LIMIT) {
    this.results = new Lru<ImageResult>(limit, (dropped) => {
      if (dropped.ok && dropped.image) URL.revokeObjectURL(dropped.image);
    });
  }

  get size(): number {
    return this.results.size;
  }

  get(key: string): ImageResult | null {
    return this.results.get(key);
  }

  set(key: string, response: ImageResult): ImageResult {
    return this.results.set(key, response.ok && response.image
      ? { ...response, image: blobUrl(response.image) }
      : response);
  }

  /** Whatever is in here was made by settings that no longer apply. */
  clear(): void {
    this.results.clear();
  }
}

function blobUrl(dataUrl: string): string {
  const [header, encoded] = dataUrl.split(',', 2);
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const type = header.match(/^data:([^;]+)/)?.[1] || 'application/octet-stream';
  return URL.createObjectURL(new Blob([bytes], { type }));
}
