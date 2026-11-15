// The setups as cards, on the welcome page and at the top of the settings page.
// A card writes a whole profile; the settings page's Custom card is where a
// reader and a translator are picked one by one.
import { type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { LANGUAGES } from '../core/language.ts';
import {
  CUSTOM, SERVER, cardOf, customFor, serverProfile, withCard, withKeys,
} from '../platform/cards.ts';
import { type EndpointSettings, PRESETS, find } from '../platform/profiles.ts';
import {
  CHATGPT_KEY, OPENROUTER, adapterFor, keyScope, provider, scopeOf, startOn,
} from '../platform/providers.ts';
import { Input, Names, Row } from './fields.tsx';
import { PackStatus, hasTranslator } from './packs.tsx';
import { type Profiles } from './profiles.ts';
import {
  type Served, ModelField, isLlamacpp, servedNote, useAdoption, useServed,
} from './served.tsx';
import { SignIn } from './signin.tsx';
import { NONE, Status, note } from './status.tsx';

interface Card {
  id: string;
  title: string;
  blurb?: ComponentChildren;
}

const GUIDE = 'https://github.com/rinpatch/llm-image-translate/blob/main/docs/local-translation.md';

const CARDS: Card[] = [
  {
    id: 'browser-only',
    title: 'In this browser',
    blurb: <>Uses Chrome's built-in <a href="https://developer.chrome.com/docs/ai/translator-api"
      target="_blank">Translator API</a></>,
  },
  { id: 'openrouter', title: 'OpenRouter' },
  { id: 'chatgpt', title: 'ChatGPT plan' },
  {
    id: SERVER,
    title: 'OpenAI-compatible server',
    blurb: <>If you are interested in running a local model, check out
      the <a href={GUIDE} target="_blank">guide</a>.</>,
  },
];

const CUSTOM_CARD: Card = {
  id: CUSTOM,
  title: 'Custom',
  blurb: 'Pick the reader and the translator yourself, and keep several setups under names.',
};

// The sources most images on the web are in; the last row picks any other.
const COMMON = ['Japanese', 'Chinese', 'Korean', 'English'];

function PackRow({ name, others, target, stamp }: {
  name?: string; others?: string[]; target: string; stamp: number;
}) {
  const [other, setOther] = useState(others?.[0] || '');
  return (
    <li>
      {name ? <span>{name}</span> : <Names names={others!} value={other} onPick={setOther} />}
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
  const said = servedNote('translator', endpoint, served);
  return (
    <div class="fields">
      <Row div label="Server"><Input type="url" value={endpoint.baseUrl} spellcheck={false}
        placeholder={provider('server').baseUrl.translator}
        onCommit={(url) => andAdopt(() => change({ baseUrl: url.trim() }))} /></Row>
      <Row div label="API key"><Input type="password" value={endpoint.apiKey} autocomplete="off"
        placeholder="Only if the server asks for one"
        onCommit={(key) => andAdopt(() => setKey(key.trim()))} /></Row>
      <Row div label="Model"><ModelField id="server-model" role="translator" endpoint={endpoint}
        served={served} fallback="The one it serves"
        onCommit={(model) => change({ model: model.trim() })} /></Row>
      <Status of={said.text ? said : served ? note('Answered.', 'ok')
        : endpoint.baseUrl ? note('Checking…') : NONE} />
    </div>
  );
}

/**
 * The cards, one of them checked for the profile in use. `custom` is what the
 * Custom card opens onto; without it there is no Custom card, and a profile no
 * card describes leaves them all unchecked.
 */
export function Choices({ profiles, target, packStamp, custom }: {
  profiles: Profiles; target: string; packStamp?: number; custom?: ComponentChildren;
}) {
  const { list, setList, active, setActiveId, keyring, setKey } = profiles;
  const chosen = active ? cardOf(active) : '';

  // The server card's translator is the stored one while that is still the
  // card's, and a draft until it is first picked.
  const stored = find(list, SERVER);
  const kept = Boolean(stored && cardOf(stored) === SERVER);
  const [draft, setDraft] = useState(startOn('translator', 'server'));
  const server = kept ? stored!.translator : draft;
  const served = useServed(server, chosen === SERVER);
  const llamacpp = isLlamacpp(served);
  // The key goes with the server, so a new URL brings whatever is kept for it.
  const finish = (e: EndpointSettings) => ({ ...e,
    apiKey: keyring[scopeOf(e)] || '', adapter: adapterFor('translator', e, undefined, llamacpp) });

  const editServer = (change: (e: EndpointSettings) => EndpointSettings) => {
    if (!kept) return setDraft(change);
    setList((now) => withCard(now, serverProfile(finish(change(find(now, SERVER)!.translator)))));
  };
  // Fresh, so the first answer picks the model; after that only a change of
  // server or key does.
  const andAdopt = useAdoption('translator', server, served,
    (change) => editServer((e) => { const next = { ...e }; change(next); return next; }), true);
  // Whether llama.cpp is serving decides the adapter, and that is only known
  // once the server answers.
  useEffect(() => {
    if (kept && finish(server).adapter !== server.adapter) editServer(finish);
  }, [kept, llamacpp]);

  const choose = (id: string) => {
    if (id === CUSTOM) {
      const to = customFor(list, active!);
      setList(to.list);
      setActiveId(to.id);
      return;
    }
    const card = id === SERVER ? serverProfile(finish(server))
      : withKeys(structuredClone(find(PRESETS, id)!), keyring);
    setList((now) => withCard(now, card));
    setActiveId(id);
  };

  if (!active) return null;
  const cards = custom ? [...CARDS, CUSTOM_CARD] : CARDS;
  return (
    <>
      <div class="choices">
        {cards.map((card) => {
          const blocked = card.id === 'browser-only' && !hasTranslator();
          return (
            <label class="choice" key={card.id}>
              <input type="radio" name="profile" value={card.id}
                checked={card.id === chosen} disabled={blocked}
                onChange={() => choose(card.id)} />
              <div>
                <b>{card.title}</b>
                {(card.blurb || blocked) && (
                  <p class="blurb">
                    {card.blurb}
                    {blocked && ' Chrome\'s translator is turned off in this browser.'}
                  </p>
                )}
                {card.id === 'openrouter' && (
                  <div class="fields">
                    <Row div label={<span>API key — <a href="https://openrouter.ai/keys"
                      target="_blank">get one</a></span>}>
                      <Input type="password" value={keyring[keyScope(OPENROUTER)] || ''}
                        autocomplete="off" placeholder="sk-or-…"
                        onCommit={(key) => setKey(keyScope(OPENROUTER), key.trim())} />
                    </Row>
                  </div>
                )}
                {card.id === 'chatgpt' && (
                  <div class="fields">
                    <SignIn div token={keyring[CHATGPT_KEY] || ''} setKey={async (key) => {
                      await setKey(CHATGPT_KEY, key);
                      // Signing in leaves no doubt which card was meant.
                      if (key && chosen !== 'chatgpt') choose('chatgpt');
                    }} />
                  </div>
                )}
                {card.id === SERVER && <ServerFields endpoint={server} served={served}
                  andAdopt={andAdopt} change={(patch) => editServer((e) => ({ ...e, ...patch }))}
                  setKey={(key) => {
                    setKey(scopeOf(server), key);
                    if (!kept) setDraft((e) => ({ ...e, apiKey: key }));
                  }} />}
              </div>
            </label>
          );
        })}
      </div>
      {chosen === 'browser-only' && <Packs target={target} stamp={packStamp} />}
      {chosen === CUSTOM && <div class="custom">{custom}</div>}
    </>
  );
}
