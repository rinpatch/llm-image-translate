import { render } from 'preact';
import { useState } from 'preact/hooks';
import { LANGUAGES } from './core/language.ts';
import { t } from './platform/i18n.ts';
import { PROVIDERS } from './platform/providers.ts';
import {
  autoSites, publicSettings, save, setAuto, siteOf, translators,
} from './platform/settings.ts';
import { useAsync } from './ui/async.ts';
import { PROVIDER_NAMES } from './ui/choices.tsx';
import { LanguageBox } from './ui/combobox.tsx';
import { Check } from './ui/fields.tsx';
import { setPage } from './ui/text.tsx';

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
        <span>{t('translator')}</span>
        <select value={value('provider')} onChange={(e) => pick('provider')(e.currentTarget.value)}>
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{t(PROVIDER_NAMES[p.id])}</option>)}
        </select>
      </label>
      {/* OpenAI's guidelines want this wherever a request would spend the plan. */}
      {value('provider') === 'chatgpt' && <p class="blurb">{t('usingPlan')}</p>}
      <label>
        <span>{t('translateFrom')}</span>
        <LanguageBox names={['Auto', ...LANGUAGES]} value={value('source')} onPick={pick('source')} />
      </label>
      <label>
        <span>{t('translateInto')}</span>
        <LanguageBox names={LANGUAGES} value={value('target')} onPick={pick('target')} />
      </label>
      {here?.site && (
        <Check label={t('autoHere', here.site)} checked={auto ?? here.on}
          onCheck={(on) => {
            setAutoHere(on);
            setAuto(here.site, on);
          }} />
      )}
      <footer class="rule">
        <a href="#" onClick={(e) => open(e, () => chrome.runtime.openOptionsPage())}>{t('settingsMenu')}</a>
        <a href="#" onClick={(e) => open(e, () =>
          chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') }))}>{t('historyPerformance')}…</a>
      </footer>
    </>
  );
}

setPage(t('extName'));
render(<Popup />, document.getElementById('app')!);
