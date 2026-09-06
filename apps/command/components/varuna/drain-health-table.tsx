"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import { EmptyState } from "@/components/varuna/empty-state";
import { formatBeta, formatCount, formatIst, formatPct } from "@/lib/format";
import { cssVar, drainBand } from "@/lib/ramps";
import { cn } from "@/lib/utils";

/** One inferred pipe as Pulse leaves it after a cycle (run artifact `drain_health.geojson`). */
export interface DrainHealthRow {
  /** Pipe id in the inferred graph, e.g. "E-01842". */
  id: string;
  /** Street the pipe runs under, e.g. "Dr Ambedkar Road". */
  street: string;
  /** Posterior blockage beta, 0 clear to 1 blocked. */
  betaMean: number;
  /** Posterior standard deviation of beta. */
  betaSd: number;
  /** Capacity lost to the blockage, as a fraction in [0, 1]. */
  capacityReduction: number;
  /** Hotspots this pipe helps explain, e.g. ["Hindmata junction"]. */
  hotspotsExplained: string[];
  /** Observations assimilated into this pipe so far. */
  observations: number;
  /** ISO 8601 with +05:30 of the last assimilation that moved this pipe. */
  lastUpdated: string;
}

/** Columns the operator can sort by; the rest are labels. */
export type DrainSortKey = "beta" | "sd" | "capacity";
export type SortDirection = "asc" | "desc";

const SORT_LABELS: Record<DrainSortKey, string> = {
  beta: "Blockage",
  sd: "Uncertainty",
  capacity: "Capacity reduction",
};

function sortValue(row: DrainHealthRow, key: DrainSortKey): number {
  if (key === "beta") return row.betaMean;
  if (key === "sd") return row.betaSd;
  return row.capacityReduction;
}

/** Sorts a copy of `rows`; worst-first by default so the desilting list reads top-down. */
export function sortDrainRows(
  rows: readonly DrainHealthRow[],
  key: DrainSortKey,
  direction: SortDirection,
): DrainHealthRow[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => (sortValue(a, key) - sortValue(b, key)) * factor);
}

export interface DrainHealthTableProps {
  rows: readonly DrainHealthRow[];
  className?: string;
}

/**
 * The desilting priority list (CLAUDE.md section 7.3): one row per inferred pipe with its
 * posterior blockage and the hotspots it explains. Blockage carries the magenta drain ramp as a
 * dot, but the number is always printed so colour is never the only carrier of meaning.
 */
export function DrainHealthTable({ rows, className }: DrainHealthTableProps) {
  const [sortKey, setSortKey] = useState<DrainSortKey>("beta");
  const [direction, setDirection] = useState<SortDirection>("desc");

  const sorted = useMemo(() => sortDrainRows(rows, sortKey, direction), [rows, sortKey, direction]);

  if (rows.length === 0) {
    return (
      <EmptyState
        size="sm"
        title="No drain health yet"
        description="Run a replay cycle: Pulse writes a posterior blockage for every pipe it can see."
        className={className}
      />
    );
  }

  const toggle = (key: DrainSortKey) => {
    if (key === sortKey) {
      setDirection((d) => (d === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(key);
    setDirection("desc");
  };

  const ariaSort = (key: DrainSortKey): "ascending" | "descending" | "none" =>
    key === sortKey ? (direction === "asc" ? "ascending" : "descending") : "none";

  const SortButton = ({ column }: { column: DrainSortKey }) => {
    const active = column === sortKey;
    const Icon = direction === "asc" ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        onClick={() => toggle(column)}
        className={cn(
          "inline-flex items-center gap-1 rounded-control px-1 py-0.5 text-left transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tide",
          active ? "text-text" : "text-text-2",
        )}
      >
        {SORT_LABELS[column]}
        {active ? <Icon size={12} strokeWidth={1.75} aria-hidden="true" /> : null}
      </button>
    );
  };

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          Inferred pipes by posterior blockage, sortable by blockage, uncertainty and capacity
          reduction
        </caption>
        <thead>
          <tr className="border-b border-line type-micro text-text-2">
            <th scope="col" className="py-2 pr-3 font-medium">
              Pipe
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Street
            </th>
            <th scope="col" aria-sort={ariaSort("beta")} className="py-2 pr-3 font-medium">
              <SortButton column="beta" />
            </th>
            <th scope="col" aria-sort={ariaSort("sd")} className="py-2 pr-3 font-medium">
              <SortButton column="sd" />
            </th>
            <th scope="col" aria-sort={ariaSort("capacity")} className="py-2 pr-3 font-medium">
              <SortButton column="capacity" />
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Explains
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Observations
            </th>
            <th scope="col" className="py-2 font-medium">
              Last updated
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const band = drainBand(row.betaMean);
            return (
              <tr key={row.id} className="border-b border-line last:border-b-0 type-small">
                <th scope="row" className="num py-2 pr-3 font-medium text-text">
                  {row.id}
                </th>
                <td className="py-2 pr-3 text-text-2">{row.street}</td>
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: cssVar(`--drain-${band.key}`) }}
                    />
                    <span className="num text-text">{formatBeta(row.betaMean)}</span>
                  </span>
                </td>
                <td className="num py-2 pr-3 text-text-2">{formatBeta(row.betaSd)}</td>
                <td className="num py-2 pr-3 text-text-2">{formatPct(row.capacityReduction)}</td>
                <td className="py-2 pr-3 text-text-2">
                  {row.hotspotsExplained.length > 0 ? row.hotspotsExplained.join(", ") : "—"}
                </td>
                <td className="num py-2 pr-3 text-text-2">{formatCount(row.observations)}</td>
                <td className="num py-2 text-text-2">{formatIst(row.lastUpdated)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
