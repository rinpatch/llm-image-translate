import { type Endpoint, type ModelRequest } from './types.ts';

const PATHS: Record<ModelRequest['kind'], string> = {
  chat: '/v1/chat/completions',
  completion: '/completion',
};

const base = (url: string) => url.replace(/\/$/, '');

async function post(endpoint: Endpoint, path: string, body: unknown, what: string): Promise<any> {
  const url = `${base(endpoint.baseUrl)}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...endpoint.headers,
  };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new Error(`cannot reach ${what} at ${url} — is llama.cpp running?`);
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
  const out = await post(endpoint, PATHS[request.kind], body, what);
  return request.kind === 'chat' ? out.choices[0].message.content : (out.content || '');
}

export async function health(endpoint: Endpoint, what: string): Promise<string | null> {
  try {
    const r = await fetch(`${base(endpoint.baseUrl)}/health`);
    return r.ok ? null : `${what} answered ${r.status}`;
  } catch {
    return `cannot reach ${what} at ${endpoint.baseUrl}`;
  }
}
