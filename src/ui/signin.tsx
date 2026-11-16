// Signing in to ChatGPT for the plan provider. It runs here rather than in the
// worker: it takes as long as the user does, and an idle worker is evicted after
// thirty seconds, while this page stays open for as long as they are at it.
import { useEffect, useRef, useState } from 'preact/hooks';
import { beginSignIn, completeSignIn, signOut, signedInAs, watchTab, welcomeOnce }
  from '../platform/chatgpt.ts';
import { t } from '../platform/i18n.ts';
import { useAsync } from './async.ts';
import { Input, Row } from './fields.tsx';
import { NONE, type Note, Status, note } from './status.tsx';
import { tx } from './text.tsx';

// The wording, the logo and the usage link are all OpenAI's, from
// https://developers.openai.com/siwc/ui-ux-guidelines
const USAGE = 'https://chatgpt.com/settings/usage';
const LOGO = <img class="chatgpt-logo" src="icons/chatgpt.svg" alt="" width="18" height="18" />;

/**
 * `token` is the stored one, so being signed in is whatever storage says.
 * `div` for inside another label, as on the setup cards.
 */
export function SignIn({ token, setKey, div }: {
  token: string; setKey: (key: string) => void; div?: boolean;
}) {
  const [waiting, setWaiting] = useState(false);
  const [said, setSaid] = useState<Note>(NONE);
  const attempt = useRef<AbortController | null>(null);
  const welcome = useRef<HTMLDialogElement>(null);
  // Where a pasted address goes while the tab is out.
  const paste = useRef<(url: string) => void>(() => {});
  const email = useAsync(() => signedInAs(), [token]);
  useEffect(() => () => attempt.current?.abort(), []);

  const start = async () => {
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setWaiting(true);
    setSaid(note(t('finishSignIn')));
    try {
      const pending = await beginSignIn();
      const pasted = new Promise<string>((resolve) => { paste.current = resolve; });
      const tab = new AbortController();
      const url = await Promise.race(
        [watchTab(pending, AbortSignal.any([controller.signal, tab.signal])), pasted]);
      tab.abort();
      setSaid(note(t('signingIn')));
      setKey(await completeSignIn(pending, url));
      setSaid(NONE);
      if (await welcomeOnce()) welcome.current?.showModal();
    } catch (e: any) {
      setSaid(controller.signal.aborted ? NONE : note(String(e?.message || e), 'bad'));
    } finally {
      if (attempt.current === controller) {
        attempt.current = null;
        setWaiting(false);
      }
    }
  };

  const body = token && !waiting
    ? (
      <div class="field">
        <span>{t('account')}</span>
        <div class="signed">
          <Status span of={note(email ? t('usingPlanAs', email) : t('usingPlan'), 'ok')} />
          <a href={USAGE} target="_blank">{t('manageUsage')}</a>
          <button type="button" class="link" onClick={async () => { await signOut(); setKey(''); }}>
            {t('signOut')}
          </button>
        </div>
      </div>
    )
    : (
      <>
        <div class="field">
          <span>{t('account')}</span>
          <div class="buttons">
            {waiting
              ? <button type="button" onClick={() => attempt.current?.abort()}>{t('cancel')}</button>
              : <button type="button" class="chatgpt" onClick={start}>
                {LOGO}{t('continueChatgpt')}</button>}
          </div>
        </div>
        <Status of={said} live />
        {waiting && (
          <Row div={div} label={t('pasteCallback')}>
            <Input type="url" value="" autocomplete="off" spellcheck={false}
              placeholder="http://127.0.0.1:…/callback?code=…"
              onCommit={(url) => paste.current(url.trim())} />
          </Row>
        )}
      </>
    );
  // Outside both branches, so signing in swapping one for the other leaves it open.
  return (
    <>
      {body}
      <dialog ref={welcome} class="welcome">
        <h2>{t('planWelcomeTitle')}</h2>
        <p>{tx('planWelcomeBody', <a href={USAGE} target="_blank">{t('chatgptSettings')}</a>)}</p>
        <form method="dialog"><button class="primary">{t('gotIt')}</button></form>
      </dialog>
    </>
  );
}
