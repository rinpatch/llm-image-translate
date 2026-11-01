/** 1.4s rather than 1400ms once it is long enough that the digits stop helping. */
export const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** A time of day. Minutes are enough to place a run in the afternoon; seconds tell apart runs in one minute. */
export const clock = (at: number, seconds = false) => new Date(at).toLocaleTimeString([],
  { hour: '2-digit', minute: '2-digit', ...(seconds && { second: '2-digit' }) });
