"use client";

/**
 * What one street is doing, on click (CLAUDE.md 6.6, 7.2; task P6.9).
 *
 * The hotspot drawer answers "what is happening at the twenty-eight places we already watch". This
 * answers the other question an operator has, which is about the street they just pointed at - and
 * on the 2 July storm most of the wet streets are not on the chronic register at all.
 *
 * Three things, in the order they are asked: how deep it is now, what it does over the next three
 * hours, and who can still drive through it.
 */

import { X } from "lucide-react";

import { DepthChip } from "@/components/varuna/depth-chip";
import { Sparkline } from "@/components/varuna/sparkline";
import type { SegmentPick } from "@/components/map/city-map";
import { formatIstTime } from "@/lib/stores/time";
import { cn } from "@/lib/utils";

/**
 * The depth at which each profile stops, from `varuna_route.profiles` (CLAUDE.md 11.8).
 *
 * The same numbers the router costs on and the depth ramp colours by, so a street the map draws
 * orange and the popover calls impassable for a car are saying one thing, not two.
 */
const PROFILES: readonly { key: string; label: string; cm: number }[] = [
  { key: "two_wheeler", label: "Two-wheeler", cm: 15 },
  { key: "car", label: "Car", cm: 30 },
  { key: "bus", label: "Bus or truck", cm: 45 },
  { key: "ambulance", label: "Ambulance", cm: 60 },
  { key: "pedestrian", label: "Pedestrian", cm: 30 },
];

export interface SegmentPopoverProps {
  pick: SegmentPick;
  /** Current step, so "now" on the chart is where the time bar is. */
  step: number;
  /** The run's step times, for "safe until 09:25". */
  validTs: readonly string[];
  onClose: () => void;
  className?: string;
}

/** The first step at which the street exceeds `cm`, or null if it never does. */
function firstOver(depths: readonly number[], cm: number, from: number): number | null {
  for (let i = from; i < depths.length; i += 1) {
    if (depths[i] > cm) return i;
  }
  return null;
}

export function SegmentPopover({ pick, step, validTs, onClose, className }: SegmentPopoverProps) {
  const { segment, x, y } = pick;
  const depths = segment.depthCm;
  const now = depths[step] ?? 0;
  const peak = depths.length > 0 ? Math.max(...depths) : 0;
  const peakStep = depths.indexOf(peak);

  return (
    <aside
      aria-label={`Segment ${segment.name || segment.id}`}
      // Anchored where the click landed, nudged so the panel never hangs off the left edge or
      // sits under the cursor.
      style={{ left: Math.max(12, x - 130), top: Math.max(12, y + 14) }}
      className={cn(
        "pointer-events-auto absolute z-20 w-[17rem] rounded-popover border border-line bg-deep/95 p-3 backdrop-blur-sm",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate type-small font-medium text-text">
            {segment.name || "Unnamed road"}
          </h2>
          <p className="num type-micro text-text-3">{segment.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-control p-1 text-text-3 hover:bg-well hover:text-text"
        >
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>

      <div className="mt-3 flex items-baseline gap-2">
        <DepthChip cm={now} />
        <span className="type-micro text-text-3">
          now{validTs[step] ? ` · ${formatIstTime(validTs[step])}` : ""}
        </span>
      </div>

      <div className="mt-2">
        <Sparkline values={[...depths]} className="h-8 w-full" />
        <p className="num type-micro text-text-3">
          Peak {peak.toFixed(0)} cm
          {peakStep >= 0 && validTs[peakStep] ? ` at ${formatIstTime(validTs[peakStep])}` : ""}
        </p>
      </div>

      <h3 className="mt-3 type-micro font-medium text-text-2">Safe until</h3>
      <ul className="mt-1 space-y-0.5">
        {PROFILES.map((profile) => {
          const over = firstOver(depths, profile.cm, step);
          const stopped = (depths[step] ?? 0) > profile.cm;
          return (
            <li key={profile.key} className="flex items-baseline justify-between gap-2 type-micro">
              <span className="text-text-2">{profile.label}</span>
              <span className={cn("num", stopped ? "text-depth-4" : "text-text")}>
                {stopped
                  ? "stopped now"
                  : over === null
                    ? "passable all run"
                    : validTs[over]
                      ? formatIstTime(validTs[over])
                      : `step ${over}`}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 type-micro text-text-3">
        Depth is the 90th percentile of cells within 15 m of the centreline. One member, so this is
        a forecast and not a distribution.
      </p>
    </aside>
  );
}
