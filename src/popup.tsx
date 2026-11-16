import { render } from 'preact';
import { useState } from 'preact/hooks';
import { LANGUAGES } from './core/language.ts';
import { PROVIDERS } from './platform/providers.ts';
import {
  autoSites, publicSettings, save, setAuto, siteOf, translators,
} from './platform/settings.ts';
import { useAsync } from './ui/async.ts';
import { NameBox } from './ui/combobox.tsx';
import { Check } from './ui/fields.tsx';

type Picked = Partial<Record<'provider' | 'source' | 'target', string>>;

function Popup() {
  const stored = useAsync(() => Promise.all([publicSettings(), translators()])
    .then(([s, t]) => ({ provider: t.provider, source: s.source, target: s.target })), []);
  const [picked, setPicked] = useState<Picked>({});
  const here = useAsync(() => Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }), autoSites(),
  ]).then(([[tab], sites]) => {
    const site = siteOf(tab?.url);
    return { site, on: sites.includes(site) };
  }), []);
  const [auto, setAutoHere] = useState<boolean>();
  const value = (key: keyof Picked) => picked[key] ?? stored?.[key] ?? '';
  const pick = (key: keyof Picked) => (name: string) => {
    setPicked({ ...picked, [key]: name });
    save(key, name);
  };

  const open = (e: Event, go: () => void) => {
    e.preventDefault();
    go();
  };

  return (
    <>
      <label>
        <span>Translator</span>
        <select value={value('provider')} onChange={(e) => pick('provider')(e.currentTarget.value)}>
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      {/* OpenAI's guidelines want this wherever a request would spend the plan. */}
      {value('provider') === 'chatgpt' && <p class="blurb">Using ChatGPT plan</p>}
      <label>
        <span>Translate from</span>
        <NameBox names={['Auto', ...LANGUAGES]} value={value('source')} onPick={pick('source')} />
      </label>
      <label>
        <span>Translate into</span>
        <NameBox names={LANGUAGES} value={value('target')} onPick={pick('target')} />
      </label>
      {here?.site && (
        <Check label={`Translate images on ${here.site} automatically`} checked={auto ?? here.on}
          onCheck={(on) => {
            setAutoHere(on);
            setAuto(here.site, on);
          }} />
      )}
      <footer class="rule">
        <a href="#" onClick={(e) => open(e, () => chrome.runtime.openOptionsPage())}>Settings…</a>
        <a href="#" onClick={(e) => open(e, () =>
          chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') }))}>History &amp; Performance…</a>
      </footer>
    </>
  );
}

render(<Popup />, document.getElementById('app')!);
