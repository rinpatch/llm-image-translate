// What the server card's server says it serves, and what follows from that.
import { useEffect, useRef } from 'preact/hooks';
import { type ListedModel, listModels } from '../backends/client.ts';
import { type EndpointSettings, toEndpoint } from '../platform/endpoint.ts';
import { t, tn } from '../platform/i18n.ts';
import { guessAdapter } from '../platform/providers.ts';
import { useAsync } from './async.ts';
import { Combobox } from './combobox.tsx';
import { NONE, type Note, note } from './status.tsx';

export type Served = ListedModel[] | null | undefined;

export const isLlamacpp = (served: Served) => Boolean(served?.some((m) => m.llamacpp));

/** Undefined until the server answers, null for no answer. */
export function useServed(endpoint: EndpointSettings, wanted: boolean): Served {
  // The model is left out: a different model on the same server is the same list.
  return useAsync(() => (!wanted || !endpoint.baseUrl ? undefined
    : listModels(toEndpoint(endpoint))),
    [endpoint.baseUrl, endpoint.apiKey, wanted]);
}

/** The model a request will reach: the one named, or the one a server serves alone. */
export function inUse(endpoint: EndpointSettings, served: Served) {
  return served?.find((m) => m.id === endpoint.model)
    || (!endpoint.model && served?.length === 1 ? served[0] : undefined);
}

/**
 * A server serving one model is using that one, and its name says which
 * adapter it wants. The change to make, if there is one.
 */
export function adoption(endpoint: EndpointSettings, served: Served) {
  if (!served || served.length !== 1) return null;
  if (served.some((m) => m.id === endpoint.model)) return null;
  return (e: EndpointSettings) => {
    e.model = served[0].id;
    e.adapter = guessAdapter(e.model, isLlamacpp(served));
  };
}

/**
 * Applies `adoption` once the server answers, but only after the server or the
 * key has changed, or from the start: merely looking at the card does not
 * rewrite it. Wrap those changes in what this returns.
 */
export function useAdoption(endpoint: EndpointSettings, served: Served,
  edit: (change: (e: EndpointSettings) => void) => void) {
  const armed = useRef(true);
  useEffect(() => {
    if (!armed.current) return;
    if (endpoint.baseUrl && served === undefined) return;
    armed.current = false;
    const adopt = adoption(endpoint, served);
    if (adopt) edit(adopt);
  });
  return (change: () => void) => {
    armed.current = true;
    change();
  };
}

/** What the server's answer says, beside the model field. */
export function servedNote(endpoint: EndpointSettings, served: Served): Note {
  const one = inUse(endpoint, served);
  if (served === undefined) return NONE;
  if (served === null) return note(t('nothingAnswering', endpoint.baseUrl), 'bad');
  if (endpoint.adapter === 'gemma-raw' && !isLlamacpp(served)) {
    return note(t('gemmaNeedsLlamacpp'), 'bad');
  }
  if (endpoint.model && !one) return note(t('modelNotServed', endpoint.model), 'bad');
  if (!endpoint.model && !one) return note(tn('servesModels', served.length));
  return NONE;
}

/** A model id, picked from what the server serves or typed in. */
export function ModelField({ id, endpoint, served, fallback, onCommit }: {
  id: string; endpoint: EndpointSettings; served: Served;
  fallback: string; onCommit: (model: string) => void;
}) {
  const one = inUse(endpoint, served);
  return (
    <Combobox id={id} free value={endpoint.model}
      placeholder={one && !endpoint.model ? one.id : fallback} onPick={onCommit}
      options={(served || []).map((m) => ({ value: m.id, label: m.name || undefined }))} />
  );
}
