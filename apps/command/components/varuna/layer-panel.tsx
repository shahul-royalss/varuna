"use client";

import { ChevronDown, Layers } from "lucide-react";
import { useState } from "react";

import { Kbd } from "@/components/varuna/kbd";
import { cn } from "@/lib/utils";

/** The layers the console can actually draw today. */
export interface LayerToggles {
  raster: boolean;
  segments: boolean;
  surcharge: boolean;
  drains: boolean;
  buildings: boolean;
  hotspots: boolean;
}

export type LayerKey = keyof LayerToggles;

export interface LayerPanelProps {
  value: LayerToggles;
  onChange: (key: LayerKey, next: boolean) => void;
  /** Counts from the current run, so a row says what it would draw before you turn it on. */
  counts?: Partial<Record<LayerKey, number>>;
}

const ROWS: readonly {
  key: LayerKey;
  label: string;
  hint: string;
  shortcut?: string;
}[] = [
  { key: "raster", label: "Depth raster", hint: "30 m surface depth from the Twin" },
  { key: "segments", label: "Streets (depth)", hint: "Road segments coloured by depth" },
  { key: "surcharge", label: "Surcharge", hint: "Manholes pushing water up", shortcut: "S" },
  { key: "drains", label: "Drains", hint: "Inferred graph, coloured by blockage", shortcut: "D" },
  { key: "buildings", label: "Buildings", hint: "Footprints from OpenStreetMap" },
  { key: "hotspots", label: "Ground truth", hint: "The chronic register", shortcut: "G" },
];

/**
 * The console's floating layer panel (CLAUDE.md sections 6.5, 7.2, task P6.10).
 *
 * Only layers that exist are listed. CLAUDE.md 17 forbids a dead control, and a switch for
 * isochrones that does nothing is worse than no switch: it makes the operator wonder whether the
 * data is missing or the map is broken. Routes, probability mode and 3D join this list in the
 * phase that builds them.
 */
export function LayerPanel({ value, onChange, counts = {} }: LayerPanelProps) {
  const [open, setOpen] = useState(true);

  return (
    <div className="w-[248px] overflow-hidden rounded-panel border border-line bg-[var(--ink)]/85 backdrop-blur-[12px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-well focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-tide"
      >
        <Layers size={16} strokeWidth={1.75} className="shrink-0 text-text-2" />
        <span className="flex-1 type-small text-text">Layers</span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={cn("shrink-0 text-text-3 transition-transform", !open && "-rotate-90")}
        />
      </button>

      {open ? (
        <ul className="border-t border-line p-1">
          {ROWS.map((row) => {
            const on = value[row.key];
            const count = counts[row.key];
            return (
              <li key={row.key}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => onChange(row.key, !on)}
                  title={row.hint}
                  className="flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left hover:bg-well focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-tide"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative h-3.5 w-6 shrink-0 rounded-chip border transition-colors",
                      on ? "border-tide bg-tide/30" : "border-line-strong bg-well",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-1/2 size-2 -translate-y-1/2 rounded-full transition-[left]",
                        on ? "left-[13px] bg-tide" : "left-[3px] bg-[var(--text-3)]",
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate type-small text-text">{row.label}</span>
                  {count !== undefined ? (
                    <span className="num shrink-0 type-micro text-text-3">
                      {count.toLocaleString("en-IN")}
                    </span>
                  ) : null}
                  {row.shortcut ? <Kbd>{row.shortcut}</Kbd> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
