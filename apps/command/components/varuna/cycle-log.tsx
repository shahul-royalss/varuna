"use client";

import { EmptyState } from "@/components/varuna/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMs, formatMassBalance } from "@/lib/format";
import { formatIstTime } from "@/lib/stores/time";

export interface CycleLogRow {
  /** Cycle time, ISO 8601 with +05:30. */
  time: string;
  /** Stages that ran, e.g. "decode, sky, twin, flash, pulse, products". */
  stages: string;
  /** Total stage time in milliseconds. */
  ms: number;
  /** Mass-balance error as a fraction (0.0008 = 0.08 %); null when the cycle was baked without one. */
  massBalance: number | null;
}

export interface CycleLogProps {
  rows: CycleLogRow[];
}

/** The replay panel's cycle log: one row per published cycle with stage timings and mass balance. */
export function CycleLog({ rows }: CycleLogProps) {
  if (rows.length === 0) {
    return (
      <EmptyState title="No cycles yet" description="Press Play on the replay." />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Stages</TableHead>
            <TableHead className="text-right">Time taken</TableHead>
            <TableHead className="text-right">Mass balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.time} className="h-8">
              <TableCell className="num">{formatIstTime(row.time)}</TableCell>
              <TableCell className="text-text-2">{row.stages}</TableCell>
              <TableCell className="num text-right">{formatMs(row.ms)}</TableCell>
              <TableCell className="num text-right">
                {formatMassBalance(row.massBalance)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
