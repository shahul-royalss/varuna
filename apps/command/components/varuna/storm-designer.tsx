"use client";

import { Radar } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/varuna/empty-state";
import { formatIst, formatMinutes } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One convective cell of the storm designer (CLAUDE.md section 10.2). */
export interface StormCell {
  id: string;
  /** Birth time, ISO 8601 with +05:30. */
  birth: string;
  lifetimeMin: number;
  /** Start point in WGS84. */
  startLat: number;
  startLon: number;
  /** Advection speed in m/s (wind from the south-west for the demo). */
  velocityMs: number;
  /** Gaussian sigma in km. */
  sigmaKm: number;
  /** Peak intensity in mm/h. */
  peakMmH: number;
}

export interface StormDesignerProps {
  /** Cells of the selected bundle; empty until the bundle is generated. */
  cells: StormCell[];
  /** Bundle the preview would play. */
  bundleId: string;
  /** Reason the storm cannot be edited yet. */
  generateDisabledReason?: string;
  className?: string;
}

/** "19.012, 72.841" for a start point. */
export function formatLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

/**
 * Read-only storm designer: the cell table, the radar preview slot and a disabled
 * "Generate bundle" that says why. Editing is a pilot feature; the demo storm is fixed by seed.
 */
export function StormDesigner({
  cells,
  bundleId,
  generateDisabledReason = "Editing the storm is coming in pilot; the demo storm is read-only",
  className,
}: StormDesignerProps) {
  const helpId = "storm-designer-generate-help";

  return (
    <div className={cn("space-y-4", className)}>
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="min-w-0">
          {cells.length === 0 ? (
            <EmptyState
              icon={Radar}
              title="No storm cells yet"
              description="Storm cells appear when the bundle is generated."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Birth time</TableHead>
                    <TableHead>Lifetime</TableHead>
                    <TableHead>Start point</TableHead>
                    <TableHead className="text-right">Velocity</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">Peak intensity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cells.map((cell) => (
                    <TableRow key={cell.id} className="h-8">
                      <TableCell className="num">{formatIst(cell.birth)}</TableCell>
                      <TableCell className="num">{formatMinutes(cell.lifetimeMin)}</TableCell>
                      <TableCell className="num">{formatLatLon(cell.startLat, cell.startLon)}</TableCell>
                      <TableCell className="num text-right">{cell.velocityMs.toFixed(1)} m/s</TableCell>
                      <TableCell className="num text-right">{cell.sigmaKm.toFixed(1)} km</TableCell>
                      <TableCell className="num text-right">{Math.round(cell.peakMmH)} mm/h</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div
          role="region"
          aria-label="Radar preview"
          className="relative flex min-h-48 items-center justify-center overflow-hidden rounded-control border border-line bg-ink"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-35"
            style={{
              backgroundImage:
                "radial-gradient(circle, var(--line) 1px, transparent 1px), radial-gradient(circle, transparent 60%, var(--deep) 100%)",
              backgroundSize: "24px 24px, 100% 100%",
            }}
          />
          <EmptyState
            size="sm"
            icon={Radar}
            title="Radar preview plays from the bundle"
            description={`Frames every 10 minutes over the 60 km domain, read from ${bundleId} once it is generated.`}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button variant="outline" disabled aria-describedby={helpId}>
          Generate bundle
        </Button>
        <p id={helpId} className="type-micro text-text-3">
          {generateDisabledReason}
        </p>
      </div>
    </div>
  );
}
