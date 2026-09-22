"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { NAV_ITEMS, isNavActive } from "@/lib/nav";

export interface IconRailProps {
  className?: string;
}

/**
 * The screen nav: every console screen, as icons with their label and key in the tooltip.
 *
 * It ran down the left of the shell as a 56 px vertical rail (CLAUDE.md sections 6.5 and 7.2).
 * At the team's request it now sits in the top bar and runs across, so the map gets those 56 px
 * back and the bar - which lost its mode banner, run stamp and chips - carries the navigation
 * instead of empty space. The active screen is marked by an underline rather than the old left
 * edge, because an edge marker reads as a border in a horizontal strip. CLAUDE.md 6.5 still draws
 * the older shell.
 */
export function IconRail({ className }: IconRailProps) {
  const pathname = usePathname();

  return (
    <nav aria-label="Screens" className={cn("flex items-center gap-0.5", className)}>
      {NAV_ITEMS.map((item) => {
        const active = isNavActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Tooltip key={item.id}>
            <TooltipTrigger
              render={
                <Link
                  href={item.href}
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  data-active={active ? "" : undefined}
                  className={cn(
                    "relative flex size-9 items-center justify-center rounded-control text-text-3",
                    "hover:bg-well hover:text-text-2",
                    active && "text-tide hover:text-tide",
                  )}
                />
              }
            >
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute right-1.5 bottom-0 left-1.5 h-0.5 rounded-chip bg-tide"
                />
              ) : null}
              <Icon aria-hidden="true" className="size-5" strokeWidth={1.75} />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span>{item.label}</span>
              <kbd className="rounded-[4px] border border-line bg-well px-1 font-sans text-micro text-text-2">
                {item.hint}
              </kbd>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
