export interface Option {
  value: string;
  /** What the list shows, when that is not the value itself. */
  label?: string;
}

/**
 * The options that match `query`, best first: those that start with it, then
 * those with a word that does, then the rest that contain it. Ties keep their
 * order, so a list that was sorted stays sorted.
 */
export function search<T extends Option>(options: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  const rank = (o: T) => {
    let best = 3;
    for (const text of [o.value, o.label ?? '']) {
      const t = text.toLowerCase();
      const at = t.indexOf(q);
      if (at < 0) continue;
      best = Math.min(best, at === 0 ? 0 : /[\s\-_/.:]/.test(t[at - 1]) ? 1 : 2);
    }
    return best;
  };
  return options.map((o) => [rank(o), o] as const)
    .filter(([r]) => r < 3)
    .sort((a, b) => a[0] - b[0])
    .map(([, o]) => o);
}
