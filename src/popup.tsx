import { render } from 'preact';
import { useState } from 'preact/hooks';
import { LANGUAGES } from './core/language.ts';
import { profiles, publicSettings, save } from './platform/settings.ts';
import { useAsync } from './ui/async.ts';
import { Names } from './ui/fields.tsx';

type Picked = Partial<Record<'profile' | 'source' | 'target', string>>;

function Popup() {
  const stored = useAsync(() => Promise.all([publicSettings(), profiles()])
    .then(([s, { list, active }]) => ({ list, profile: active.id, source: s.source, target: s.target })), []);
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
        <span>Models</span>
        <select value={value('profile')} onChange={(e) => pick('profile')(e.currentTarget.value)}>
          {stored?.list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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
          chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') }))}>Timings…</a>
      </footer>
    </>
  );
}

render(<Popup />, document.getElementById('app')!);
