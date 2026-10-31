import { type StageRow } from '../platform/metrics.ts';
import { ms } from './format.ts';

/**
 * One bar, split by stage. `scale` is what a full-width bar stands for: the
 * median's own total for the summary, and the slowest run in the window for the
 * history, so a cold image there is visibly longer than the ones around it.
 */
export function Bar({ stages, scale, tall }: { stages: StageRow[]; scale: number; tall?: boolean }) {
  const width = (n: number) => `${Math.min(100, (n / Math.max(1, scale)) * 100)}%`;
  return (
    <div class={tall ? 'bar tall' : 'bar'}>
      {stages.filter((stage) => stage.ms > 0).map((stage) => (
        <i key={stage.key} class={`seg-${stage.key}`} title={`${stage.label} ${ms(stage.ms)}`}
          style={{ width: width(stage.ms) }} />
      ))}
    </div>
  );
}

// Same filter as the bar: a one-pass profile has no translate stage at all, and
// a legend entry for it would be a line that never runs.
export function Legend({ stages }: { stages: StageRow[] }) {
  return (
    <div class="legend">
      {stages.filter((stage) => stage.ms > 0).map((stage) => [
        <i class={`seg-${stage.key}`} />,
        <span>{stage.label}</span>,
        <span class="num">{ms(stage.ms)}</span>,
        ...(stage.parts || []).filter((part) => part.ms > 0).map((part) => [
          <i class={`seg-${stage.key} substage`} />,
          <span class="substage-label">{part.label}</span>,
          <span class="num substage-value">{ms(part.ms)}</span>,
        ]),
      ])}
    </div>
  );
}
