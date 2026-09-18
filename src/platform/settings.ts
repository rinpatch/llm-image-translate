export interface Settings {
  source: string;
  target: string;
  images: boolean;
  reader: string;
  translator: string;
  /** Which prompt-and-parse pair to drive each endpoint with. */
  ocrAdapter: string;
  translateAdapter: string;
  debug: boolean;
}

export const DEFAULTS: Settings = {
  source: 'Auto',
  target: 'English',
  images: true,
  reader: 'http://127.0.0.1:8090',
  translator: 'http://127.0.0.1:8091',
  ocrAdapter: 'hunyuan-spotting',
  translateAdapter: 'gemma-raw',
  debug: false,
};

export async function settings(): Promise<Settings> {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) } as Settings;
}
