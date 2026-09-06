"use client";

import { depthColor } from "@/lib/ramps";
import { cn } from "@/lib/utils";

export const DEPTH_HINTS = ["ankle", "knee", "waist"] as const;
export type DepthHint = (typeof DEPTH_HINTS)[number];

export interface DepthHintOption {
  hint: DepthHint;
  label: string;
  /** The centimetre value Pulse assumes for this chip (CLAUDE.md section 11.6). */
  cm: number;
  hintText: string;
}

export const DEPTH_HINT_OPTIONS: readonly DepthHintOption[] = [
  { hint: "ankle", label: "Ankle", cm: 10, hintText: "about 10 cm" },
  { hint: "knee", label: "Knee", cm: 45, hintText: "about 45 cm" },
  { hint: "waist", label: "Waist", cm: 90, hintText: "about 90 cm" },
];

export function isDepthHint(value: string): value is DepthHint {
  return (DEPTH_HINTS as readonly string[]).includes(value);
}

export interface DepthChipsProps {
  value: DepthHint | null;
  onValueChange: (hint: DepthHint) => void;
  className?: string;
}

/**
 * Ankle, knee, waist: how a person on a flooded street actually measures water. Tiles are 44 px
 * tall for a thumb, and the colour is backed by the centimetre text so colour is never alone.
 */
export function DepthChips({ value, onValueChange, className }: DepthChipsProps) {
  return (
    <div role="radiogroup" aria-label="How deep is the water" className={cn("grid grid-cols-3 gap-2", className)}>
      {DEPTH_HINT_OPTIONS.map((option) => {
        const selected = value === option.hint;
        return (
          <button
            key={option.hint}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onValueChange(option.hint)}
            className={cn(
              "flex min-h-[68px] flex-col items-start justify-center gap-1 rounded-control border px-3 py-2 text-left",
              "focus-visible:ring-2 focus-visible:ring-tide focus-visible:outline-none",
              selected ? "border-line-strong bg-well" : "border-line bg-deep hover:bg-well",
            )}
          >
            <span className="flex items-center gap-2 type-small font-medium text-text">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: depthColor(option.cm) }}
              />
              {option.label}
            </span>
            <span className="num type-micro text-text-2">{option.hintText}</span>
          </button>
        );
      })}
    </div>
  );
}
