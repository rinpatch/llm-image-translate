// What a server says it serves, and what follows from that: shared by the
// settings page's endpoints and the welcome page's server card.
import { useEffect, useRef } from 'preact/hooks';
import { type ListedModel, listModels } from '../backends/client.ts';
import { type EndpointSettings, type Role, toEndpoint } from '../platform/profiles.ts';
import { adapterFor, provider } from '../platform/providers.ts';
import { useAsync } from './async.ts';
import { Input } from './fields.tsx';
import { NONE, type Note, note } from './status.tsx';

export type Served = ListedModel[] | null | undefined;

export const isLlamacpp = (served: Served) => Boolean(served?.some((m) => m.llamacpp));

/**
 * Undefined until the server answers, null for no answer. A local server's list
 * is one request to this machine; OpenRouter's is a few hundred entries, so that
 * one waits for `wanted`.
 */
export function useServed(endpoint: EndpointSettings, wanted: boolean): Served {
  const listable = Boolean(provider(endpoint.provider).lists && endpoint.baseUrl);
  // The model is left out: a different model on the same server is the same list.
  return useAsync(() => (listable && wanted ? listModels(toEndpoint(endpoint)) : undefined),
    [endpoint.provider, endpoint.baseUrl, endpoint.apiKey, wanted]);
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
export function adoption(role: Role, endpoint: EndpointSettings, served: Served) {
  if (endpoint.provider !== 'server' || !served || served.length !== 1) return null;
  if (served.some((m) => m.id === endpoint.model)) return null;
  return (e: EndpointSettings) => {
    e.model = served[0].id;
    e.adapter = adapterFor(role, e, undefined, isLlamacpp(served));
  };
}

/**
 * Applies `adoption` once the server answers, but only after the server or the
 * key has changed (or from the start, for an endpoint made just now): merely
 * looking at an endpoint does not rewrite it. Wrap those changes in what this
 * returns.
 */
export function useAdoption(role: Role, endpoint: EndpointSettings, served: Served,
  edit: (change: (e: EndpointSettings) => void) => void, fresh: boolean) {
  const armed = useRef(fresh);
  useEffect(() => {
    if (!armed.current) return;
    if (endpoint.provider === 'server' && endpoint.baseUrl && served === undefined) return;
    armed.current = false;
    const adopt = adoption(role, endpoint, served);
    if (adopt) edit(adopt);
  });
  return (change: () => void) => {
    armed.current = true;
    change();
  };
}

/** What the server's answer says about this role, beside the model field. */
export function servedNote(role: Role, endpoint: EndpointSettings, served: Served): Note {
  const onServer = endpoint.provider === 'server';
  const one = inUse(endpoint, served);
  if (served === undefined) return NONE;
  if (served === null) return onServer ? note(`Nothing answering at ${endpoint.baseUrl}.`, 'bad') : NONE;
  if (role === 'reader' && one?.vision === false) return note(`${one.id} does not take images.`, 'bad');
  if (role === 'translator' && endpoint.adapter === 'gemma-raw' && !isLlamacpp(served)) {
    return note('TranslateGemma needs llama.cpp\'s /completion, which this server does not '
      + 'have.', 'bad');
  }
  if (endpoint.model && !one) return note(`${endpoint.model} is not on this server.`, 'bad');
  if (onServer && !endpoint.model && !one) return note(`Serves ${served.length} models. Pick one.`);
  return NONE;
}

/** A model id, with what the server serves as suggestions. */
export function ModelField({ id, role, endpoint, served, fallback, onCommit, onFocus }: {
  id: string; role: Role; endpoint: EndpointSettings; served: Served;
  fallback: string; onCommit: (model: string) => void; onFocus?: () => void;
}) {
  const one = inUse(endpoint, served);
  return (
    <>
      <Input type="text" id={id} list={`${id}-list`} autocomplete="off" spellcheck={false}
        value={endpoint.model} placeholder={one && !endpoint.model ? one.id : fallback}
        onFocus={onFocus} onCommit={onCommit} />
      <datalist id={`${id}-list`}>
        {(served || []).filter((m) => role !== 'reader' || m.vision !== false)
          .map((m) => <option value={m.id}>{m.name || m.id}</option>)}
      </datalist>
    </>
  );
}
