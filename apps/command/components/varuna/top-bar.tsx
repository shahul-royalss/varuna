"use client";

import type { Route } from "next";
import Link from "next/link";
import { Keyboard, Search, Settings2 } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CitySwitcher } from "@/components/varuna/city-switcher";
import { ModeBanner } from "@/components/varuna/mode-banner";
import { RunStamp } from "@/components/varuna/run-stamp";
import { VerificationChip } from "@/components/varuna/verification-chip";
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

/** The 52 px top bar (CLAUDE.md section 7.2): wordmark, city, mode, run stamp, score, controls. */
export function TopBar({ className }: TopBarProps) {
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const toggleShortcuts = useUiStore((s) => s.toggleShortcuts);
  const toggleSettings = useUiStore((s) => s.toggleSettings);

  return (
    <header
      className={cn(
        "flex h-top-bar shrink-0 items-center gap-3 border-b border-line bg-deep px-3",
        className,
      )}
    >
      <Link
        href={CONSOLE_HREF}
        aria-label="VARUNA console"
        className="flex shrink-0 items-center rounded-control px-1"
      >
        <Wordmark size="sm" withMark />
      </Link>

      <CitySwitcher />

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ModeBanner />
        <RunStamp className="hidden lg:inline-flex" />
        <VerificationChip className="hidden xl:inline-flex" />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Search and commands"
                onClick={() => setCommandPaletteOpen(true)}
                className={iconButtonClass}
              />
            }
          >
            <Search aria-hidden="true" className="size-5" strokeWidth={1.75} />
            <kbd className="rounded-[4px] border border-line bg-well px-1.5 font-sans text-micro text-text-2">
              Ctrl K
            </kbd>
          </TooltipTrigger>
          <TooltipContent>Search and commands</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Keyboard shortcuts"
                onClick={toggleShortcuts}
                className={cn(iconButtonClass, "w-8")}
              />
            }
          >
            <Keyboard aria-hidden="true" className="size-5" strokeWidth={1.75} />
          </TooltipTrigger>
          <TooltipContent>
            Keyboard shortcuts
            <kbd className="rounded-[4px] border border-line bg-well px-1 font-sans text-micro text-text-2">
              ?
            </kbd>
          </TooltipContent>
        </Tooltip>

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
