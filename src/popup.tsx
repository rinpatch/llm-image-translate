import { render } from 'preact';
import { useState } from 'preact/hooks';
import { LANGUAGES } from './core/language.ts';
import { PROVIDERS } from './platform/providers.ts';
import { publicSettings, save, translators } from './platform/settings.ts';
import { useAsync } from './ui/async.ts';
import { Names } from './ui/fields.tsx';

type Picked = Partial<Record<'provider' | 'source' | 'target', string>>;

function Popup() {
  const stored = useAsync(() => Promise.all([publicSettings(), translators()])
    .then(([s, t]) => ({ provider: t.provider, source: s.source, target: s.target })), []);
  const [picked, setPicked] = useState<Picked>({});
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
      <label>
        <span>Translate from</span>
        <Names names={['Auto', ...LANGUAGES]} value={value('source')} onPick={pick('source')} />
      </label>
      <label>
        <span>Translate into</span>
        <Names names={LANGUAGES} value={value('target')} onPick={pick('target')} />
      </label>
      <footer class="rule">
        <a href="#" onClick={(e) => open(e, () => chrome.runtime.openOptionsPage())}>Settings…</a>
        <a href="#" onClick={(e) => open(e, () =>
          chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') }))}>History &amp; Performance…</a>
      </footer>
    </>
  );
}

render(<Popup />, document.getElementById('app')!);
