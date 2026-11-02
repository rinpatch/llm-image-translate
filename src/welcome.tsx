// The first-run page, opened by the worker on install. It picks among a few
// setups and runs the sample through whichever is chosen; anything finer is the
// settings page's.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { LANGUAGES } from './core/language.ts';
import { type EndpointSettings, type Profile, find } from './platform/profiles.ts';
import { OPENROUTER, adapterFor, keyScope, provider, startOn } from './platform/providers.ts';
import {
  type Keys, keys, profiles, publicSettings, save, saveKey, saveProfiles,
} from './platform/settings.ts';
import { Input, Names, Row } from './ui/fields.tsx';
import {
  PackStatus, downloadPack, fetchingNote, hasTranslator, packState,
} from './ui/packs.tsx';
import {
  type Served, ModelField, isLlamacpp, servedNote, useAdoption, useServed,
} from './ui/served.tsx';
import { NONE, type Note, Status, note } from './ui/status.tsx';
import { TrialImage, useTrial } from './ui/trial.tsx';

interface Choice {
  profile: string;
  title: string;
  blurb: string;
  guide?: { text: string; href: string };
}

// Its own profile rather than the shipped llama.cpp one, whose name says the
// server is on this machine.
const SERVER = 'server';

const CHOICES: Choice[] = [
  {
    profile: 'browser-only',
    title: 'In this browser',
    blurb: 'Free, and images never leave this computer. Literal translations; names '
      + 'come out character by character.',
  },
  {
    profile: 'openrouter',
    title: 'OpenRouter',
    blurb: 'The best translations, at about $0.001 an image.',
  },
  {
    profile: SERVER,
    title: 'OpenAI-compatible server',
    blurb: 'Your own model translates; reading stays in this browser.',
    guide: { text: 'Setting one up on a Mac',
      href: 'https://claude.ai/artifact/NAJTC5Fz6gcvNCeHnPMV73' },
  },
];

// The sources most images on the web are in; the last row picks any other.
const COMMON = ['Japanese', 'Chinese', 'Korean', 'English'];
// What sample.jpg is written in.
const SAMPLE = 'Japanese';
const SAMPLE_URL = chrome.runtime.getURL('sample.jpg');

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

function Packs({ target, stamp }: { target: string; stamp: number }) {
  const common = COMMON.filter((n) => n !== target).slice(0, 3);
  const others = LANGUAGES.filter((n) => n !== target && !common.includes(n));
  return (
    <div id="packs">
      <h3>Language packs</h3>
      <p class="blurb">Chrome downloads each language once.</p>
      <ul>
        {common.map((name) => <PackRow key={name} name={name} target={target} stamp={stamp} />)}
        <PackRow key={`other-${target}`} others={others} target={target} stamp={stamp} />
      </ul>
    </div>
  );
}

/**
 * The server card writes its own profile: PP-OCR reads, the server translates.
 * A vision model as the reader is the settings page's.
 */
async function saveServer(translator: EndpointSettings, served: Served): Promise<void> {
  await saveKey(translator.baseUrl, translator.apiKey);
  const profile: Profile = {
    id: SERVER,
    name: 'OpenAI-compatible server',
    reader: startOn('reader', 'browser'),
    translator: { ...translator,
      adapter: adapterFor('translator', translator, undefined, isLlamacpp(served)) },
  };
  const { list } = await profiles();
  await saveProfiles([...list.filter((p) => p.id !== SERVER), profile]);
}

// Rows as divs: the card they sit in is already the radio's label.
function ServerFields({ endpoint, served, change, andAdopt }: {
  endpoint: EndpointSettings; served: Served; change: (patch: Partial<EndpointSettings>) => void;
  andAdopt: (change: () => void) => void;
}) {
  const said = servedNote('translator', endpoint, served);
  return (
    <div class="fields">
      <Row div label="Server"><Input type="url" value={endpoint.baseUrl} spellcheck={false}
        placeholder={provider('server').baseUrl.translator}
        onCommit={(url) => andAdopt(() => change({ baseUrl: url.trim() }))} /></Row>
      <Row div label="API key"><Input type="password" value={endpoint.apiKey} autocomplete="off"
        placeholder="Only if the server asks for one"
        onCommit={(key) => andAdopt(() => change({ apiKey: key.trim() }))} /></Row>
      <Row div label="Model"><ModelField id="server-model" role="translator" endpoint={endpoint}
        served={served} fallback="The one it serves"
        onCommit={(model) => change({ model: model.trim() })} /></Row>
      <Status of={said.text ? said : served ? note('Answered.', 'ok')
        : endpoint.baseUrl ? note('Checking…') : NONE} />
    </div>
  );
}

function OpenRouterFields({ stored, changed }: { stored: string; changed: () => void }) {
  return (
    <div class="fields">
      <Row div label={<span>API key — <a href="https://openrouter.ai/keys" target="_blank">get one</a></span>}>
        <Input type="password" value={stored} autocomplete="off" placeholder="sk-or-…"
          onCommit={(key) => {
            saveKey(OPENROUTER, key.trim());
            changed();
          }} />
      </Row>
    </div>
  );
}

