// Chrome 133 grew a native base64 codec, and it is not a small win: 3ms against
// 123ms to encode an 8.7 MB page, 2ms against 281ms to decode it. The manifest
// admits Chrome 116, so the hand-rolled path stays as the fallback.
declare global {
  interface Uint8Array {
    toBase64?(): string;
  }
  interface Uint8ArrayConstructor {
    fromBase64?(text: string): Uint8Array<ArrayBuffer>;
  }
}

// String.fromCharCode takes its arguments on the stack, so the whole array at
// once overflows it somewhere north of a hundred thousand bytes.
const CHUNK = 0x8000;

export function encodeLoop(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export const decodeLoop = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export const toBase64 = (bytes: Uint8Array): string =>
  (bytes.toBase64 ? bytes.toBase64() : encodeLoop(bytes));

export const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  (Uint8Array.fromBase64 ? Uint8Array.fromBase64(text) : decodeLoop(text));
