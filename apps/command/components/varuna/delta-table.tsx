"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DepthChip } from "@/components/varuna/depth-chip";
import { EmptyState } from "@/components/varuna/empty-state";
import { formatMinutes } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One hotspot's before and after under a what-if scenario (CLAUDE.md section 7.7). */
export interface DeltaRow {
  id: string;
  /** Hotspot name, e.g. "Hindmata junction". */
  hotspot: string;
  /** p50 peak depth in cm before the scenario. */
  beforeCm: number;
  /** p50 peak depth in cm after the scenario. */
  afterCm: number;
  /** Minutes the hotspot is impassable for cars (above 30 cm) before the scenario. */
  minutesImpassableBefore: number;
  /** The same after the scenario. */
  minutesImpassableAfter: number;
}

export interface DeltaTableProps {
  rows: DeltaRow[];
  className?: string;
}

/** Signed centimetre change: "-35 cm", "+4 cm", "0 cm". */
export function formatDeltaCm(beforeCm: number, afterCm: number): string {
  const delta = Math.round(afterCm) - Math.round(beforeCm);
  if (delta === 0) return "0 cm";
  return `${delta < 0 ? "-" : "+"}${Math.abs(delta)} cm`;
}

/**
 * Before and after per hotspot for a what-if result. Depth shows as chips on the fixed ramp so the
 * table agrees with the diff layer; the change column is signed and coloured only as a hint.
 */
export function DeltaTable({ rows, className }: DeltaTableProps) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No what-if yet"
        description="Set the controls and run one."
        className={className}
      />
    );
  }

  return (
    <div className={cn("overflow-x-auto", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Hotspot</TableHead>
            <TableHead>Before</TableHead>
            <TableHead>After</TableHead>
            <TableHead className="text-right">Change</TableHead>
            <TableHead className="text-right">Minutes impassable</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const improved = row.afterCm < row.beforeCm;
            const worse = row.afterCm > row.beforeCm;
            return (
              <TableRow key={row.id} className="h-10">
                <TableCell className="font-medium text-text">{row.hotspot}</TableCell>
                <TableCell>
                  <DepthChip cm={row.beforeCm} size="sm" />
                </TableCell>
                <TableCell>
                  <DepthChip cm={row.afterCm} size="sm" />
                </TableCell>
                <TableCell
                  className={cn(
                    "num text-right",
                    improved && "text-tide",
                    worse && "text-text",
                    !improved && !worse && "text-text-3",
                  )}
                >
                  {formatDeltaCm(row.beforeCm, row.afterCm)}
                </TableCell>
                <TableCell className="num text-right text-text-2">
                  {formatMinutes(row.minutesImpassableBefore)} &rarr;{" "}
                  <span className="text-text">{formatMinutes(row.minutesImpassableAfter)}</span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
