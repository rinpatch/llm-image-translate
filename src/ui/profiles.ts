// The stored profiles as page state, written back on every change. Shared by
// the settings page and the welcome page, which both edit the list.
import { useEffect, useRef, useState } from 'preact/hooks';
import { withKey } from '../platform/cards.ts';
import { type Profile, find } from '../platform/profiles.ts';
import { type Keys, keys, profiles, save, saveKey, saveProfiles } from '../platform/settings.ts';

export function useProfiles() {
  const [list, setList] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState('');
  const [keyring, setKeyring] = useState<Keys>({});

  useEffect(() => {
    Promise.all([profiles(), keys()]).then(([{ list, active }, k]) => {
      setList(list);
      setActiveId(active.id);
      setKeyring(k);
    });
  }, []);

  // Every change to the list or the choice is written back from here, so edits
  // that land together are saved together. Not on the render that loaded them.
  const loaded = useRef(false);
  useEffect(() => { if (loaded.current) saveProfiles(list); }, [list]);
  // After the list: an active id naming a profile nobody has stored yet reads
  // back as no profile at all. Storage applies the two writes in order.
  useEffect(() => { if (loaded.current) save('profile', activeId); }, [activeId]);
  useEffect(() => { if (list.length) loaded.current = true; }, [list]);

  /** `scope` is what `scopeOf` makes of an endpoint. */
  const setKey = async (scope: string, key: string) => {
    await saveKey(scope, key);
    setKeyring(await keys());
    setList((now) => withKey(now, scope, key));
  };

  return {
    list, setList, keyring, setKey, setActiveId,
    active: find(list, activeId) || list[0] as Profile | undefined,
  };
}

export type Profiles = ReturnType<typeof useProfiles>;
