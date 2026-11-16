// The card picked and the server card's endpoint as page state, written back on
// every change. Shared by the settings page and the welcome page.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { scopeOf, startOn } from '../platform/providers.ts';
import {
  type EndpointSettings, type Keys, keys, save, saveKey, saveOpenrouterModel, saveServer,
  translators,
} from '../platform/settings.ts';

export function useTranslator() {
  const [provider, setProvider] = useState('');
  const [stored, setServer] = useState<EndpointSettings | null>(null);
  const [openrouterModel, setOpenrouterModel] = useState('');
  const [keyring, setKeyring] = useState<Keys>({});

  useEffect(() => {
    Promise.all([translators(), keys()]).then(([t, k]) => {
      setProvider(t.provider);
      setServer(t.server);
      setOpenrouterModel(t.openrouterModel);
      setKeyring(k);
    });
  }, []);

  // Not on the render that loaded them: an install from before the cards reads
  // its old profiles, and opening a page is not a reason to rewrite them.
  const loaded = useRef(false);
  useEffect(() => { if (loaded.current) save('provider', provider); }, [provider]);
  useEffect(() => { if (loaded.current && stored) saveServer(stored); }, [stored]);
  useEffect(() => {
    if (loaded.current) saveOpenrouterModel(openrouterModel);
  }, [openrouterModel]);
  useEffect(() => { if (provider) loaded.current = true; }, [provider]);

  // Memoised, so whatever is keyed on them changes only when they do.
  const [server, picked] = useMemo(() => {
    const fill = (e: EndpointSettings) => ({ ...e, apiKey: keyring[scopeOf(e)] || '' });
    if (!stored) return [null, null];
    const filled = fill(stored);
    return [filled, provider === 'server' ? filled
      : fill(startOn(provider, provider === 'openrouter' ? openrouterModel : ''))];
  }, [provider, stored, openrouterModel, keyring]);

  /** `scope` is what `scopeOf` makes of an endpoint. */
  const setKey = async (scope: string, key: string) => {
    await saveKey(scope, key);
    setKeyring(await keys());
  };

  return {
    provider, setProvider, server, setServer, openrouterModel, setOpenrouterModel, keyring, setKey,
    /** What the picked card runs, key filled in. */
    translator: picked,
  };
}

export type Translator = ReturnType<typeof useTranslator>;
