"use client";

import { useCallback, useState } from "react";
import { motion, type PanInfo } from "motion/react";

import { DUR, EASE_UI } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export type SheetSnap = "collapsed" | "half" | "full";

/** Snap heights as a share of the sheet's container; collapsed is a fixed 96 px. */
export const SNAP_ORDER: readonly SheetSnap[] = ["collapsed", "half", "full"];
export const COLLAPSED_HEIGHT_PX = 96;

const SNAP_LABEL: Record<SheetSnap, string> = {
  collapsed: "Collapsed",
  half: "Half open",
  full: "Fully open",
};

function heightFor(snap: SheetSnap, containerHeight: number): number {
  if (snap === "collapsed") return COLLAPSED_HEIGHT_PX;
  if (snap === "half") return Math.max(COLLAPSED_HEIGHT_PX, Math.round(containerHeight * 0.5));
  return Math.max(COLLAPSED_HEIGHT_PX, Math.round(containerHeight * 0.88));
}

/** Next snap for a tap, wrapping back to collapsed from full (the reduced-motion path, M24). */
export function nextSnap(snap: SheetSnap): SheetSnap {
  const index = SNAP_ORDER.indexOf(snap);
  return SNAP_ORDER[(index + 1) % SNAP_ORDER.length] ?? "collapsed";
}

/** Snap chosen by a drag: a fast flick moves one step, a slow drag picks the nearest stop. */
export function snapForDrag(snap: SheetSnap, offsetY: number, velocityY: number): SheetSnap {
  const index = SNAP_ORDER.indexOf(snap);
  const flick = Math.abs(velocityY) > 500;
  const moved = flick || Math.abs(offsetY) > 64;
  if (!moved) return snap;
  const direction = (flick ? velocityY : offsetY) < 0 ? 1 : -1;
  const next = Math.min(SNAP_ORDER.length - 1, Math.max(0, index + direction));
  return SNAP_ORDER[next] ?? snap;
}

export interface BottomSheetProps {
  /** Height of the surface the sheet sits over, in pixels; half and full are shares of it. */
  containerHeight: number;
  /** Sheet title, announced and shown next to the handle. */
  title: string;
  children?: React.ReactNode;
  className?: string;
  defaultSnap?: SheetSnap;
}

/**
 * The public map's bottom sheet (CLAUDE.md motion M24): drag with snap points, and tap the handle
 * to step through them when the reader prefers reduced motion or uses a keyboard.
 */
export function BottomSheet({
  containerHeight,
  title,
  children,
  className,
  defaultSnap = "collapsed",
}: BottomSheetProps) {
  const [snap, setSnap] = useState<SheetSnap>(defaultSnap);
  const reduced = usePrefersReducedMotion();
  const height = heightFor(snap, containerHeight);

  const onDragEnd = useCallback(
    (_event: unknown, info: PanInfo) => {
      setSnap((current) => snapForDrag(current, info.offset.y, info.velocity.y));
    },
    [],
  );

  return (
    <motion.div
      role="dialog"
      aria-label={title}
      className={cn(
        "absolute inset-x-0 bottom-0 z-20 flex flex-col overflow-hidden rounded-t-panel border-t border-line bg-deep",
        className,
      )}
      animate={{ height }}
      initial={false}
      transition={reduced ? { duration: 0 } : { duration: DUR.panel, ease: EASE_UI }}
      drag={reduced ? false : "y"}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={0.06}
      onDragEnd={reduced ? undefined : onDragEnd}
    >
      <button
        type="button"
        aria-label={`${title}, ${SNAP_LABEL[snap].toLowerCase()}. Tap to expand or collapse`}
        onClick={() => setSnap(nextSnap(snap))}
        className="flex w-full shrink-0 flex-col items-center gap-2 px-4 pt-2 pb-3 focus-visible:ring-2 focus-visible:ring-tide focus-visible:outline-none"
      >
        <span aria-hidden="true" className="h-1 w-10 rounded-chip bg-line-strong" />
        <span className="w-full text-left type-small font-medium text-text">{title}</span>
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
    </motion.div>
  );
}
