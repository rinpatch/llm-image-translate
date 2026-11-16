// The first-run page, opened by the worker on install. It picks among a few
// setups, checks the one chosen answers, then shows how to use the badge on the
// sample; anything finer is the settings page's.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { LANGUAGES } from './core/language.ts';
import { type PingResult } from './platform/messages.ts';
import { blocker } from './platform/ready.ts';
import { publicSettings, save } from './platform/settings.ts';
import { Choices } from './ui/choices.tsx';
import { Display } from './ui/display.tsx';
import { NameBox } from './ui/combobox.tsx';
import { downloadPack, fetchingNote, packState, stalledNote } from './ui/packs.tsx';
import { NONE, type Note, Status, note } from './ui/status.tsx';
import { useTranslator } from './ui/translator.ts';

// What sample.jpg is written in.
const SAMPLE = 'Japanese';
const SAMPLE_URL = chrome.runtime.getURL('sample.jpg');
const MODIFIER = /Mac/.test(navigator.platform) ? '⌘' : 'Super';

function Welcome() {
  const translator = useTranslator();
  const active = translator.translator;
  const [target, setTarget] = useState('English');
  const [notes, setNotes] = useState(false);
  const [packStamp, setPackStamp] = useState(0);
  const [checking, setChecking] = useState(false);
  const [told, setTold] = useState<Note>(NONE);
  const [screen, setScreen] = useState<'setup' | 'use'>('setup');

  useEffect(() => {
    publicSettings().then((s) => {
      setTarget(s.target);
      setNotes(s.notes);
    });
  }, []);
  // Anything changed since the last check makes its verdict out of date.
  useEffect(() => setTold(NONE), [active, target]);

  const check = async () => {
    if (!active) return;
    setChecking(true);
    try {
      const blocked = blocker(active);
      if (blocked) return setTold(note(blocked, 'bad'));
      // Chrome only fetches a pack on a click, and this is one. The sample's
      // pack, so the next screen has something to translate.
      if (active.provider === 'browser' && SAMPLE !== target
        && await packState(SAMPLE, target) !== 'available') {
        setTold(fetchingNote(undefined, SAMPLE));
        await downloadPack(SAMPLE, target, (done) => setTold(fetchingNote(done, SAMPLE)),
          () => setTold(stalledNote));
        setPackStamp((n) => n + 1);
      }
      setTold(note('Checking…'));
      const ping: PingResult = await chrome.runtime.sendMessage({ type: 'ping' });
      if (ping.error) {
        return setTold(note(ping.error[0].toUpperCase() + ping.error.slice(1), 'bad'));
      }
      setTold(NONE);
      setScreen('use');
    } catch (e: any) {
      setTold(note(String(e?.message || e), 'bad'));
    } finally {
      setChecking(false);
    }
  };

  const hero = (
    <header class="hero">
      <img src="icons/128.png" alt="" />
      <div>
        <h1>LLM Image Translate</h1>
      </div>
    </header>
  );

  if (screen === 'use') {
    return (
      <>
        {hero}
        <section class="use">
          <h2>Try it out</h2>
          <p>Hold <kbd>{MODIFIER}</kbd> over the image and click the <b>T</b> that appears,
            the same as on any page. Click it again for the original. The toolbar button
            switches models and languages.</p>
          <img class="practice" src={SAMPLE_URL} alt="A page of Japanese text in speech bubbles" />
        </section>

        <footer>
          <div class="rule">
            <a href="options.html">All settings</a>
            <div class="buttons">
              <button type="button" onClick={() => setScreen('setup')}>Back</button>
              <button type="button" class="primary" onClick={async () => {
                const tab = await chrome.tabs.getCurrent();
                if (tab?.id !== undefined) chrome.tabs.remove(tab.id);
              }}>Done</button>
            </div>
          </div>
        </footer>
      </>
    );
  }

  return (
    <>
      {hero}

      <ol class="steps">
        <li>
          <h2>Translate into</h2>
          <NameBox id="target" aria-label="Translate into" names={LANGUAGES} value={target}
            onPick={(name) => {
              setTarget(name);
              save('target', name);
            }} />
        </li>

        <li>
          <h2>Pick the translation model</h2>
          <Choices translator={translator} target={target} packStamp={packStamp} />
        </li>

        <li>
          <h2>Show translations</h2>
          <Display notes={notes} onPick={(on) => {
            setNotes(on);
            save('notes', on);
          }} />
        </li>
      </ol>

      <footer>
        <div class="rule">
          <a href="options.html">All settings</a>
          <div class="check">
            <Status of={told} live />
            <button type="button" class="primary" disabled={checking || !active}
              onClick={check}>Test and continue</button>
          </div>
        </div>
      </footer>
    </>
  );
}

render(<Welcome />, document.getElementById('app')!);
