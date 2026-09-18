// Everything heavy lives in llama.cpp, which the user runs and points this at.
import { SPOTTING } from './ocr/hunyuan.ts';
import { STOP, prompt } from './translate/gemma.ts';

const base = (url: string) => url.replace(/\/$/, '');

async function post(url: string, body: unknown, what: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`cannot reach ${what} at ${url} — is llama.cpp running?`);
  }
  if (!response.ok) throw new Error(`${what} answered ${response.status}`);
  return response.json();
}

export async function read(url: string, dataUrl: string): Promise<string> {
  const out = await post(`${base(url)}/v1/chat/completions`, {
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: SPOTTING },
      ],
    }],
    temperature: 0,
    max_tokens: 2048,
  }, 'the reader');
  return out.choices[0].message.content;
}

export async function complete(
  url: string,
  text: string,
  source: string,
  target: string,
  maxTokens = 1024,
): Promise<string> {
  const out = await post(`${base(url)}/completion`, {
    prompt: prompt(text, source, target),
    n_predict: maxTokens,
    temperature: 0,
    stop: STOP,
  }, 'the translator');
  return (out.content || '').trim();
}

export async function health(url: string, what: string): Promise<string | null> {
  try {
    const r = await fetch(`${base(url)}/health`);
    return r.ok ? null : `${what} answered ${r.status}`;
  } catch {
    return `cannot reach ${what} at ${url}`;
  }
}
