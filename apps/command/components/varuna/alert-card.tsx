"use client";

import { ArrowUpRight, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AlertLevelChip, type AlertLevel } from "@/components/varuna/alert-level-chip";
import { formatIst, formatPct } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The slice of `alerts.json` the queue needs (CLAUDE.md sections 10.3 and 11.10). */
export interface AlertSummary {
  id: string;
  level: AlertLevel;
  /** "Hindmata junction: depth likely above 45 cm from 08:20 to 10:00". */
  headline: string;
  /** Ward or locality the alert covers. */
  area: string;
  /** P(> threshold) that triggered the alert, as a fraction. */
  triggerProbability: number;
  /** When the alert was raised, ISO 8601 with +05:30. */
  raisedAt: string;
  /** Consecutive cycles the condition has persisted (hysteresis state). */
  persistsCycles: number;
  /** Channels the alert went out on, e.g. ["Dashboard", "WhatsApp mock"]. */
  channels: string[];
  acknowledged?: boolean;
  escalated?: boolean;
}

export interface AlertCardProps {
  alert: AlertSummary;
  onAcknowledge?: (id: string) => void;
  onEscalate?: (id: string) => void;
  /** Highlights the selected card (the CAP viewer shows its document). */
  selected?: boolean;
  onSelect?: (id: string) => void;
  className?: string;
}

/**
 * One alert in the queue (CLAUDE.md section 7.5): level chip, headline, area, trigger
 * probability, the hysteresis line and the acknowledge and escalate actions. Colour is carried
 * by the level chip only; the border stays `--line` so the map's depth ramp is never imitated.
 */
export function AlertCard({
  alert,
  onAcknowledge,
  onEscalate,
  selected = false,
  onSelect,
  className,
}: AlertCardProps) {
  const hysteresis = `raised ${formatIst(alert.raisedAt)} - persists ${alert.persistsCycles} ${
    alert.persistsCycles === 1 ? "cycle" : "cycles"
  }`;

  return (
    <article
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex flex-col gap-3 rounded-panel border border-line bg-deep p-4",
        selected && "border-line-strong bg-well",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <AlertLevelChip level={alert.level} size="sm" />
        <span className="num type-micro text-text-3">{hysteresis}</span>
      </div>

      <div className="min-w-0 space-y-1">
        {onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(alert.id)}
            className="text-left type-body font-medium text-text hover:text-tide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tide"
          >
            {alert.headline}
          </button>
        ) : (
          <h3 className="type-body font-medium text-text">{alert.headline}</h3>
        )}
        <p className="type-small text-text-2">
          {alert.area}
          <span className="text-text-3"> - trigger </span>
          <span className="num">{formatPct(alert.triggerProbability)}</span>
        </p>
      </div>

      <ul className="flex flex-wrap gap-1.5" aria-label="Channels">
        {alert.channels.map((channel) => (
          <li
            key={channel}
            className="rounded-chip border border-line px-2 py-0.5 type-micro text-text-2"
          >
            {channel}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {alert.acknowledged ? (
          <span className="inline-flex h-7 items-center gap-1.5 type-small text-text-2">
            <Check size={16} strokeWidth={1.75} aria-hidden="true" className="text-tide" />
            Acknowledged
          </span>
        ) : (
          <Button variant="outline" size="sm" onClick={() => onAcknowledge?.(alert.id)}>
            Acknowledge
          </Button>
        )}
        {alert.escalated ? (
          <span className="inline-flex h-7 items-center gap-1.5 type-small text-text-2">
            <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" />
            Escalated
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onEscalate?.(alert.id)}>
            Escalate
          </Button>
        )}
      </div>
    </article>
  );
}
