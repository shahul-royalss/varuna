"use client";

import { AgreementBar } from "@/components/varuna/agreement-bar";
import { EmptyState } from "@/components/varuna/empty-state";
import { Skeleton } from "@/components/varuna/skeleton";
import { formatCmPrecise, formatCmSigned, formatMassBalance, formatMs } from "@/lib/format";
import type { PhysicsCheckResult } from "@/lib/api/whatif";
import { cn } from "@/lib/utils";

export interface PhysicsCheckPanelProps {
  result: PhysicsCheckResult | null;
  running: boolean;
  /** The endpoint's own refusal or failure, in its words (CLAUDE.md 6.8). */
  error: string | null;
  /** Rows to list; the lab shows them all and the console drawer fewer. */
  maxRows?: number;
  className?: string;
}

/**
 * The answer to "Physics check" (CLAUDE.md 7.7, P7.8): section 7.7's sentence as a bar, then the
 * junctions it was measured at, each as the emulator's change beside the Twin's.
 *
 * Changes and not levels, because that is what the endpoint compares: a 990 m crop's absolute
 * depth is not the city's, and printing a level from it would publish a number the whole-AOI run
 * disagrees with. The disagreement is always printed, and so is the check's own cost against its
 * 10 s budget - a check that took longer than the budget says so rather than looking instant.
 */
export function PhysicsCheckPanel({
  result,
  running,
  error,
  maxRows = 6,
  className,
}: PhysicsCheckPanelProps) {
  if (running) {
    return (
      <div className={cn("space-y-2", className)} aria-busy="true">
        <p className="type-small text-text-3">
          Running the Twin twice on a window around the worst junction
        </p>
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (error) {
    return <EmptyState title="Physics check refused" description={error} className={className} />;
  }
  if (!result) {
    return <AgreementBar result={null} className={className} />;
  }
  if (result.maxDiffCm === null) {
    return (
      <EmptyState
        title="Nothing to compare"
        description={`${result.summary}. Junctions outside the window: ${result.outside.join(", ") || "none"}.`}
        className={className}
      />
    );
  }

  const rows = result.hotspots.slice(0, maxRows);
  const overBudget = result.ms > result.budgetMs;
  return (
    <div className={cn("space-y-3", className)}>
      <AgreementBar
        result={{
          maxDiffCm: result.maxDiffCm,
          atHotspot: result.maxDiffHotspot ?? undefined,
          physicsMs: result.ms,
        }}
        toleranceCm={result.toleranceCm}
      />
      <table className="type-small w-full">
        <caption className="sr-only">
          Change in peak depth per junction, emulator against Twin
        </caption>
        <thead>
          <tr className="text-text-3 type-micro">
            <th scope="col" className="py-1 text-left font-normal">
              Junction
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              Emulator
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              Twin
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              Difference
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.hotspotId} className="border-line border-t">
              <th scope="row" className="text-text py-1.5 text-left font-normal">
                {row.name}
              </th>
              <td className="num text-text-2 py-1.5 text-right">
                {formatCmSigned(row.emulatorDeltaCm)}
              </td>
              <td className="num text-text-2 py-1.5 text-right">
                {formatCmSigned(row.twinDeltaCm)}
              </td>
              <td className="num text-text py-1.5 text-right">{formatCmPrecise(row.diffCm)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="type-micro text-text-3">
        The Twin ran twice on a <span className="num">{result.window.sizeM}</span> m window around{" "}
        {result.window.centre}, with{" "}
        <span className="num">{result.window.edges.toLocaleString("en-IN")}</span> pipes, in{" "}
        <span className="num">{formatMs(result.ms)}</span>
        {overBudget ? ", over" : ", inside"} the{" "}
        <span className="num">{formatMs(result.budgetMs)}</span> budget. Mass balance{" "}
        <span className="num">{formatMassBalance(result.massBalance.scenario)}</span> on the
        scenario run.
        {result.outside.length > 0
          ? ` Not in the window, so not checked: ${result.outside.join(", ")}.`
          : ""}
      </p>
    </div>
  );
}
