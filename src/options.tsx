import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { LANGUAGES } from './core/language.ts';
import { languageName, t } from './platform/i18n.ts';
import { alongside, stagesOf } from './platform/metrics.ts';
import { type PingResult } from './platform/messages.ts';
import { blocker } from './platform/ready.ts';
import {
  type EndpointSettings, type Settings, purgeResults, save, settings,
} from './platform/settings.ts';
import { Choices } from './ui/choices.tsx';
import { Display } from './ui/display.tsx';
import { LanguageBox } from './ui/combobox.tsx';
import { Row, Toggle } from './ui/fields.tsx';
import { Hero } from './ui/hero.tsx';
import { Bar, Legend } from './ui/stages.tsx';
import { NONE, type Note, Status, note } from './ui/status.tsx';
import { TrialImage, totalOf, useTrial } from './ui/trial.tsx';
import { setPage, tx } from './ui/text.tsx';
import { useTranslator } from './ui/translator.ts';

function Trial({ translator, notes, target }: {
  translator: EndpointSettings; notes: boolean; target: string;
}) {
  const trial = useTrial();
  const [dropping, setDropping] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => trial.forget(), [translator]);

  const trialFile = async (picked: File | undefined | null) => {
    if (!picked || !picked.type.startsWith('image/')) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(picked);
    });
    // The name is only what the history shows; the bytes are in the data URL.
    await trial.run(picked.name || t('pastedImage'), dataUrl);
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

  const { result } = trial;
  const stages = result ? stagesOf(result.timings) : [];
  const spans = result ? alongside(result.timings) : [];

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
      <h2>{t('tryIt')}</h2>
      <p class="blurb">{t('tryBlurb', languageName(target))}</p>
      <div class="buttons">
        <button type="button" disabled={trial.busy}
          onClick={() => trial.run(chrome.runtime.getURL('sample.jpg'))}>{t('samplePage')}</button>
        <button type="button" disabled={trial.busy}
          onClick={() => file.current!.click()}>{t('chooseImage')}</button>
        {trial.running && <button type="button" onClick={trial.cancel}>{t('stop')}</button>}
        <input type="file" ref={file} accept="image/*" hidden onChange={(e) => {
          trialFile(e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }} />
      </div>
      <Status of={trial.told} live />
      {result?.image && (
        <div>
          <div id="try-stages">
            <Bar stages={stages} scale={totalOf(result)} tall spans={spans} />
            <Legend stages={stages} spans={spans} />
          </div>
          <TrialImage result={result} notes={notes} />
          <ol id="try-blocks">
            {result.blocks.map((b) => (
              <li>
                <div class="src">{b.src}</div>
                {b.skipped
                  ? <div class="skipped">{t('leftAlone', b.skipped)}</div>
                  : <div>{b.translation}</div>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function PurgeButton() {
  const [said, setSaid] = useState('');
  return (
    <button type="button" aria-live="polite" disabled={Boolean(said)} onClick={async () => {
      try {
        await purgeResults();
        setSaid(t('cacheCleared'));
      } catch {
        setSaid(t('cacheNotCleared'));
      }
      setTimeout(() => setSaid(''), 1500);
    }}>{said || t('clearCache')}</button>
  );
}

function Options() {
  const translator = useTranslator();
  const [stored, setStored] = useState<Settings | null>(null);
  const [tested, setTested] = useState<Note>(NONE);

  useEffect(() => {
    settings().then(setStored);
    // The toolbar button changes these too, while this page is open.
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      const picked = Object.fromEntries((['notes', 'source', 'target'] as const)
        .filter((key) => changes[key]).map((key) => [key, changes[key].newValue]));
      setStored((s) => s && { ...s, ...picked });
    };
    chrome.storage.sync.onChanged.addListener(listener);
    return () => chrome.storage.sync.onChanged.removeListener(listener);
  }, []);

  // A test's answer is about the translator it asked.
  useEffect(() => setTested(NONE), [translator.translator]);

  if (!translator.translator || !stored) return null;

  const test = async () => {
    // OpenRouter lists its models for anyone, so a missing key would pass.
    const blocked = blocker(translator.translator!);
    if (blocked) return setTested(note(blocked, 'bad'));
    setTested(note(t('checking')));
    const ping: PingResult = await chrome.runtime.sendMessage({ type: 'ping' });
    setTested(ping.error ? note(ping.error[0].toUpperCase() + ping.error.slice(1), 'bad')
      : note(t('answered'), 'ok'));
  };

  const pick = (key: 'source' | 'target') => (name: string) => {
    setStored({ ...stored, [key]: name });
    save(key, name);
  };

  const flag = (key: 'images' | 'notes' | 'debug') => (on: boolean) => {
    setStored({ ...stored, [key]: on });
    save(key, on);
  };

  return (
    <>
      <Hero />

      <section>
        <h2>{t('languages')}</h2>
        <Row label={t('translateFrom')}>
          <LanguageBox names={['Auto', ...LANGUAGES]} value={stored.source} onPick={pick('source')} />
        </Row>
        <Row label={t('translateInto')}>
          <LanguageBox names={LANGUAGES} value={stored.target} onPick={pick('target')} />
        </Row>
      </section>

      <section>
        <h2>{t('translator')}</h2>
        <Choices translator={translator} target={stored.target} />
      </section>

      <Trial translator={translator.translator} notes={stored.notes} target={stored.target} />

      <section>
        <h2>{t('pages')}</h2>
        <Row div label={t('showTranslations')}>
          <Display notes={stored.notes} onPick={flag('notes')} />
        </Row>
        <Toggle on={stored.images} set={flag('images')} label={t('showBadge')}>
          {t('showBadgeHint')}
        </Toggle>
        <Toggle on={stored.debug} set={flag('debug')} label={t('debugMode')}>
          {tx('debugHint', <a href="debug.html">{t('regions')}</a>)}
        </Toggle>
      </section>

      <footer>
        <div class="rule">
          <div class="buttons">
            <button type="button" onClick={test}>{t('test')}</button>
            <PurgeButton />
            <Status of={tested} live />
          </div>
          <span><a href="welcome.html">{t('setupGuide')}</a> · <a href="stats.html">{t('historyPerformance')} →</a></span>
        </div>
      </footer>
    </>
  );
}

setPage(t('titleSettings'));
render(<Options />, document.getElementById('app')!);
