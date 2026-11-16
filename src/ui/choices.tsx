// The translators as cards, on the welcome page and at the top of the settings
// page. Picking one is the whole setting: only the server card has fields.
import { type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { LANGUAGES } from '../core/language.ts';
import { type EndpointSettings } from '../platform/endpoint.ts';
import {
  CHATGPT_KEY, OPENROUTER, PROVIDERS, guessAdapter, keyScope, provider, scopeOf,
} from '../platform/providers.ts';
import { NameBox } from './combobox.tsx';
import { Input, Row } from './fields.tsx';
import { PackStatus, hasTranslator } from './packs.tsx';
import {
  type Served, ModelField, isLlamacpp, servedNote, useAdoption, useServed,
} from './served.tsx';
import { SignIn } from './signin.tsx';
import { NONE, Status, note } from './status.tsx';
import { type Translator } from './translator.ts';

const GUIDE = 'https://github.com/rinpatch/llm-image-translate/blob/main/docs/local-translation.md';

const BLURBS: Record<string, ComponentChildren> = {
  browser: <>Uses Chrome's built-in <a href="https://developer.chrome.com/docs/ai/translator-api"
    target="_blank">Translator API</a>. Free and private, but its translations are rougher
    than the other choices'.</>,
  chatgpt: <>Eligible usage in this app uses your ChatGPT plan, the same usage as Codex.
    Included with Plus, Pro, Business, Edu and Enterprise.</>,
  server: <>If you are interested in running a local model, check out
    the <a href={GUIDE} target="_blank">guide</a>.</>,
};

// The sources most images on the web are in; the last row picks any other.
const COMMON = ['Japanese', 'Chinese', 'Korean', 'English'];

function PackRow({ name, others, target, stamp }: {
  name?: string; others?: string[]; target: string; stamp: number;
}) {
  const [other, setOther] = useState(others?.[0] || '');
  return (
    <li>
      {name ? <span>{name}</span>
        : <NameBox aria-label="Another language" names={others!} value={other} onPick={setOther} />}
      <PackStatus source={name ?? other} target={target} stamp={stamp} />
    </li>
  );
}

export function Packs({ target, stamp = 0 }: { target: string; stamp?: number }) {
  const common = COMMON.filter((n) => n !== target).slice(0, 3);
  const others = LANGUAGES.filter((n) => n !== target && !common.includes(n));
  return (
    <div class="packs">
      <h3>Language packs</h3>
      <p class="blurb">Chrome downloads each language once.</p>
      <ul>
        {common.map((name) => <PackRow key={name} name={name} target={target} stamp={stamp} />)}
        <PackRow key={`other-${target}`} others={others} target={target} stamp={stamp} />
      </ul>
    </div>
  );
}

// Rows as divs: the card they sit in is already the radio's label.
function ServerFields({ endpoint, served, change, setKey, andAdopt }: {
  endpoint: EndpointSettings; served: Served; change: (patch: Partial<EndpointSettings>) => void;
  setKey: (key: string) => void; andAdopt: (change: () => void) => void;
}) {
  const said = servedNote(endpoint, served);
  return (
    <div class="fields">
      <Row div label="Server"><Input type="url" value={endpoint.baseUrl} spellcheck={false}
        placeholder={provider('server').baseUrl}
        onCommit={(url) => andAdopt(() => change({ baseUrl: url.trim() }))} /></Row>
      <Row div label="API key"><Input type="password" value={endpoint.apiKey} autocomplete="off"
        placeholder="Only if the server asks for one"
        onCommit={(key) => andAdopt(() => setKey(key.trim()))} /></Row>
      <Row div label="Model"><ModelField id="server-model" endpoint={endpoint}
        served={served} fallback="The one it serves"
        onCommit={(model) => change({ model: model.trim() })} /></Row>
      <Status of={said.text ? said : served ? note('Answered.', 'ok')
        : endpoint.baseUrl ? note('Checking…') : NONE} />
    </div>
  );
}

interface Props {
  translator: Translator;
  target: string;
  packStamp?: number;
}

/** The cards, the picked one checked. Nothing until storage has been read. */
export const Choices = (props: Props) => (props.translator.server ? <Cards {...props} /> : null);

function Cards({ translator, target, packStamp }: Props) {
  const { provider: chosen, setProvider, setServer, keyring, setKey } = translator;
  const server = translator.server!;
  const served = useServed(server, chosen === 'server');
  const llamacpp = isLlamacpp(served);

  // The adapter follows the model, and whether llama.cpp is serving it, which
  // is only known once the server answers.
  const editServer = (change: (e: EndpointSettings) => void) => setServer((now) => {
    const next = { ...now! };
    change(next);
    next.adapter = guessAdapter(next.model, llamacpp);
    return next;
  });
  const andAdopt = useAdoption(server, served, editServer);
  useEffect(() => {
    if (guessAdapter(server.model, llamacpp) !== server.adapter) editServer(() => {});
  }, [llamacpp]);

  return (
    <>
      <div class="choices">
        {PROVIDERS.map((p) => {
          const blocked = p.id === 'browser' && !hasTranslator();
          return (
            <label class="choice" key={p.id}>
              <input type="radio" name="provider" value={p.id}
                checked={p.id === chosen} disabled={blocked}
                onChange={() => setProvider(p.id)} />
              <div>
                <b>{p.label}</b>
                {(BLURBS[p.id] || blocked) && (
                  <p class="blurb">
                    {BLURBS[p.id]}
                    {blocked && ' Chrome\'s translator is turned off in this browser.'}
                  </p>
                )}
                {p.id === 'openrouter' && (
                  <div class="fields">
                    <Row div label={<span>API key — <a href="https://openrouter.ai/keys"
                      target="_blank">get one</a></span>}>
                      <Input type="password" value={keyring[keyScope(OPENROUTER)] || ''}
                        autocomplete="off" placeholder="sk-or-…"
                        onCommit={(key) => setKey(keyScope(OPENROUTER), key.trim())} />
                    </Row>
                  </div>
                )}
                {p.id === 'chatgpt' && (
                  <div class="fields">
                    <SignIn div token={keyring[CHATGPT_KEY] || ''} setKey={async (key) => {
                      await setKey(CHATGPT_KEY, key);
                      // Signing in leaves no doubt which card was meant.
                      if (key) setProvider('chatgpt');
                    }} />
                  </div>
                )}
                {p.id === 'server' && <ServerFields endpoint={server} served={served}
                  andAdopt={andAdopt} change={(patch) => editServer((e) => Object.assign(e, patch))}
                  setKey={(key) => setKey(scopeOf(server), key)} />}
              </div>
            </label>
          );
        })}
      </div>
      {chosen === 'browser' && <Packs target={target} stamp={packStamp} />}
    </>
  );
}
