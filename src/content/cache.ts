import { type ImageResult } from '../platform/messages.ts';

const CACHE_LIMIT = 12;

/**
 * Translated images, most recently used last. Extension messages are
 * JSON-serialized so the worker sends base64; the page keeps only a blob URL,
 * which avoids putting the full image string in the DOM.
 */
export class ResultCache {
  private results = new Map<string, ImageResult>();
  private limit: number;

  constructor(limit = CACHE_LIMIT) {
    this.limit = limit;
  }

  get size(): number {
    return this.results.size;
  }

  get(key: string): ImageResult | null {
    const value = this.results.get(key);
    if (!value) return null;
    this.results.delete(key);
    this.results.set(key, value);
    return value;
  }

  set(key: string, response: ImageResult): ImageResult {
    const value: ImageResult = response.ok && response.image
      ? { ...response, image: blobUrl(response.image) }
      : response;
    this.results.set(key, value);
    if (this.results.size > this.limit) {
      const oldest = this.results.keys().next().value!;
      const discarded = this.results.get(oldest)!;
      if (discarded.ok && discarded.image) URL.revokeObjectURL(discarded.image);
      this.results.delete(oldest);
    }
    return value;
  }
}

function blobUrl(dataUrl: string): string {
  const [header, encoded] = dataUrl.split(',', 2);
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const type = header.match(/^data:([^;]+)/)?.[1] || 'application/octet-stream';
  return URL.createObjectURL(new Blob([bytes], { type }));
}
