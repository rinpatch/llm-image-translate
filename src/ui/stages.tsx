import { type Span, type StageRow } from '../platform/metrics.ts';
import { ms } from './format.ts';

/**
 * One bar, split by stage. `scale` is what a full-width bar stands for: the
 * median's own total for the summary, and the slowest run in the window for the
 * history, so a cold image there is visibly longer than the ones around it.
 *
 * What ran in parallel goes on a thin lane beneath, on the same scale and at
 * the time it started, so it lines up with the stages it overlapped.
 */
export function Bar({ stages, scale, tall, spans = [] }:
  { stages: StageRow[]; scale: number; tall?: boolean; spans?: Span[] }) {
  const share = (n: number) => `${Math.min(100, (n / Math.max(1, scale)) * 100)}%`;
  return (
    <div class={tall ? 'timeline tall' : 'timeline'}>
      <div class="bar">
        {stages.filter((stage) => stage.ms > 0).map((stage) => (
          <i key={stage.key} class={`seg-${stage.key}`} title={`${stage.label} ${ms(stage.ms)}`}
            style={{ width: share(stage.ms) }} />
        ))}
      </div>
      {spans.length > 0 && (
        <div class="lane">
          {spans.map((span) => (
            <i key={span.key} class={`seg-${span.key}`} title={`${span.label} ${ms(span.ms)}`}
              style={{ left: share(span.from), width: share(span.ms) }} />
          ))}
        </div>
      )}
    </div>
  );
}

// Same filter as the bar: a page with no text never gets to the translate
// stage, and a legend entry for it would be a line that never ran.
export function Legend({ stages, spans = [] }: { stages: StageRow[]; spans?: Span[] }) {
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
      {spans.filter((span) => span.ms > 0).map((span) => [
        <i class={`seg-${span.key} parallel`} />,
        <span>{span.label}</span>,
        <span class="num">{ms(span.ms)}</span>,
      ])}
    </div>
  );
}
