"use client";

import { ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface CitySwitcherProps {
  className?: string;
}

/**
 * City switcher in the top bar. Mumbai is the only city until the Chennai wizard has run;
 * the Chennai row stays visible so the jury can see where the second city will appear.
 */
export function CitySwitcher({ className }: CitySwitcherProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch city"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-control px-2 text-body font-medium text-text",
          "hover:bg-well aria-expanded:bg-well",
          className,
        )}
      >
        Mumbai
        <ChevronDown aria-hidden="true" className="size-4 text-text-3" strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuCheckboxItem checked>Mumbai</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={false} disabled>
          <span className="flex min-w-0 flex-col">
            <span>Chennai</span>
            <span className="text-micro text-text-3">Onboard first</span>
          </span>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
