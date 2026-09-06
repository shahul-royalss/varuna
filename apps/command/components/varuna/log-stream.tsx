"use client";

import { useEffect, useRef } from "react";

import { EmptyState } from "@/components/varuna/empty-state";
import { formatIst } from "@/lib/format";
import { cn } from "@/lib/utils";

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  /** ISO 8601 timestamp of the log record. */
  ts: string;
  level?: LogLevel;
  /** The pipeline's own message, never scripted copy. */
  text: string;
}

export interface LogStreamProps {
  lines: LogLine[];
  /** Height of the scroll area; defaults to 16 rem. */
  className?: string;
  /** Empty-state description; the wizard's default says where logs come from. */
  emptyDescription?: string;
}

/**
 * Monospace log area (Geist Mono is allowed for log streams, CLAUDE.md section 6.3) that follows
 * the newest line. Rendered as a live region so screen readers hear progress.
 */
export function LogStream({
  lines,
  className,
  emptyDescription = "Logs stream here when the wizard runs.",
}: LogStreamProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [lines.length]);

  if (lines.length === 0) {
    return (
      <div
        className={cn(
          "flex h-64 items-center justify-center rounded-control border border-line bg-ink",
          className,
        )}
      >
        <EmptyState size="sm" title="No logs yet" description={emptyDescription} />
      </div>
    );
  }

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Pipeline log"
      className={cn(
        "h-64 overflow-y-auto rounded-control border border-line bg-ink p-3 font-mono text-micro leading-relaxed",
        className,
      )}
    >
      {lines.map((line, i) => (
        <div
          key={`${line.ts}-${i}`}
          className={cn(
            "flex gap-3 whitespace-pre-wrap",
            line.level === "error" && "text-status-degraded",
            line.level === "warn" && "text-text",
            (line.level ?? "info") === "info" && "text-text-2",
          )}
        >
          <span className="num shrink-0 text-text-3">{formatIst(line.ts, { seconds: true })}</span>
          <span className="min-w-0 break-words">{line.text}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
