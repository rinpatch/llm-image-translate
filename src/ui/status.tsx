export interface Note {
  text: string;
  kind?: '' | 'ok' | 'bad';
}

export const note = (text: string, kind: Note['kind'] = ''): Note => ({ text, kind });

export const NONE: Note = { text: '' };

/** The grey, green or red line under whatever it is about. */
export function Status({ of, span, id, live }: {
  of: Note; span?: boolean; id?: string; live?: boolean;
}) {
  const Tag = span ? 'span' : 'div';
  return (
    <Tag class={`status ${of.kind || ''}`} id={id} aria-live={live ? 'polite' : undefined}>
      {of.text}
    </Tag>
  );
}
