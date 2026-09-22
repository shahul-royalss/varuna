"use client";

import type { Route } from "next";
import Link from "next/link";
import { Settings2 } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CitySwitcher } from "@/components/varuna/city-switcher";
import { IconRail } from "@/components/varuna/icon-rail";
import { Wordmark } from "@/components/varuna/wordmark";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/lib/stores/ui";

const CONSOLE_HREF = "/console" as Route;

const iconButtonClass = cn(
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control px-1.5 text-text-2",
  "hover:bg-well hover:text-text aria-expanded:bg-well",
);

export interface TopBarProps {
  className?: string;
}

/** The 52 px top bar: wordmark, city and settings. */
export function TopBar({ className }: TopBarProps) {
  const toggleSettings = useUiStore((s) => s.toggleSettings);

  return (
    <header
      className={cn(
        "h-top-bar border-line bg-deep flex shrink-0 items-center gap-3 border-b px-3",
        className,
      )}
    >
      <Link
        href={CONSOLE_HREF}
        aria-label="VARUNA console"
        className="rounded-control flex shrink-0 items-center px-1"
      >
        <Wordmark size="sm" withMark />
      </Link>

      <CitySwitcher />

      {/* The bar carries the wordmark, the city, the screen nav and settings. The mode banner, the
          run stamp, the verification chip and the search and shortcuts buttons were removed at the
          team's request. Ctrl+K and ? still open the palette and the shortcuts overlay - the keys
          are unchanged, only the buttons are gone. The nav moved here from the left rail, also at
          the team's request, so it wraps to a scroll rather than pushing settings off a 1366 px
          bar. CLAUDE.md 6.5 and 7.2 still describe the older shell. */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <IconRail className="min-w-0 overflow-x-auto" />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Settings"
                onClick={toggleSettings}
                className={cn(iconButtonClass, "w-8")}
              />
            }
          >
            <Settings2 aria-hidden="true" className="size-5" strokeWidth={1.75} />
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
