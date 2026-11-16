import { locale } from '../platform/i18n.ts';

const unit = (n: number, name: 'second' | 'millisecond', digits: number) =>
  new Intl.NumberFormat(locale(), { style: 'unit', unit: name, unitDisplay: 'narrow',
    minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

/** 1.4s rather than 1400ms once it is long enough that the digits stop helping. */
export const ms = (n: number) => (n >= 1000 ? unit(n / 1000, 'second', 1)
  : unit(Math.round(n), 'millisecond', 0));

/** English only: the regions page is for working on the extension, and is not translated. */
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** A time of day. Minutes are enough to place a run in the afternoon; seconds tell apart runs in one minute. */
export const clock = (at: number, seconds = false) => new Date(at).toLocaleTimeString(locale(),
  { hour: '2-digit', minute: '2-digit', ...(seconds && { second: '2-digit' }) });
