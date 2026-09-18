type Child = Node | string | number | null | undefined | false;

type Props<K extends keyof HTMLElementTagNameMap> =
  Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'children'>>
  & { style?: Partial<CSSStyleDeclaration> };

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Enough of a builder to stop the pages concatenating HTML. Everything here
 * goes through properties and text nodes, so nothing a model returned can turn
 * into markup on the way to the screen.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { style, ...rest } = props || {};
  Object.assign(node, rest);
  if (style) Object.assign(node.style, style);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export const clear = (host: HTMLElement): HTMLElement => {
  host.textContent = '';
  return host;
};

/** 1.4s rather than 1400ms once it is long enough that the digits stop helping. */
export const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
