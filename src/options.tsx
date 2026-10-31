import { type ComponentChildren, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { LANGUAGES } from './core/language.ts';
import { OCR_ADAPTERS, TRANSLATE_ADAPTERS, ocrAdapter } from './backends/registry.ts';
import { notesFor } from './content/notes.ts';
import { stagesOf } from './platform/metrics.ts';
import { type ImageResult, type PingResult } from './platform/messages.ts';
import { SHIPPED, type Profile, copyOf, find, newId, uniqueName } from './platform/profiles.ts';
import {
  adapterFor, keyScope, knownModel, onePass, provider, providersFor,
  startOn, twoPass,
} from './platform/providers.ts';
import {
  type Keys, type Role, type Settings, ROLES, keys, profiles, purgeResults, save, saveKey,
  saveProfiles, settings,
} from './platform/settings.ts';
import { Check, Input, Names, Row } from './ui/fields.tsx';
import { ms } from './ui/format.ts';
import { PackStatus } from './ui/packs.tsx';
import {
  type Served, ModelField, adoption, isLlamacpp, servedNote, useServed,
} from './ui/served.tsx';
import { Bar, Legend } from './ui/stages.tsx';
import { NONE, type Note, Status, note } from './ui/status.tsx';

type Endpoint = Profile[Role];
type Edit = (change: (endpoint: Endpoint) => void) => void;

const OTHER = 'other';

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function AdapterPicker({ role, endpoint, served, edit }: {
  role: Role; endpoint: Endpoint; served: Served; edit: Edit;
}) {
  // One pass is the checkbox, so the reader's list is only the plain adapters.
  const options = role === 'reader'
    ? Object.values(OCR_ADAPTERS).filter(({ id }) => twoPass(id) === id)
    : Object.values(TRANSLATE_ADAPTERS);
  return (
    <details>
      <summary>Adapter</summary>
      <Row label="Prompt and reply format">
        <select value={role === 'reader' ? twoPass(endpoint.adapter) : endpoint.adapter}
          onChange={(e) => {
            const adapter = e.currentTarget.value;
            edit((endpoint) => {
              const translating = role === 'reader' && twoPass(endpoint.adapter) !== endpoint.adapter;
              endpoint.adapter = translating ? onePass(adapter) || adapter : adapter;
            });
          }}>
          {options.map(({ id, label }) => (
            // Unknown is not no: a server that is down may well be llama.cpp.
            <option value={id} disabled={id === 'gemma-raw' && served !== undefined
              && !isLlamacpp(served)}>{label}</option>
          ))}
        </select>
      </Row>
      <p class="blurb">Picked from the model. Change it for a model that answers in a
        different shape.</p>
    </details>
  );
}

function Pack({ target, initial }: { target: string; initial: string }) {
  const names = LANGUAGES.filter((name) => name !== target);
  const [picked, setPicked] = useState(initial);
  const source = names.includes(picked) ? picked
    : names.includes('Japanese') ? 'Japanese' : names[0];
  return (
    <div>
      <Row label="Language pack"><Names names={names} value={source} onPick={setPicked} /></Row>
      <div class="buttons pack"><PackStatus source={source} target={target} /></div>
      <p class="blurb">Chrome translates on this machine, one pair of languages at a
        time. Each pair is downloaded once, from here.</p>
    </div>
  );
}

/**
 * Where a role runs: the provider, the server, the model, the key. `afterModel`
 * and `children` are what one role has and the other does not.
 */
function EndpointFields({ role, endpoint, fresh, edit, setKey, afterModel, children }: {
  role: Role;
  endpoint: Endpoint;
  /** Made just now, so take whatever model its server serves. */
  fresh: boolean;
  edit: Edit;
  setKey: (key: string) => void;
  afterModel?: ComponentChildren;
  children?: ComponentChildren;
}) {
  const p = provider(endpoint.provider);
  const [focused, setFocused] = useState(false);
  const served = useServed(endpoint, p.id === 'server' || focused);
  const known = p.models[role] || [];
  const match = knownModel(role, endpoint);
  const host = hostOf(endpoint.baseUrl);
  const said = servedNote(role, endpoint, served);

  // Only after the server or the key changes: merely looking at a profile does
  // not rewrite it.
  const adopting = useRef(fresh);
  useEffect(() => {
    if (!adopting.current) return;
    if (endpoint.provider === 'server' && endpoint.baseUrl && served === undefined) return;
    adopting.current = false;
    const adopt = adoption(role, endpoint, served);
    if (adopt) edit(adopt);
  });
  const andAdopt = (change: () => void) => {
    adopting.current = true;
    change();
  };

  // Focused once the redraw has shown the field.
  const focusModel = useRef(false);
  useEffect(() => {
    if (!focusModel.current) return;
    focusModel.current = false;
    document.getElementById(`${role}-model`)?.focus();
  });

  return (
    <>
      <Row label="Runs on">
        <select value={p.id} onChange={(e) => {
          const id = e.currentTarget.value;
          andAdopt(() => edit((endpoint) => Object.assign(endpoint, startOn(role, id))));
        }}>
          {/* In-browser reading is the method picker's, not one more place to run a model. */}
          {providersFor(role).filter((one) => role === 'translator' || one.id !== 'browser')
            .map((one) => <option value={one.id}>{one.label}</option>)}
        </select>
      </Row>
      {p.editUrl && (
        <Row label="Server">
          {/* On change rather than per keystroke: a half-typed URL is not worth storing. */}
          <Input type="url" value={endpoint.baseUrl}
            placeholder={p.baseUrl[role] || 'https://example.com/v1'}
            onCommit={(url) => andAdopt(() => edit((endpoint) => { endpoint.baseUrl = url.trim(); }))} />
        </Row>
      )}
      {/* The browser has the one translator, so there is nothing to pick. */}
      {known.length > 0 && p.id !== 'browser' && (
        <Row label="Model">
          <select value={match ? String(known.indexOf(match)) : OTHER} onChange={(e) => {
            const picked = known[Number(e.currentTarget.value)];
            if (!picked) focusModel.current = true;
            edit((endpoint) => {
              endpoint.model = picked?.model || '';
              endpoint.adapter = adapterFor(role, endpoint, picked, isLlamacpp(served));
            });
          }}>
            {known.map((k, i) => <option value={String(i)}>{k.name}</option>)}
            <option value={OTHER}>Another model…</option>
          </select>
        </Row>
      )}
      {!match && (
        <Row label={known.length ? 'Model id' : 'Model'}>
          <ModelField id={`${role}-model`} role={role} endpoint={endpoint} served={served}
            fallback={p.lists ? 'Start typing to search' : ''} onFocus={() => setFocused(true)}
            onCommit={(model) => edit((endpoint) => {
              endpoint.model = model.trim();
              const picked = known.find((k) => k.model === endpoint.model);
              endpoint.adapter = adapterFor(role, endpoint, picked, isLlamacpp(served));
            })} />
        </Row>
      )}
      {said.text && <div class="served"><Status of={said} /></div>}
      {afterModel}
      {p.key !== 'none' && <>
        <Row label="API key">
          <Input type="password" autocomplete="off" value={endpoint.apiKey}
            placeholder={p.key === 'optional' ? 'Only if the server asks for one' : ''}
            onCommit={(key) => andAdopt(() => setKey(key.trim()))} />
        </Row>
        {/* Sharing is worth saying only where there is a key to share. */}
        {host && (p.key !== 'optional' || endpoint.apiKey) && (
          <p class="blurb">Kept for {host}, so every profile using it shares the key.</p>
        )}
      </>}
      {children}
      <AdapterPicker role={role} endpoint={endpoint} served={served} edit={edit} />
    </>
  );
}

// What the reader was before it went to the browser, per profile, so flipping
// the method back and forth does not throw away a model and a URL. Only for as
// long as the page is open.
const lastModel = new Map<string, Endpoint>();

interface RoleProps {
  profile: Profile;
  fresh: boolean;
  status: Note;
  edit: Edit;
  setKey: (key: string) => void;
}

function Reader({ profile, fresh, status, edit, setKey }: RoleProps) {
  const endpoint = profile.reader;
  const inBrowser = endpoint.provider === 'browser';
  const plain = twoPass(endpoint.adapter);
  // Back from the browser is a change of server, so it adopts like one.
  const switched = useRef(false);
  return (
    <section>
      <h2>Reader</h2>
      <p class="blurb">Finds the text in the image and reads it.</p>
      <Row label="Method">
        <select value={inBrowser ? 'browser' : 'vlm'} onChange={(e) => {
          const toBrowser = e.currentTarget.value === 'browser';
          switched.current = !toBrowser;
          if (toBrowser) lastModel.set(profile.id, { ...endpoint });
          edit((endpoint) => Object.assign(endpoint, toBrowser ? startOn('reader', 'browser')
            : lastModel.get(profile.id) || startOn('reader', 'server')));
        }}>
          <option value="browser">PP-OCR in this browser</option>
          <option value="vlm">Vision language model</option>
        </select>
      </Row>
      {!inBrowser && (
        <EndpointFields role="reader" endpoint={endpoint} fresh={fresh || switched.current} edit={edit} setKey={setKey}>
          {onePass(plain) && <>
            <Check label="Translate while reading" checked={plain !== endpoint.adapter}
              onCheck={(on) => edit((endpoint) => {
                endpoint.adapter = on ? onePass(plain) || plain : plain;
              })} />
            <p class="blurb">One request per image, and the model sees the page as it
              translates. No separate translator is used.</p>
          </>}
        </EndpointFields>
      )}
      <Status of={status} />
    </section>
  );
}

function Translator({ profile, fresh, status, edit, setKey, target, source }:
  RoleProps & { target: string; source: string }) {
  const endpoint = profile.translator;
  return (
    <section>
      <h2>Translator</h2>
      <p class="blurb">Turns what the reader found into the target language.</p>
      <EndpointFields role="translator" endpoint={endpoint} fresh={fresh} edit={edit} setKey={setKey}
        afterModel={endpoint.adapter === 'chrome-translator'
          && <Pack target={target} initial={source} />} />
      <Status of={status} />
    </section>
  );
}

function ProfilePicker({ list, active, switchTo, rename }: {
  list: Profile[]; active: Profile;
  switchTo: (profile: Profile, list: Profile[], fresh?: boolean) => void;
  rename: (name: string) => void;
}) {
  // Two clicks, because there is no undo.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <section>
      <h2>Profile</h2>
      <p class="blurb">A reader and a translator under one name, switchable from the popup.</p>
      <Row label="In use">
        <select value={active.id}
          onChange={(e) => switchTo(find(list, e.currentTarget.value) || list[0], list)}>
          {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Row>
      <Row label="Name">
        <Input key={active.id} type="text" id="profile-name" value={active.name} onCommit={rename} />
      </Row>
      <div class="buttons">
        <button type="button" onClick={() => {
          const blank: Profile = {
            id: newId(),
            name: uniqueName(list, 'New profile'),
            reader: startOn('reader', 'server'),
            translator: startOn('translator', 'server'),
          };
          switchTo(blank, [...list, blank], true);
        }}>New</button>
        <button type="button" onClick={() => {
          const copy = copyOf(list, active);
          switchTo(copy, [...list, copy]);
        }}>Duplicate</button>
        <button type="button" disabled={list.length < 2} onClick={() => {
          if (!armed) return setArmed(true);
          setArmed(false);
          const rest = list.filter((p) => p !== active);
          switchTo(rest[0], rest);
        }}>{armed ? 'Delete for good?' : 'Delete'}</button>
      </div>
    </section>
  );
}

/** The result's notes, in a shadow root so their class names cannot meet this page's styles. */
function NotesLayer({ result }: { result: Extract<ImageResult, { ok: true }> }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = host.current!.shadowRoot || host.current!.attachShadow({ mode: 'open' });
    const layer = notesFor(result.blocks, result.width!, result.height!);
    Object.assign(layer.style, { left: '0', top: '0', width: '100%', height: '100%' });
    root.replaceChildren(layer);
  }, [result]);
  return <div id="try-notes" ref={host} />;
}

