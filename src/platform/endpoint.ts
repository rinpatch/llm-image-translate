import { type Endpoint } from '../backends/types.ts';

/** Where the translator runs, and the adapter that knows how to talk to it. */
export interface EndpointSettings {
  /** An id from PROVIDERS: where the model runs, which decides what else is asked. */
  provider: string;
  baseUrl: string;
  /** Stored per server under `keys`, not with the rest. Filled in on the way out. */
  apiKey: string;
  /** Empty for a server that serves one model and does not ask which. */
  model: string;
  adapter: string;
  /** The ChatGPT plan's reasoning effort. Unset is low. */
  effort?: string;
  /** The ChatGPT plan's fast mode. Unset is on: it is only ever turned off. */
  fast?: boolean;
}

export const toEndpoint = (
  { provider, baseUrl, apiKey, model, effort, fast }: EndpointSettings,
): Endpoint => ({
  baseUrl,
  ...(apiKey ? { apiKey } : {}),
  ...(model ? { model } : {}),
  ...(provider === 'chatgpt'
    ? { responses: true, ...(effort ? { effort } : {}), ...(fast !== false ? { fast: true } : {}) } : {}),
});
