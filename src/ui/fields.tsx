import { type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

interface InputProps {
  value: string;
  onCommit: (value: string) => void;
  type?: 'text' | 'url' | 'password';
  id?: string;
  list?: string;
  placeholder?: string;
  autocomplete?: string;
  spellcheck?: boolean;
  onFocus?: () => void;
}

/**
 * A text field that keeps what is being typed until it is committed. Preact
 * puts `value` back on every render, so a plain controlled input would lose a
 * half-typed URL the moment a model list arrived and redrew the section.
 */
export function Input({ value, onCommit, ...rest }: InputProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      // Preact's types tie `list` to the text type alone, which HTML does not.
      {...(rest as object)}
      value={draft}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onChange={(e) => onCommit(e.currentTarget.value)}
    />
  );
}

/** A select over plain names, where the name is also the value. */
export function Names({ names, value, onPick, ...rest }: {
  names: readonly string[]; value: string; onPick: (name: string) => void;
  id?: string; 'aria-label'?: string;
}) {
  return (
    <select {...rest} value={value} onChange={(e) => onPick(e.currentTarget.value)}>
      {names.map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
  );
}

export const Row = ({ label, children }: { label: ComponentChildren; children: ComponentChildren }) => (
  <label><span>{label}</span>{children}</label>
);

export const Check = ({ checked, onCheck, label, id }: {
  checked: boolean; onCheck: (on: boolean) => void; label: string; id?: string;
}) => (
  <label class="check" id={id}>
    <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.currentTarget.checked)} />
    <span>{label}</span>
  </label>
);
