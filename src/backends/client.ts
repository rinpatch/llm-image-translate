import { type Endpoint, type ModelRequest, type ModelStats, type Reply, type Streamed }
  from './types.ts';

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

// A spent ChatGPT allowance is a 429 that is no use without the reason. OpenAI
// and most servers give it in `error.message`, some in `detail`.
// A ChatGPT plan's refusals, in the words OpenAI asks apps to use:
// https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
const PLAN_ERRORS: Record<string, string> = {
  subscription_sharing_user_not_eligible:
    'ChatGPT plan usage is unavailable for this account or workspace.',
  subscription_sharing_usage_limit_exceeded:
    'Usage limit reached. Manage your plan in ChatGPT settings.',
  subscription_sharing_unsupported_capability:
    'This feature isn\'t supported with your current plan.',
  subscription_sharing_route_not_supported:
    'This operation isn\'t available with ChatGPT plan usage.',
};

/** OpenAI's wording for a plan refusal anywhere in `out`, or undefined. */
export const planError = (out: any): string | undefined =>
  PLAN_ERRORS[out?.error?.code ?? out?.response?.error?.code ?? out?.code ?? out?.detail?.code];

async function whyNot(response: Response): Promise<string | { plan: string }> {
  try {
    const out = await response.json();
    const plan = planError(out);
    if (plan) return { plan };
    const why = out?.detail?.message ?? out?.detail ?? out?.error?.message;
    return typeof why === 'string' ? `: ${why.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

async function post(
  endpoint: Endpoint,
  url: string,
  body: unknown,
  what: string,
  signal?: AbortSignal,
): Promise<Response> {
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
  if (!response.ok) {
    const why = await whyNot(response);
    throw new Error(typeof why === 'string' ? `${what} answered ${response.status}${why}` : why.plan);
  }
  return response;
}

/**
 * A chat completion's body as a Responses request, the only kind a ChatGPT
 * sign-in can make. Sampling settings are left behind because the plan's
 * models refuse them, and so is the token limit: reasoning spends from it, and a
 * limit sized for the answer alone can leave no answer.
 */
function asResponses(body: Record<string, any>, { effort = 'low', fast }: Endpoint):
  Record<string, unknown> {
  const messages: { role: string; content: string }[] = body.messages || [];
  return {
    model: body.model,
    instructions: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'),
    input: messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role,
      content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
    })),
    reasoning: { effort },
    ...(fast ? { service_tier: 'priority' } : {}),
    store: false,
    stream: true,
  };
}

/** A finished Responses answer, shaped like a completion. */
function asCompletion(done: any): any {
  const text = (done?.output || [])
    .filter((item: any) => item.type === 'message')
    .flatMap((item: any) => item.content || [])
    .filter((part: any) => part.type === 'output_text')
    .map((part: any) => part.text)
    .join('');
  // Reasoning is counted in the output but done before the first text, so it is
  // left out of the tokens that the time after that is divided by.
  const usage = done?.usage;
  const written = Number(usage?.output_tokens)
    - Number(usage?.output_tokens_details?.reasoning_tokens || 0);
  return {
    choices: [{ message: { content: text } }],
    usage: { completion_tokens: Number.isFinite(written) ? written : undefined },
  };
}

/** Every event of a server-sent stream, handed over as it arrives. */
async function eachEvent(
  response: Response,
  what: string,
  signal: AbortSignal | undefined,
  on: (event: any) => void,
): Promise<void> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const take = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    let event: any;
    try { event = JSON.parse(data); } catch { return; }
    on(event);
  };
  let pending = '';
  for (;;) {
    let chunk: ReadableStreamReadResult<string>;
    try {
      chunk = await reader.read();
    } catch {
      if (signal?.aborted) throw new Cancelled();
      throw new Error(`${what} stopped partway through its answer`);
    }
    if (chunk.done) break;
    // An event can be split across two reads.
    const lines = (pending + chunk.value).split('\n');
    pending = lines.pop()!;
    lines.forEach(take);
  }
  take(pending);
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

/**
 * Posts what an adapter built and hands back the text the model produced.
 * With `onText` the reply is streamed and reported as it grows; without it a
 * plain completion is asked for, which every server answers.
 */
export async function send(
  endpoint: Endpoint,
  request: ModelRequest,
  what: string,
  signal?: AbortSignal,
  onText?: (sofar: Streamed) => void,
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
  if (endpoint.responses && request.kind === 'chat') {
    const url = `${apiRoot(endpoint.baseUrl)}/responses`;
    const response = await post(endpoint, url, asResponses(body, endpoint), what, signal);
    let done: any = null;
    let first: number | undefined;
    const sofar: Streamed = { text: '', tokens: 0 };
    await eachEvent(response, what, signal, (event) => {
      if (event.type === 'response.output_text.delta') {
        first ??= Date.now() - started;
        sofar.text += event.delta ?? '';
        sofar.tokens += 1;
        onText?.(sofar);
      }
      if (event.type === 'response.completed') done = event.response;
      if (event.type === 'response.failed' || event.type === 'error') {
        throw new Error(planError(event)
          || event.response?.error?.message || event.message || 'the model failed');
      }
    });
    const out = asCompletion(done);
    const wall_ms = Date.now() - started;
    // OpenAI times nothing for us, so these are ours, network and queue included.
    if (first !== undefined) out.timings = { prompt_ms: first, predicted_ms: wall_ms - first };
    return { text: out.choices[0].message.content, stats: statsOf(out, wall_ms) };
  }
  const url = PATHS[request.kind](endpoint.baseUrl);
  if (onText) return streamed(endpoint, request.kind, url, body, what, started, onText, signal);
  const out = await (await post(endpoint, url, body, what, signal)).json();
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

async function streamed(
  endpoint: Endpoint,
  kind: 'chat' | 'completion',
  url: string,
  body: Record<string, unknown>,
  what: string,
  started: number,
  onText: (sofar: Streamed) => void,
  signal?: AbortSignal,
): Promise<Reply> {
  // Without include_usage an OpenAI-compatible stream never says what it cost.
  const asked = { ...body, stream: true,
    ...(kind === 'chat' ? { stream_options: { include_usage: true } } : {}) };
  const response = await post(endpoint, url, asked, what, signal);
  const sofar: Streamed = { text: '', tokens: 0 };
  let written = 0;
  let first: number | undefined;
  let usage: any;
  let timings: any;
  await eachEvent(response, what, signal, (event) => {
    if (event.error) throw new Error(`${what} failed: ${event.error.message || event.error}`);
    if (event.usage) usage = event.usage;
    if (event.timings) timings = event.timings;
    const delta = event.choices?.[0]?.delta;
    const piece = kind === 'chat' ? delta?.content : event.content;
    if (typeof piece === 'string' && piece) {
      first ??= Date.now() - started;
      sofar.text += piece;
      written += 1;
    } else if (!delta?.reasoning_content && !delta?.reasoning) {
      return;
    }
    // A reasoning model's thinking is no part of the answer, but it is the model
    // getting somewhere, and the only sign of life for the first long while.
    sofar.tokens += 1;
    onText(sofar);
  });
  const wall_ms = Date.now() - started;
  // llama.cpp times itself in the last event. Anyone else is timed from here, as
  // the Responses API is, and counted in events where it sent no usage.
  const out = {
    usage: usage ?? { completion_tokens: written },
    timings: timings ?? (first !== undefined
      ? { prompt_ms: first, predicted_ms: wall_ms - first } : undefined),
  };
  return { text: sofar.text, stats: statsOf(out, wall_ms) };
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
    // A ChatGPT plan's catalog, where only `visibility: list` may be offered or asked for.
    if (Array.isArray(out?.models)) {
      return out.models
        .filter((m: any) => typeof m?.slug === 'string' && m.visibility === 'list')
        .map((m: any) => ({ id: m.slug,
          ...(typeof m.display_name === 'string' ? { name: m.display_name } : {}) }));
    }
    if (!Array.isArray(out?.data)) return null;
    return out.data.filter((m: any) => typeof m?.id === 'string').map((m: any) => ({
      id: m.id,
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
      ...(m.owned_by === 'llamacpp' ? { llamacpp: true } : {}),
    }));
  } catch {
    return null;
  }
}
