import { type Endpoint, type ModelRequest, type ModelStats, type Reply } from './types.ts';

// A hung request holds the service worker awake for as long as it lasts, so
// there is an outer limit even when nobody cancels.
const TIMEOUT_MS = 90_000;

/** Thrown when the caller gave up, which is not a failure worth reporting. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

// A base URL is written either way round — llama.cpp is handed out as
// http://127.0.0.1:8090 and OpenRouter as https://openrouter.ai/api/v1 — so the
// version segment is taken off and put back rather than trusted either way.
const serverRoot = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/, '');
const apiRoot = (url: string) => `${serverRoot(url)}/v1`;

// /completion is llama.cpp's own, outside the OpenAI-compatible surface.
const PATHS: Record<Exclude<ModelRequest['kind'], 'offscreen'>, (url: string) => string> = {
  chat: (url) => `${apiRoot(url)}/chat/completions`,
  completion: (url) => `${serverRoot(url)}/completion`,
};

/**
 * How to reach a reader or translator that runs in this browser rather than
 * over the network.
 * Installed by the worker, because getting at it is `chrome.runtime` and
 * backends/ stays free of `chrome.*` so node can import it.
 */
let inBrowser: ((body: Record<string, unknown>) => Promise<any>) | null = null;
export const readsInBrowser = (ask: typeof inBrowser): void => { inBrowser = ask; };

function headersFor(endpoint: Endpoint): Record<string, string> {
  return endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};
}

async function post(
  endpoint: Endpoint,
  url: string,
  body: unknown,
  what: string,
  signal?: AbortSignal,
): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headersFor(endpoint),
  };
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const giveUp = signal ? AbortSignal.any([signal, deadline]) : deadline;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: giveUp,
    });
  } catch {
    if (signal?.aborted) throw new Cancelled();
    if (deadline.aborted) throw new Error(`${what} did not answer within ${TIMEOUT_MS / 1000}s`);
    throw new Error(`cannot reach ${what} at ${url}`);
  }
  if (!response.ok) throw new Error(`${what} answered ${response.status}`);
  return response.json();
}

// llama.cpp puts a `timings` block beside the answer; everyone else has `usage`
// and nothing about prefill. Where the server did not time itself, the round trip
// stands in for the generation, which charges it for the network too.
function statsOf(out: any, wall_ms: number): ModelStats {
  const stats: ModelStats = { wall_ms };
  const timings = out?.timings;
  if (Number.isFinite(timings?.prompt_ms)) stats.ttft_ms = Math.round(timings.prompt_ms);
  const tokens = Number(timings?.predicted_n ?? out?.usage?.completion_tokens);
  if (Number.isFinite(tokens) && tokens > 0) {
    stats.tokens = tokens;
    stats.gen_ms = Math.round(
      Number.isFinite(timings?.predicted_ms) ? timings.predicted_ms : wall_ms);
  }
  return stats;
}

/** Posts what an adapter built and hands back the text the model produced. */
export async function send(
  endpoint: Endpoint,
  request: ModelRequest,
  what: string,
  signal?: AbortSignal,
): Promise<Reply> {
  const body = endpoint.model ? { ...request.body, model: endpoint.model } : request.body;
  const started = Date.now();
  if (request.kind === 'offscreen') {
    if (!inBrowser) throw new Error(`${what} cannot run here`);
    const answer = await inBrowser(request.body);
    return {
      text: JSON.stringify(answer.lines ?? []),
      stats: { wall_ms: Date.now() - started },
    };
  }
  const out = await post(endpoint, PATHS[request.kind](endpoint.baseUrl), body, what, signal);
  // A model that answers with nothing at all — a refusal, or a reasoning model
  // that spent its budget thinking — still has to come back as a string.
  const content = request.kind === 'chat'
    ? out.choices?.[0]?.message?.content
    : out.content;
  return {
    text: typeof content === 'string' ? content : '',
    stats: statsOf(out, Date.now() - started),
  };
}

// /v1/models rather than llama.cpp's /health: every OpenAI-compatible server has
// it, and a key that is wrong fails here the same way it would fail in earnest.
export async function health(endpoint: Endpoint, what: string): Promise<string | null> {
  const url = `${apiRoot(endpoint.baseUrl)}/models`;
  try {
    const r = await fetch(url, { headers: headersFor(endpoint) });
    return r.ok ? null : `${what} answered ${r.status} at ${url}`;
  } catch {
    return `cannot reach ${what} at ${url}`;
  }
}

export interface ListedModel {
  id: string;
  name?: string;
  /** Whether it takes images, where the server says. OpenRouter and llama.cpp do. */
  vision?: boolean;
  /** Served by llama.cpp, so /completion is there beside the OpenAI routes. */
  llamacpp?: boolean;
}

/** What the server says it serves, or null when it would not say. */
export async function listModels(endpoint: Endpoint, signal?: AbortSignal):
  Promise<ListedModel[] | null> {
  try {
    const r = await fetch(`${apiRoot(endpoint.baseUrl)}/models`,
      { headers: headersFor(endpoint), signal });
    if (!r.ok) return null;
    const out = await r.json();
    if (!Array.isArray(out?.data)) return null;
    // llama.cpp answers in Ollama's shape as well, and only that half says what
    // a model can take.
    const ollama = new Map<string, unknown>((Array.isArray(out.models) ? out.models : [])
      .map((m: any) => [m?.model ?? m?.name, m?.capabilities]));
    return out.data.filter((m: any) => typeof m?.id === 'string').map((m: any) => {
      const modalities = m.architecture?.input_modalities;
      const capabilities = ollama.get(m.id);
      const vision = Array.isArray(modalities) ? modalities.includes('image')
        : Array.isArray(capabilities) ? capabilities.includes('multimodal')
          : undefined;
      return {
        id: m.id,
        ...(typeof m.name === 'string' ? { name: m.name } : {}),
        ...(vision === undefined ? {} : { vision }),
        ...(m.owned_by === 'llamacpp' ? { llamacpp: true } : {}),
      };
    });
  } catch {
    return null;
  }
}
