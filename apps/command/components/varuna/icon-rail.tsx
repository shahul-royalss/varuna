"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { NAV_ITEMS, isNavActive } from "@/lib/nav";

export interface IconRailProps {
  className?: string;
}

/** The 56 px icon rail on the left of every console screen (CLAUDE.md sections 6.5 and 7.2). */
export function IconRail({ className }: IconRailProps) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Screens"
      className={cn(
        "flex w-icon-rail shrink-0 flex-col items-center gap-1 border-r border-line bg-deep py-2",
        className,
      )}
    >
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
                    "relative flex size-10 items-center justify-center rounded-control text-text-3",
                    "hover:bg-well hover:text-text-2",
                    active && "text-tide hover:text-tide",
                  )}
                />
              }
            >
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 bottom-1.5 -left-2 w-0.5 rounded-chip bg-tide"
                />
              ) : null}
              <Icon aria-hidden="true" className="size-5" strokeWidth={1.75} />
            </TooltipTrigger>
            <TooltipContent side="right">
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
