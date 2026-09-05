"use client";

import { DepthChip } from "@/components/varuna/depth-chip";
import { EmptyState } from "@/components/varuna/empty-state";
import { formatIstTime } from "@/lib/stores/time";

/** The slice of `hotspots.json` the rail needs (CLAUDE.md section 10.3). */
export interface HotspotSummary {
  id: string;
  name: string;
  /** p50 depth in centimetres at the selected time. */
  depthCm: number;
  /** Time of peak depth, ISO 8601 with +05:30. */
  timeToPeak: string;
}

export interface HotspotRailProps {
  hotspots: HotspotSummary[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}

/**
 * Ranked hotspots plus the "As it happened" ticker for ground-truth pins (CLAUDE.md section 7.2).
 * Sparklines, exposure icons and the drawer arrive with the first run (Phase 6).
 */
export function HotspotRail({ hotspots, selectedId = null, onSelect }: HotspotRailProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hotspots.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No hotspots yet" description="Press Play on the replay." />
          </div>
        ) : (
          <ol className="divide-y divide-line" aria-label="Ranked hotspots">
            {hotspots.map((h, i) => {
              const selected = h.id === selectedId;
              return (
                <li key={h.id}>
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelect?.(h.id)}
                    className={
                      "flex h-10 w-full items-center gap-3 px-4 text-left hover:bg-well focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tide" +
                      (selected ? " bg-well" : "")
                    }
                  >
                    <span className="num w-5 type-small text-text-3">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate type-small text-text">{h.name}</span>
                    <DepthChip cm={h.depthCm} />
                    <span className="num type-micro text-text-2">{formatIstTime(h.timeToPeak)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <section
        aria-label="As it happened"
        className="shrink-0 border-t border-line p-4"
      >
        <h3 className="type-small font-medium text-text">As it happened</h3>
        <p className="mt-2 type-micro text-text-3">
          Ground-truth pins appear as the replay clock passes them.
        </p>
      </section>
    </div>
  );
}
