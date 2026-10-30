// A badge per <img>, in the shape videospeed puts one on a <video>.

const MIN_SIDE = 96;
const SYNC_MS = 400;

const STYLE = `
.badge {
  all: initial;
  position: absolute;
  font: 600 11px/1 -apple-system, BlinkMacSystemFont, sans-serif;
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  color: #fff; background: rgba(0, 0, 0, .55);
  border-radius: 4px; cursor: pointer;
  opacity: .28; transition: opacity .15s;
  pointer-events: auto; user-select: none;
}
.badge:hover, .badge.on, .badge.busy { opacity: .95; }
.badge.on { background: #2b6cb0; }
.badge.bad { background: #c0392b; opacity: .95; }
`;

export type Status = 'idle' | 'working' | 'shown' | 'hidden' | 'empty' | 'error';

interface Controller {
  badge: HTMLButtonElement;
  status: Status;
  title: string;
  offscreen: boolean;
  /** Laid over the image and kept on it, beneath the badge. */
  overlay: HTMLElement | null;
}

export class BadgeLayer {
  readonly controllers = new Map<HTMLImageElement, Controller>();
  private candidates = new Set<HTMLImageElement>();
  private host: HTMLDivElement | null = null;
  private surface: HTMLDivElement | null = null;
  private visibility: IntersectionObserver | null = null;
  private sizes: ResizeObserver | null = null;
  private mutations: MutationObserver | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private enabled = false;
  /** Whether the modifier is down. Badges stay out of the way until it is. */
  private armed = false;

  private onActivate: (img: HTMLImageElement) => void;

  constructor(onActivate: (img: HTMLImageElement) => void) {
    this.onActivate = onActivate;
  }

