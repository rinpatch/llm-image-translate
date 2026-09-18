import { type Endpoint, type ModelRequest } from './types.ts';

// A base URL is written either way round — llama.cpp is handed out as
// http://127.0.0.1:8090 and OpenRouter as https://openrouter.ai/api/v1 — so the
// version segment is taken off and put back rather than trusted either way.
const serverRoot = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/, '');
const apiRoot = (url: string) => `${serverRoot(url)}/v1`;

// /completion is llama.cpp's own, outside the OpenAI-compatible surface.
const pathFor = (url: string, kind: ModelRequest['kind']) =>
  (kind === 'chat' ? `${apiRoot(url)}/chat/completions` : `${serverRoot(url)}/completion`);

function headersFor(endpoint: Endpoint): Record<string, string> {
  const headers: Record<string, string> = { ...endpoint.headers };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  return headers;
}

async function post(endpoint: Endpoint, url: string, body: unknown, what: string): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headersFor(endpoint),
  };

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new Error(`cannot reach ${what} at ${url}`);
  }
  if (!response.ok) throw new Error(`${what} answered ${response.status}`);
  return response.json();
}

/** Posts what an adapter built and hands back the text the model produced. */
export async function send(
  endpoint: Endpoint,
  request: ModelRequest,
  what: string,
): Promise<string> {
  const body = endpoint.model ? { ...request.body, model: endpoint.model } : request.body;
  const out = await post(endpoint, pathFor(endpoint.baseUrl, request.kind), body, what);
  return request.kind === 'chat' ? out.choices[0].message.content : (out.content || '');
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
