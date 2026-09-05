"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatMs, shortenRunId } from "@/lib/format";
import { totalStageMs, useRunStore } from "@/lib/stores/run";

export interface RunStampProps {
  className?: string;
}

/**
 * "run MUM-20190702T1740-sky1.0-twin1.0-flash0.3 · baked · 3.9 s" with click-to-copy
 * (CLAUDE.md section 7.2). Empty state: "No run".
 */
export function RunStamp({ className }: RunStampProps) {
  const run = useRunStore((s) => s.currentRun);

  if (!run) {
    return (
      <span className={cn("text-small text-text-3", className)} data-slot="run-stamp">
        No run
      </span>
    );
  }

  const ms = totalStageMs(run);
  const chipClass =
    run.replay_mode === "baked"
      ? "border-status-baked/40 bg-status-baked/10 text-status-baked"
      : "border-status-live/40 bg-status-live/10 text-status-live";

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(run.run_id);
      toast("Run id copied");
    } catch {
      toast("Copy failed. Select the run id in the replay panel and copy it by hand.");
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Copy run id"
            data-slot="run-stamp"
            onClick={() => void copy()}
            className={cn(
              "group inline-flex h-7 min-w-0 items-center gap-2 rounded-control border border-line bg-well/40 px-2.5",
              "text-small text-text-2 hover:bg-well hover:text-text",
              className,
            )}
          />
        }
      >
        <span className="text-text-3">run</span>
        <span className="num truncate font-mono text-small text-text">{shortenRunId(run.run_id)}</span>
        <span
          className={cn(
            "inline-flex h-5 items-center rounded-chip border px-1.5 text-micro font-medium",
            chipClass,
          )}
        >
          {run.replay_mode}
        </span>
        {ms !== null ? <span className="num text-text-2">{formatMs(ms)}</span> : null}
        <Copy aria-hidden="true" className="size-4 text-text-3 group-hover:text-text-2" strokeWidth={1.75} />
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono">{run.run_id}</span>
        <span className="text-text-2">Click to copy</span>
      </TooltipContent>
    </Tooltip>
  );
}
