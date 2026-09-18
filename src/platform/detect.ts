import { type Detection } from '../core/language.ts';

export const detect = (text: string): Promise<Detection> =>
  new Promise((resolve) => { chrome.i18n.detectLanguage(text, resolve); });
