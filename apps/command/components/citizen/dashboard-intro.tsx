"use client";

import { useEffect } from "react";

export interface DashboardIntroProps {
  /** Called when the entry sequence has finished, or immediately when there is none. */
  onDone: () => void;
}

/**
 * The globe entry for the citizen dashboard (motion M27, UI_SPEC 2).
 *
 * The seam only, until task D-14 fills it: it hands over at once, so the dashboard behaves
 * exactly as it will under reduced motion - the map appears already framed on the city.
 */
export function DashboardIntro({ onDone }: DashboardIntroProps) {
  useEffect(() => {
    onDone();
  }, [onDone]);
  return null;
}
