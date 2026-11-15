// Signing in to ChatGPT for the plan provider. It runs here rather than in the
// worker: it takes as long as the user does, and an idle worker is evicted after
// thirty seconds, while this page stays open for as long as they are at it.
import { useEffect, useRef, useState } from 'preact/hooks';
import { beginSignIn, completeSignIn, signOut, signedInAs, watchTab }
  from '../platform/chatgpt.ts';
import { useAsync } from './async.ts';
import { Input, Row } from './fields.tsx';
import { NONE, type Note, Status, note } from './status.tsx';

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
  // Where a pasted address goes while the tab is out.
  const paste = useRef<(url: string) => void>(() => {});
  const email = useAsync(() => signedInAs(), [token]);
  useEffect(() => () => attempt.current?.abort(), []);

  const start = async () => {
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setWaiting(true);
    setSaid(note('Finish signing in in the new tab…'));
    try {
      const pending = await beginSignIn();
      const pasted = new Promise<string>((resolve) => { paste.current = resolve; });
      const tab = new AbortController();
      const url = await Promise.race(
        [watchTab(pending, AbortSignal.any([controller.signal, tab.signal])), pasted]);
      tab.abort();
      setSaid(note('Signing in…'));
      setKey(await completeSignIn(pending, url));
      setSaid(NONE);
    } catch (e: any) {
      setSaid(controller.signal.aborted ? NONE : note(String(e?.message || e), 'bad'));
    } finally {
      if (attempt.current === controller) {
        attempt.current = null;
        setWaiting(false);
      }
    }
  };

  if (token && !waiting) {
    return (
      <div class="field">
        <span>Account</span>
        <div class="buttons">
          <Status span of={note(`Signed in${email ? ` as ${email}` : ''}`, 'ok')} />
          <button type="button" onClick={async () => { await signOut(); setKey(''); }}>
            Sign out
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      <div class="field">
        <span>Account</span>
        <div class="buttons">
          {waiting
            ? <button type="button" onClick={() => attempt.current?.abort()}>Cancel</button>
            : <button type="button" onClick={start}>Sign in with ChatGPT</button>}
        </div>
      </div>
      <Status of={said} live />
      {waiting && (
        <Row div={div} label="If the tab stays open on an error page, paste its address here">
          <Input type="url" value="" autocomplete="off" spellcheck={false}
            placeholder="http://127.0.0.1:…/auth/callback?code=…"
            onCommit={(url) => paste.current(url.trim())} />
        </Row>
      )}
    </>
  );
}