  start(): void {
    if (this.enabled) return;
    this.enabled = true;

    this.visibility = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const c = this.controllers.get(entry.target as HTMLImageElement);
        if (!c) continue;
        c.offscreen = !entry.isIntersecting;
        this.place(entry.target as HTMLImageElement);
      }
    }, { rootMargin: '200px' });

    this.sizes = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const img = entry.target as HTMLImageElement;
        if (this.controllers.has(img)) this.place(img);
        else this.attach(img);
      }
    });

    this.mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) this.scan(node);
        for (const node of record.removedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;
          if (el.tagName === 'IMG') this.detach(el as HTMLImageElement);
          else for (const img of el.querySelectorAll?.('img') || []) this.detach(img);
        }
      }
    });
    this.mutations.observe(document.documentElement, { childList: true, subtree: true });

    this.scan(document.documentElement);
    // Images move without resizing whenever something above them reflows, and
    // nothing fires for that, so badge positions are refreshed on a slow tick.
    this.ticker = setInterval(() => this.sync(), SYNC_MS);
    addEventListener('resize', this.sync, { passive: true });
    // Capture, because a page that handles the key itself would otherwise stop
    // this from ever hearing it.
    addEventListener('keydown', this.modifier, true);
    addEventListener('keyup', this.modifier, true);
    // Cmd-tabbing away releases the key somewhere this page will never hear.
    addEventListener('blur', this.disarm);
  }

  stop(): void {
    this.enabled = false;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    removeEventListener('resize', this.sync);
    removeEventListener('keydown', this.modifier, true);
    removeEventListener('keyup', this.modifier, true);
    removeEventListener('blur', this.disarm);
    for (const img of new Set([...this.controllers.keys(), ...this.candidates])) this.detach(img);
    this.mutations?.disconnect();
    this.visibility?.disconnect();
    this.sizes?.disconnect();
    this.mutations = this.visibility = null;
    this.sizes = null;
  }

  rescan(): void {
    if (this.enabled) this.scan(document.documentElement);
    else this.start();
  }

  setStatus(img: HTMLImageElement, status: Status, title: string): void {
    const c = this.controllers.get(img);
    if (!c) return;
    c.status = status;
    c.title = title;
    this.render(img);
    this.place(img);
  }

  setOverlay(img: HTMLImageElement, overlay: HTMLElement | null): void {
    const c = this.controllers.get(img);
    if (!c) return;
    c.overlay?.remove();
    c.overlay = overlay;
    if (overlay) this.surface!.prepend(overlay);
    this.place(img);
  }

  scan(root: Node): void {
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const el = root as Element;
    if (el.tagName === 'IMG') this.attach(el as HTMLImageElement);
    for (const img of el.querySelectorAll('img')) this.attach(img);
  }

  private mount(): void {
    if (this.host?.isConnected) return;
    this.host = document.createElement('div');
    this.host.style.cssText =
      'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2';
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.surface = document.createElement('div');
    root.append(style, this.surface);
    (document.body || document.documentElement).append(this.host);
  }

  private eligible(img: HTMLImageElement): boolean {
    const r = img.getBoundingClientRect();
    return Math.min(r.width, r.height) >= MIN_SIDE;
  }

  private attach(img: HTMLImageElement): void {
    if (this.controllers.has(img) || !this.enabled) return;
    if (!img.complete) {
      if (this.candidates.has(img)) return;
      this.candidates.add(img);
      img.addEventListener('load', () => {
        this.candidates.delete(img);
        this.attach(img);
      }, { once: true });
      return;
    }
    if (!this.eligible(img)) {
      this.candidates.add(img);
      this.sizes?.observe(img);
      return;
    }

    this.candidates.delete(img);
    this.sizes?.unobserve(img);

    this.mount();
    const badge = document.createElement('button');
    badge.className = 'badge';
    badge.type = 'button';
    badge.textContent = 'T';
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onActivate(img);
    });
    this.surface!.append(badge);
    this.controllers.set(img,
      { badge, status: 'idle', title: '', offscreen: false, overlay: null });
    this.visibility?.observe(img);
    this.sizes?.observe(img);
    this.place(img);
    this.render(img);
  }

  private detach(img: HTMLImageElement): void {
    this.controllers.get(img)?.badge.remove();
    this.controllers.get(img)?.overlay?.remove();
    this.controllers.delete(img);
    this.candidates.delete(img);
    this.visibility?.unobserve(img);
    this.sizes?.unobserve(img);
  }

  private place(img: HTMLImageElement): void {
    const c = this.controllers.get(img);
    if (!c || !this.host?.isConnected) return;
    const rect = img.getBoundingClientRect();
    // An image that has been acted on keeps its badge: it is the only way back
    // to the original, and the only way to call a slow translation off.
    const idle = c.status === 'idle';
    const hidden = (idle && !this.armed)
      || rect.width < MIN_SIDE || rect.height < MIN_SIDE || c.offscreen;
    c.badge.style.display = hidden ? 'none' : '';
    if (c.overlay) c.overlay.style.display = hidden ? 'none' : '';
    if (hidden) return;
    // Both rects are viewport-relative and the host sits in the page, so the
    // difference holds while scrolling; only layout changes disturb it.
    const origin = this.host.getBoundingClientRect();
    const left = rect.left - origin.left;
    const top = rect.top - origin.top;
    c.badge.style.left = `${left + 6}px`;
    c.badge.style.top = `${top + 6}px`;
    if (c.overlay) {
      Object.assign(c.overlay.style, {
        left: `${left}px`, top: `${top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      });
    }
  }

  private render(img: HTMLImageElement): void {
    const c = this.controllers.get(img);
    if (!c) return;
    const { badge, status } = c;
    badge.classList.toggle('busy', status === 'working');
    badge.classList.toggle('on', status === 'shown');
    badge.classList.toggle('bad', status === 'error');
    badge.textContent = ({ working: '…', error: '!' } as Record<string, string>)[status] || 'T';
    badge.title = c.title;
  }

  private modifier = (e: KeyboardEvent): void => this.arm(e.metaKey);

  private disarm = (): void => this.arm(false);

  private arm(armed: boolean): void {
    if (armed === this.armed) return;
    this.armed = armed;
    for (const img of this.controllers.keys()) this.place(img);
  }

  private sync = (): void => {
    for (const img of this.controllers.keys()) {
      if (!img.isConnected) this.detach(img);
      else this.place(img);
    }
  };
}