/** The first role that cannot run without a key it does not have. */
function missingKey(active: Profile): Role | undefined {
  const used = ocrAdapter(active.reader.adapter).capabilities.alsoTranslates
    ? ['reader' as const] : ROLES;
  return used.find((role) =>
    provider(active[role].provider).key === 'required' && !active[role].apiKey);
}

// The trial run. It goes through the worker exactly as a page's image would, so
// what it reports is what the badge would do with this profile.
function Trial({ active, notes, target }: { active: Profile; notes: boolean; target: string }) {
  const [job, setJob] = useState('');
  const [told, setTold] = useState<Note>(NONE);
  const [result, setResult] = useState<Extract<ImageResult, { ok: true }> | null>(null);
  const [original, setOriginal] = useState(false);
  const [dropping, setDropping] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // Any edit makes the last result someone else's, unless it is still running.
  useEffect(() => {
    if (job) return;
    setResult(null);
    setTold(NONE);
  }, [active]);

  const trial = async (src: string, dataUrl?: string) => {
    if (job) return;
    // Otherwise the answer is a bare 401 from a request that was never going to work.
    const keyless = missingKey(active);
    if (keyless) {
      setTold(note(`The ${keyless} needs an API key for ${hostOf(active[keyless].baseUrl)}.`, 'bad'));
      return;
    }
    const jobId = crypto.randomUUID();
    setJob(jobId);
    const started = Date.now();
    const tick = setInterval(() => setTold(note(`Translating… ${ms(Date.now() - started)}`)), 100);
    setTold(note('Translating…'));

    let answer: ImageResult;
    try {
      answer = await chrome.runtime.sendMessage(
        { type: 'translateImage', jobId, src, dataUrl, fresh: true });
    } catch (e: any) {
      answer = { ok: false, error: String(e?.message || e) };
    } finally {
      clearInterval(tick);
      setJob('');
    }

    if (!answer.ok) {
      setResult(null);
      setTold(answer.code === 'cancelled' ? note('Stopped.') : note(answer.error, 'bad'));
      return;
    }
    const stages = stagesOf(answer.timings);
    const total = answer.timings.total_ms || stages.reduce((n, s) => n + s.ms, 0);
    const shown = answer.blocks.filter((b) => !b.skipped).length;
    setResult(answer);
    setOriginal(false);
    setTold(answer.image
      ? note(`${shown} of ${answer.blocks.length} blocks translated in ${ms(total)}.`, 'ok')
      : note(`No text found (${ms(total)}).`));
  };

  const trialFile = async (picked: File | undefined | null) => {
    if (!picked || !picked.type.startsWith('image/')) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(picked);
    });
    // The name is only what the history shows; the bytes are in the data URL.
    await trial(picked.name || 'pasted image', dataUrl);
  };

  // Only an image on the clipboard: pasting a key into a field is still a paste.
  const onPaste = useRef<(e: ClipboardEvent) => void>(null);
  onPaste.current = (e) => {
    const pasted = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!pasted) return;
    e.preventDefault();
    trialFile(pasted);
  };
  useEffect(() => {
    const listener = (e: ClipboardEvent) => onPaste.current!(e);
    document.addEventListener('paste', listener);
    return () => document.removeEventListener('paste', listener);
  }, []);

  const stages = result ? stagesOf(result.timings) : [];
  const total = result ? result.timings.total_ms || stages.reduce((n, s) => n + s.ms, 0) : 0;
  // The result the way a page would show it, which depends on the notes setting.
  const asNotes = Boolean(notes && result?.width && result.height && result.original);

  return (
    <section id="try" class={dropping ? 'dropping' : ''}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        trialFile(e.dataTransfer?.files[0]);
      }}>
      <h2>Try it</h2>
      <p class="blurb">Runs this profile on one image, into {target}. An image dropped or
        pasted on this page works too.</p>
      <div class="buttons">
        <button type="button" disabled={Boolean(job)}
          onClick={() => trial(chrome.runtime.getURL('sample.jpg'))}>Sample page</button>
        <button type="button" disabled={Boolean(job)}
          onClick={() => file.current!.click()}>Choose an image…</button>
        {job && <button type="button" onClick={() =>
          chrome.runtime.sendMessage({ type: 'cancelImage', jobId: job })}>Stop</button>}
        <input type="file" ref={file} accept="image/*" hidden onChange={(e) => {
          trialFile(e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }} />
      </div>
      <Status of={told} live />
      {result?.image && (
        <div>
          <div id="try-stages">
            <Bar stages={stages} scale={total} tall />
            <Legend stages={stages} />
          </div>
          <div id="try-frame">
            <img id="try-image" alt=""
              src={((original || asNotes ? result.original : null) || result.image) as string} />
            {asNotes && !original && <NotesLayer result={result} />}
          </div>
          <Check label="Show the original" checked={original} onCheck={setOriginal} />
          <ol id="try-blocks">
            {result.blocks.map((b) => (
              <li>
                <div class="src">{b.src}</div>
                {b.skipped
                  ? <div class="skipped">Left alone: {b.skipped}</div>
                  : <div>{b.translation}</div>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function Toggle({ on, set, label, children }: {
  on: boolean; set: (on: boolean) => void; label: string; children: ComponentChildren;
}) {
  return <>
    <Check label={label} checked={on} onCheck={set} />
    <p class="blurb">{children}</p>
  </>;
}

function PurgeButton() {
  const [said, setSaid] = useState('');
  return (
    <button type="button" aria-live="polite" disabled={Boolean(said)} onClick={async () => {
      try {
        await purgeResults();
        setSaid('Cache cleared');
      } catch {
        setSaid('Could not clear cache');
      }
      setTimeout(() => setSaid(''), 1500);
    }}>{said || 'Clear cache'}</button>
  );
}

function Options() {
  const [list, setList] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState(SHIPPED[0].id);
  const [keyring, setKeyring] = useState<Keys>({});
  const [stored, setStored] = useState<Settings | null>(null);
  const [fresh, setFresh] = useState('');
  const [tested, setTested] = useState<Partial<Record<Role, Note>>>({});

  useEffect(() => {
    Promise.all([settings(), profiles(), keys()]).then(([s, { list, active }, k]) => {
      setStored(s);
      setList(list);
      setActiveId(active.id);
      setKeyring(k);
    });
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.notes || changes.target) {
        setStored((s) => s && {
          ...s,
          ...(changes.notes && { notes: Boolean(changes.notes.newValue) }),
          ...(changes.target && { target: String(changes.target.newValue) }),
        });
      }
    };
    chrome.storage.sync.onChanged.addListener(listener);
    return () => chrome.storage.sync.onChanged.removeListener(listener);
  }, []);

  const active = find(list, activeId) || list[0];

  // Every change to the list or the choice is written back from here, so edits
  // that land together are saved together. Not on the render that loaded them.
  const loaded = useRef(false);
  useEffect(() => { if (loaded.current) saveProfiles(list); }, [list]);
  // After the list: an active id naming a profile nobody has stored yet reads
  // back as no profile at all. Storage applies the two writes in order.
  useEffect(() => { if (loaded.current) save('profile', activeId); }, [activeId]);
  useEffect(() => { if (list.length) loaded.current = true; }, [list]);

  // A test's answer is about the endpoint it asked, so an edit to a role clears it.
  useEffect(() => setTested((t) => ({ ...t, reader: undefined })), [active?.reader]);
  useEffect(() => setTested((t) => ({ ...t, translator: undefined })), [active?.translator]);

  useEffect(() => {
    if (fresh) (document.getElementById('profile-name') as HTMLInputElement | null)?.select();
  }, [fresh]);

  if (!active || !stored) return null;

  const switchTo = (profile: Profile, next: Profile[], made = false) => {
    setFresh(made ? profile.id : '');
    setList(next);
    setActiveId(profile.id);
  };

  const replace = (id: string, change: (profile: Profile) => Profile) =>
    setList((now) => now.map((p) => (p.id === id ? change(p) : p)));

  /**
   * Changes one role's endpoint on a copy. Against the list as it is by then
   * rather than as this render saw it: both roles adopt a model when their
   * servers answer, and the two answers can land in one render.
   */
  const edit = (role: Role) => (change: (endpoint: Endpoint) => void) =>
    replace(active.id, (profile) => {
      const endpoint = { ...profile[role] };
      change(endpoint);
      endpoint.apiKey = keyring[keyScope(endpoint.baseUrl)] || '';
      return { ...profile, [role]: endpoint };
    });

  const setKey = (role: Role) => async (key: string) => {
    const { baseUrl } = active[role];
    await saveKey(baseUrl, key);
    setKeyring(await keys());
    setList((now) => now.map((profile) => {
      const copy = { ...profile };
      for (const r of ROLES) {
        if (keyScope(profile[r].baseUrl) === keyScope(baseUrl)) copy[r] = { ...profile[r], apiKey: key };
      }
      return copy;
    }));
  };

  const test = async () => {
    setTested({ reader: note('Checking…'), translator: note('Checking…') });
    const ping: PingResult = await chrome.runtime.sendMessage({ type: 'ping' });
    setTested({
      reader: ping.reader ? note(ping.reader, 'bad') : note('Answered.', 'ok'),
      translator: ping.translator ? note(ping.translator, 'bad') : note('Answered.', 'ok'),
    });
  };

  const flag = (key: 'images' | 'notes' | 'debug') => (on: boolean) => {
    setStored({ ...stored, [key]: on });
    save(key, on);
  };

  const translates = ocrAdapter(active.reader.adapter).capabilities.alsoTranslates;
  const roleProps = (r: Role) => ({
    profile: active, fresh: fresh === active.id,
    status: tested[r] || NONE, edit: edit(r), setKey: setKey(r),
  });

  return (
    <>
      <h1>Image Translate</h1>
      <p class="blurb">A reader finds the text, a translator translates it.</p>

      <ProfilePicker list={list} active={active} switchTo={switchTo}
        rename={(name) => replace(active.id, (profile) => ({
          ...profile,
          name: uniqueName(list.filter((p) => p.id !== profile.id), name.trim() || 'Unnamed'),
        }))} />

      {/* Keyed by profile, so switching starts each section over. Written out
          rather than spread: Preact only reads a key given as an attribute. */}
      <Reader key={`${active.id}-reader`} {...roleProps('reader')} />
      {!translates && (
        <Translator key={`${active.id}-translator`} {...roleProps('translator')}
          target={stored.target} source={stored.source} />
      )}

      <Trial active={active} notes={stored.notes} target={stored.target} />

      <section>
        <h2>Pages</h2>
        <Toggle on={stored.images} set={flag('images')} label="Show a badge on images">
          The badge appears while ⌘ is held (Super on Windows and Linux).
        </Toggle>
        <Toggle on={stored.notes} set={flag('notes')}
          label="Show translations as Danbooru-style notes">
          Leaves the image as it is and puts a box over each piece of text; hover one to read
          its translation.
        </Toggle>
        <Toggle on={stored.debug} set={flag('debug')} label="Debug mode">
          Logs every stage to the console and keeps the last few images
          for <a href="debug.html">Regions</a>.
        </Toggle>
      </section>

      <footer>
        <div class="rule">
          <div class="buttons">
            <button type="button" onClick={test}>
              {translates ? 'Test the endpoint' : 'Test both endpoints'}
            </button>
            <PurgeButton />
          </div>
          <span><a href="welcome.html">Setup guide</a> · <a href="stats.html">Timings and history →</a></span>
        </div>
      </footer>
    </>
  );
}

render(<Options />, document.getElementById('app')!);
