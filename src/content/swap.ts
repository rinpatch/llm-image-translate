// Putting a translated image in place of the original, and taking it back out.

interface Background {
  node: HTMLElement;
  value: string;
  priority: string;
}

interface SwapState {
  original: string;
  srcset: string | null;
  sizes: string | null;
  backgrounds: Background[];
}

const states = new WeakMap<HTMLImageElement, SwapState>();

// X paints the photo in a sibling background while keeping the img transparent.
function backgroundsFor(img: HTMLImageElement): Background[] {
  const hostname = img.ownerDocument.defaultView?.location.hostname || '';
  const photo = /(^|\.)(x\.com|twitter\.com)$/.test(hostname)
    && img.closest('[data-testid="tweetPhoto"], [aria-label="Image"]');
  if (!photo || !img.parentElement) return [];
  return [...img.parentElement.children]
    .filter((node): node is HTMLElement => {
      const style = (node as HTMLElement).style;
      return node !== img && !!style && style.backgroundImage.includes('url(');
    })
    .map((node) => ({
      node,
      value: node.style.backgroundImage,
      priority: node.style.getPropertyPriority('background-image'),
    }));
}

// A srcset wins over src, so setting src alone does nothing on any site that
// ships responsive images. Both it and sizes have to go, and come back.
export function show(img: HTMLImageElement, dataUrl: string): void {
  let state = states.get(img);
  if (!state) {
    state = {
      original: img.currentSrc || img.src,
      srcset: img.getAttribute('srcset'),
      sizes: img.getAttribute('sizes'),
      backgrounds: backgroundsFor(img),
    };
    states.set(img, state);
  }
  for (const { node } of state.backgrounds) {
    node.style.setProperty('background-image', `url("${dataUrl}")`);
  }
  img.removeAttribute('srcset');
  img.removeAttribute('sizes');
  img.src = dataUrl;
}

export function restore(img: HTMLImageElement): void {
  const state = states.get(img);
  if (!state) return;
  img.src = state.original;
  for (const { node, value, priority } of state.backgrounds) {
    node.style.setProperty('background-image', value, priority);
  }
  if (state.srcset) img.setAttribute('srcset', state.srcset);
  if (state.sizes) img.setAttribute('sizes', state.sizes);
}
