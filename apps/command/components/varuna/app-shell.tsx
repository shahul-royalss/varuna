"use client";

import { IconRail } from "@/components/varuna/icon-rail";
import { useLatestRun } from "@/lib/hooks/use-latest-run";
import { TopBar } from "@/components/varuna/top-bar";
import { cn } from "@/lib/utils";

export interface AppShellProps {
  children: React.ReactNode;
  /** The 360 px right rail (hotspots, alerts, pumps, reachability). Omit on screens without one. */
  rightRail?: React.ReactNode;
  /** The 96 px time bar. Omit on screens without a scrub. */
  bottomBar?: React.ReactNode;
  className?: string;
}

/**
 * The console shell (CLAUDE.md section 6.5): 52 px top bar, 56 px icon rail, the main canvas,
 * an optional 360 px right rail and an optional 96 px bottom bar. Fills the viewport and never
 * scrolls as a page; each region scrolls on its own.
 */
export function AppShell({ children, rightRail, bottomBar, className }: AppShellProps) {
  // Every screen wearing this chrome shows the same run stamp, so every screen loads the run.
  useLatestRun();

  return (
    <div
      data-slot="app-shell"
      className={cn("flex h-dvh min-h-0 flex-col overflow-hidden bg-ink text-text", className)}
    >
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <IconRail />
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
        {rightRail ? (
          <aside
            data-slot="right-rail"
            aria-label="Right rail"
            className="flex w-right-rail shrink-0 flex-col overflow-y-auto border-l border-line bg-deep"
          >
            {rightRail}
          </aside>
        ) : null}
      </div>
      {bottomBar ? (
        <div data-slot="bottom-bar" className="h-time-bar shrink-0 border-t border-line">
          {bottomBar}
        </div>
      ) : null}
    </div>
  );
}
