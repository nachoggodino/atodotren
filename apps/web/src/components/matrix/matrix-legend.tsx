import { DELAY_SEVERITY_THRESHOLDS_SECONDS, PUNCTUALITY_THRESHOLD_SECONDS } from "@/lib/domain/delay-policy";
import type { Messages } from "@/messages/types";

const punctualMinutes = PUNCTUALITY_THRESHOLD_SECONDS / 60;
const delayedMinutes = DELAY_SEVERITY_THRESHOLDS_SECONDS.delayed / 60;

export function MatrixLegend({ messages }: { readonly messages: Messages }) {
  const items = [
    ["early", "−", messages.history.early],
    ["punctual", "✓", `≤${punctualMinutes}m ${messages.history.punctual}`],
    ["delayed", "+", `${punctualMinutes}–${delayedMinutes}m ${messages.history.delayed}`],
    ["severe", "!!", messages.history.severe],
    ["canceled", "×", messages.history.canceled],
    ["skipped", "↷", messages.history.skipped],
    ["missing", "—", messages.common.missing.toLowerCase()],
    ["pending", "…", messages.history.pending],
  ] as const;
  return (
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted" aria-label={messages.history.legend}>
      {items.map(([kind, symbol, label]) => (
        <span className="inline-flex items-center gap-1.5" key={kind}>
          <span aria-hidden="true" className="matrix-legend-swatch" data-kind={kind}>{symbol}</span>
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
}
