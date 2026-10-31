import { useEffect, useState } from 'preact/hooks';

/**
 * What `load` resolves to, or undefined while it is out. An answer to deps that
 * have since changed is dropped, not shown: a model list from a server the
 * field has moved off is nobody's. A `load` returning undefined asks nothing.
 */
export function useAsync<T>(load: () => Promise<T> | undefined, deps: unknown[]): T | undefined {
  const [answer, setAnswer] = useState<{ deps: unknown[]; value: T }>();
  useEffect(() => {
    let live = true;
    load()?.then((value) => { if (live) setAnswer({ deps, value }); });
    return () => { live = false; };
  }, deps);
  return answer && answer.deps.every((d, i) => Object.is(d, deps[i])) ? answer.value : undefined;
}