function Trial({ chosen, target, notes, stamp, fetchedPack }: {
  chosen: string; target: string; notes: boolean; stamp: number; fetchedPack: () => void;
}) {
  const trial = useTrial();
  useEffect(() => trial.forget(), [stamp]);

  // Chrome only fetches a pack on a click, and this is one.
  const fetchPack = async (say: (n: Note) => void) => {
    if (chosen !== 'browser-only' || await packState(SAMPLE, target) === 'available') return;
    say(fetchingNote(undefined, SAMPLE));
    await downloadPack(SAMPLE, target, (done) => say(fetchingNote(done, SAMPLE)));
    fetchedPack();
  };

  return (
    <div class="trial">
      <div>
        <TrialImage result={trial.result} notes={notes} before={SAMPLE_URL}
          alt="A page of Japanese text in speech bubbles" />
      </div>
      <div>
        <div class="buttons">
          <button type="button" class="primary" disabled={trial.busy}
            onClick={() => trial.run(SAMPLE_URL, undefined, fetchPack)}>
            Translate this page
          </button>
          {trial.running && <button type="button" onClick={trial.cancel}>Stop</button>}
        </div>
        <Status of={trial.told} live />
      </div>
    </div>
  );
}

function Welcome() {
  const [target, setTarget] = useState('English');
  const [notes, setNotes] = useState(false);
  const [list, setList] = useState<Profile[] | null>(null);
  const [keyring, setKeyring] = useState<Keys>({});
  const [chosen, setChosen] = useState('');
  // Bumped by anything that makes the last trial out of date.
  const [trialStamp, setTrialStamp] = useState(0);
  const [packStamp, setPackStamp] = useState(0);
  const forgetTrial = () => setTrialStamp((n) => n + 1);

  // The server card's translator, and whether its profile is stored: once it
  // is, every change to the card is saved.
  const [server, setServer] = useState(startOn('translator', 'server'));
  const [kept, setKept] = useState(false);
  const served = useServed(server, kept);
  // Fresh, so the first answer picks the model; after that only a change of
  // server or key does.
  const andAdopt = useAdoption('translator', server, served,
    (change) => setServer((e) => { const next = { ...e }; change(next); return next; }), true);

  useEffect(() => {
    Promise.all([publicSettings(), profiles(), keys()]).then(([s, { list, active }, k]) => {
      setTarget(s.target);
      setNotes(s.notes);
      setKeyring(k);
      setList(list);
      setChosen(active.id);
      const existing = find(list, SERVER)?.translator;
      if (existing) setServer(existing);
      setKept(Boolean(existing));
    });
  }, []);

  useEffect(() => {
    if (kept) saveServer(server, served).then(forgetTrial);
  }, [kept, server, served]);

  const choose = async (profile: string) => {
    setChosen(profile);
    // Stored before it is made active, or the active id names no profile.
    if (profile === SERVER) {
      setKept(true);
      await saveServer(server, served);
    }
    await save('profile', profile);
    forgetTrial();
  };

  return (
    <>
      <header class="hero">
        <img src="icons/128.png" alt="" />
        <div>
          <h1>LLM Image Translate</h1>
          <p>Reads the text in an image and paints the translation over it.</p>
        </div>
      </header>

      <ol class="steps">
        <li>
          <h2>Translate into</h2>
          <Names id="target" aria-label="Translate into" names={LANGUAGES} value={target}
            onPick={async (name) => {
              setTarget(name);
              await save('target', name);
              forgetTrial();
            }} />
        </li>

        <li>
          <h2>Pick the models</h2>
          <div id="choices">
            {list && CHOICES.map((choice) => {
              const isServer = choice.profile === SERVER;
              // Deleted on the settings page, if this is a second visit.
              if (!isServer && !find(list, choice.profile)) return null;
              const blocked = choice.profile === 'browser-only' && !hasTranslator();
              return (
                <label class="choice" key={choice.profile}>
                  <input type="radio" name="profile" value={choice.profile}
                    checked={choice.profile === chosen} disabled={blocked}
                    onChange={() => choose(choice.profile)} />
                  <div>
                    <b>{choice.title}</b>
                    <p class="blurb">
                      {choice.blurb}
                      {blocked && ' Chrome\'s translator is turned off in this browser.'}
                      {choice.guide && <> <a href={choice.guide.href} target="_blank">
                        {`${choice.guide.text} →`}</a></>}
                    </p>
                    {choice.profile === 'openrouter' && (
                      <OpenRouterFields stored={keyring[keyScope(OPENROUTER)] || ''}
                        changed={forgetTrial} />
                    )}
                    {isServer && <ServerFields endpoint={server} served={served} andAdopt={andAdopt}
                      change={(patch) => setServer({ ...server, ...patch })} />}
                  </div>
                </label>
              );
            })}
          </div>
          {chosen === 'browser-only' && <Packs target={target} stamp={packStamp} />}
        </li>

        <li>
          <h2>Try it</h2>
          <Trial chosen={chosen} target={target} notes={notes} stamp={trialStamp}
            fetchedPack={() => setPackStamp((n) => n + 1)} />
        </li>

        <li>
          <h2>Use it anywhere</h2>
          <p>Hold <kbd>{/Mac/.test(navigator.platform) ? '⌘' : 'Super'}</kbd> over an image
            and click the <b>T</b> that appears. Click it again for the original. The toolbar
            button switches models and languages.</p>
        </li>
      </ol>

      <footer>
        <div class="rule">
          <a href="options.html">All settings</a>
          <button type="button" class="primary" onClick={async () => {
            const tab = await chrome.tabs.getCurrent();
            if (tab?.id !== undefined) chrome.tabs.remove(tab.id);
          }}>Done</button>
        </div>
      </footer>
    </>
  );
}

render(<Welcome />, document.getElementById('app')!);
