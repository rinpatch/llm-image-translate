import { useEffect, useRef, useState } from 'preact/hooks';
import { languageName, t } from '../platform/i18n.ts';
import { type Option, search } from './search.ts';

let ids = 0;

/**
 * A select that can be typed into to narrow it down. With `free`, whatever is
 * typed can also be kept as it is — a model id the server did not list.
 */
export function Combobox({ options, value, onPick, free, placeholder, id, ...rest }: {
  options: readonly Option[]; value: string; onPick: (value: string) => void;
  free?: boolean; placeholder?: string; id?: string; 'aria-label'?: string;
}) {
  const [list] = useState(() => `combo-${++ids}`);
  // Null until something is typed: the field shows the value and the list all of it.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const typed = query?.trim() ?? '';
  // A free field keeps what was typed in it, which is the value, not a label.
  const shown = (!free && options.find((o) => o.value === value)?.label) || value;
  const items: Option[] = query === null ? [...options] : search(options, query);
  if (free && typed && !options.some((o) => o.value === typed)) {
    items.push({ value: typed, label: t('useTyped', typed) });
  }

  const show = (at = items.findIndex((o) => o.value === value)) => {
    setActive(Math.max(at, 0));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQuery(null);
  };
  const pick = (next: string) => {
    close();
    if (next !== value) onPick(next);
  };

  useEffect(() => {
    if (open) listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (e: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      if (!open) show();
      else if (items.length) setActive((active + step + items.length) % items.length);
    } else if (open && (e.key === 'Home' || e.key === 'End') && query === null) {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : items.length - 1);
    } else if (e.key === 'Enter') {
      // A form around it would otherwise submit.
      e.preventDefault();
      if (open && items[active]) pick(items[active].value);
      else if (free && query !== null) pick(typed);
    } else if (e.key === 'Escape' && open) {
      // So a dialog it sits in stays open.
      e.stopPropagation();
      close();
    }
  };

  return (
    <div class="combo">
      <input {...rest} id={id} type="text" role="combobox" autocomplete="off" spellcheck={false}
        aria-expanded={open} aria-controls={list} aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${list}-${active}` : undefined}
        placeholder={placeholder} value={query ?? shown}
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => {
          if (open) return close();
          // Focus selects too, but the field keeps focus after a pick, and a
          // second look would otherwise type onto the end of the value.
          e.currentTarget.select();
          show();
        }}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          show(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => (free && query !== null ? pick(typed) : close())} />
      <svg class="chevrons" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
      </svg>
      {open && (items.length || !free) && (
        <ul id={list} role="listbox" ref={listRef}
          // Keeps focus in the field, which would close the list before the click landed.
          onMouseDown={(e) => e.preventDefault()}>
          {items.length ? items.map((o, i) => (
            <li key={o.value} id={`${list}-${i}`} role="option"
              aria-selected={i === active} class={o.value === value ? 'current' : undefined}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={(e) => {
                // Inside a label, the click would otherwise go on to its radio.
                e.preventDefault();
                pick(o.value);
              }}>
              {o.label ?? o.value}
            </li>
          )) : <li class="empty">{t('noMatch')}</li>}
        </ul>
      )}
    </div>
  );
}

/** A combobox over plain names, where the name is also the value. */
export const NameBox = ({ names, ...rest }: Omit<Parameters<typeof Combobox>[0], 'options'> & {
  names: readonly string[];
}) => <Combobox options={names.map((value) => ({ value }))} {...rest} />;

/** Language names, shown in the interface's language. The value stays the English name. */
export const LanguageBox = ({ names, ...rest }: Omit<Parameters<typeof Combobox>[0], 'options'> & {
  names: readonly string[];
}) => <Combobox options={names.map((value) => ({ value, label: languageName(value) }))} {...rest} />;
