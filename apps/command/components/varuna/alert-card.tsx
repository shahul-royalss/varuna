"use client";

import { ArrowUpRight, Check } from "lucide-react";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";
import { AlertLevelChip, type AlertLevel } from "@/components/varuna/alert-level-chip";
import { formatIst, formatPct } from "@/lib/format";
import { presetFor, useMotionPref } from "@/lib/motion";
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
  /**
   * What `persistsCycles` counts, singular. CLAUDE.md 11.10's hysteresis is in *cycles*, and a
   * run baked under the cross-cycle rule counts them ("cycle"); a run baked before it counted
   * forecast steps ("forecast step"), and the card has to say which - "persists 36 cycles" over a
   * 3-hour forecast would be a lie. Defaults to "cycle".
   */
  persistsUnit?: string;
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
  /**
   * True when the alert just arrived in the queue: the card slides in from 12 px above over
   * 180 ms (motion M16), or fades in under reduced motion. A card already on screen does not.
   */
  entering?: boolean;
  className?: string;
}

/**
 * One alert in the queue (CLAUDE.md section 7.5): level chip, headline, area, trigger
 * probability, the hysteresis line and the acknowledge and escalate actions. Colour is carried
 * by the level chip only; the border stays `--line` so the map's depth ramp is never imitated.
 *
 * The card carries `layout="position"` under full motion, so when new cards arrive above it the
 * ones already in the queue move down with them instead of jumping.
 */
export function AlertCard({
  alert,
  onAcknowledge,
  onEscalate,
  selected = false,
  onSelect,
  entering = false,
  className,
}: AlertCardProps) {
  const { reduced } = useMotionPref();
  const preset = presetFor("M16", reduced);
  const unit = alert.persistsUnit ?? "cycle";
  const hysteresis = `raised ${formatIst(alert.raisedAt)} - persists ${alert.persistsCycles} ${
    alert.persistsCycles === 1 ? unit : `${unit}s`
  }`;

  return (
    <motion.article
      layout={reduced ? false : "position"}
      initial={entering ? preset.initial : false}
      animate={preset.animate}
      transition={preset.transition}
      data-entering={entering ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "rounded-panel border-line bg-deep flex flex-col gap-3 border p-4",
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
            className="type-body text-text hover:text-tide focus-visible:ring-tide text-left font-medium focus-visible:ring-2 focus-visible:outline-none"
          >
            {alert.headline}
          </button>
        ) : (
          <h3 className="type-body text-text font-medium">{alert.headline}</h3>
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
            className="rounded-chip border-line type-micro text-text-2 border px-2 py-0.5"
          >
            {channel}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {alert.acknowledged ? (
          <span className="type-small text-text-2 inline-flex h-7 items-center gap-1.5">
            <Check size={16} strokeWidth={1.75} aria-hidden="true" className="text-tide" />
            Acknowledged
          </span>
        ) : (
          <Button variant="outline" size="sm" onClick={() => onAcknowledge?.(alert.id)}>
            Acknowledge
          </Button>
        )}
        {alert.escalated ? (
          <span className="type-small text-text-2 inline-flex h-7 items-center gap-1.5">
            <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" />
            Escalated
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onEscalate?.(alert.id)}>
            Escalate
          </Button>
        )}
      </div>
    </motion.article>
  );
}
