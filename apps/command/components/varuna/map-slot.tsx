"use client";

import { CloudRain } from "lucide-react";

import { EmptyState } from "@/components/varuna/empty-state";
import { depthLegendStops } from "@/lib/ramps";

export interface MapSlotProps {
  /** Map layers or overlays rendered above the grid once a map exists. */
  children?: React.ReactNode;
}

/**
 * The future map canvas. Until CityMap lands (Phase 6) it is a quiet grid on `--ink` with the honest
 * empty state, the replay chip and the depth legend so the console reads correctly at a glance.
 */
export function MapSlot({ children }: MapSlotProps) {
  const stops = depthLegendStops();

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-ink"
      role="region"
      aria-label="Map canvas"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-35"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--line) 1px, transparent 1px), linear-gradient(to bottom, var(--line) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      {children}

      <div className="absolute inset-0 flex items-center justify-center p-6">
        <EmptyState
          icon={CloudRain}
          title="No runs yet"
          description="Press Play on the replay, or Compute live."
        />
      </div>

      <div className="absolute bottom-10 left-4 z-10">
        <span className="inline-flex h-7 items-center rounded-full border border-line bg-deep px-3 type-small text-text-2">
          Reconstructed replay
        </span>
      </div>

      <aside
        className="absolute right-4 bottom-10 z-10 w-44 rounded-[var(--radius-panel)] border border-line bg-deep p-3"
        aria-label="Depth legend"
      >
        <h2 className="type-small font-medium text-text">Depth</h2>
        <ul className="mt-2 space-y-1.5">
          {stops.map((stop) => (
            <li key={stop.key} className="flex items-center gap-2 type-micro text-text-2">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: stop.cssVar }}
              />
              <span className="num">{stop.label}</span>
              <span className="truncate text-text-3">{stop.meaning}</span>
            </li>
          ))}
        </ul>
      </aside>

      <p className="absolute inset-x-0 bottom-0 z-10 px-4 py-2 type-micro text-text-3">
        Basemap: CARTO, OpenStreetMap contributors
      </p>
    </div>
  );
}
