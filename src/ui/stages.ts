import { type StageRow } from '../platform/metrics.ts';
import { el, ms } from './dom.ts';

/**
 * One bar, split by stage. `scale` is what a full-width bar stands for: the
 * median's own total for the summary, and the slowest run in the window for the
 * history, so a cold image there is visibly longer than the ones around it.
 */
export function bar(stages: StageRow[], scale: number, tall = false): HTMLElement {
  const width = (n: number) => `${Math.min(100, (n / Math.max(1, scale)) * 100)}%`;
  return el('div', { className: tall ? 'bar tall' : 'bar' },
    ...stages.filter((stage) => stage.ms > 0).map((stage) =>
      el('i', { className: `seg-${stage.key}`, title: `${stage.label} ${ms(stage.ms)}`,
                style: { width: width(stage.ms) } })));
}

// Same filter as the bar: a one-pass profile has no translate stage at all, and
// a legend entry for it would be a line that never runs.
export function legend(stages: StageRow[]): HTMLElement {
  return el('div', { className: 'legend' },
    ...stages.filter((stage) => stage.ms > 0).flatMap((stage) => {
      const parent = [
        el('i', { className: `seg-${stage.key}` }),
        el('span', {}, stage.label),
        el('span', { className: 'num' }, ms(stage.ms)),
      ];
      const parts = (stage.parts || []).filter((part) => part.ms > 0).flatMap((part) => [
        el('i', { className: `seg-${stage.key} substage` }),
        el('span', { className: 'substage-label' }, part.label),
        el('span', { className: 'num substage-value' }, ms(part.ms)),
      ]);
      return [...parent, ...parts];
    }));
}
