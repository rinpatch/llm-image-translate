// Models asked for JSON return it fenced, wrapped in prose, or after a block of
// reasoning that contains its own drafts of the answer. The real one is the last
// one, so that is the one taken.

/** A reasoning model's drafts are not its answer. */
function afterThinking(content: string): string {
  const end = content.lastIndexOf('</think>');
  return end >= 0 ? content.slice(end + '</think>'.length) : content;
}

/** Walks to the bracket that closes the one at `start`, ignoring string contents. */
function balancedEnd(text: string, start: number): number {
  const close = text[start] === '[' ? ']' : '}';
  const open = text[start];
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

export function extractJson<T = unknown>(content: string): T | null {
  const text = afterThinking(content);
  const found: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[' && text[i] !== '{') continue;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    try {
      found.push(JSON.parse(text.slice(i, end + 1)));
      i = end; // Whatever is nested inside it came with it.
    } catch {
      // Not JSON, or not finished — keep looking from the next bracket.
    }
  }
  if (!found.length) return null;
  const arrays = found.filter(Array.isArray);
  return (arrays.length ? arrays[arrays.length - 1] : found[found.length - 1]) as T;
}

/** An array, or the first array inside an object the model wrapped it in. */
export function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) if (Array.isArray(inner)) return inner;
  }
  return null;
}
