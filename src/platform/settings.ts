export interface Settings {
  source: string;
  target: string;
  images: boolean;
  reader: string;
  translator: string;
  debug: boolean;
}

export const DEFAULTS: Settings = {
  source: 'Auto',
  target: 'English',
  images: true,
  reader: 'http://127.0.0.1:8090',
  translator: 'http://127.0.0.1:8091',
  debug: false,
};

export async function settings(): Promise<Settings> {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) } as Settings;
}
