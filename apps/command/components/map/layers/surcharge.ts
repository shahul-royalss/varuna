/**
 * Surcharging manholes and their pulse (CLAUDE.md 6.7, motion M8).
 */

import { ScatterplotLayer } from "@deck.gl/layers";
import { useEffect, useState } from "react";

import { DUR_MS } from "@/lib/motion";
import { SURCHARGE_LINE, SURCHARGE_RGB } from "./palette";
import type { SurchargeNode, SurchargeStyle } from "./types";

/** Steps the pulse is quantised to over its 1.6 s: 20 is smooth and costs 12 renders a second. */
export const PULSE_FRAMES = 20;

/**
 * Phase 0-1 of the surcharge pulse, or a fixed 0 when it should not run (motion M8).
 *
 * The loop runs every display frame but the phase it publishes is quantised, and the setter
 * bails when the value has not changed - so React re-renders `PULSE_FRAMES` times per cycle
 * (12.5 a second) rather than 60. Quantising also makes the pulse the same size on a 60 Hz and
 * a 144 Hz display.
 *
 * The surcharge markers are the only looping thing on the console, and CLAUDE.md 8 allows it
 * because a pulsing manhole is data - it is the drain failing - not decoration.
 */
export function useSurchargePulse(active: boolean): number {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const next =
        Math.round(
          (((now - started) % DUR_MS.surchargePulse) / DUR_MS.surchargePulse) * PULSE_FRAMES,
        ) / PULSE_FRAMES;
      setPhase((current) => (current === next ? current : next));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // Read through `active` rather than resetting the state when the loop stops: a phase left over
  // from the last pulse would otherwise freeze the ring mid-expansion under reduced motion.
  return active ? phase : 0;
}

export interface SurchargeLayerOptions {
  surcharge: readonly SurchargeNode[];
  show: boolean;
  /** 0-1 from `useSurchargePulse`. */
  pulse: number;
  /** Seam for PU8: `/drains` wants static rings. **Not applied yet** - every map pulses. */
  style?: SurchargeStyle;
}

/**
 * Rebuilt on every pulse frame, and therefore memoised on its own by `CityMap` so that a pulse
 * re-uploads nothing but the markers.
 */
export function surchargeLayers({ surcharge, show, pulse }: SurchargeLayerOptions): unknown[] {
  if (!show || surcharge.length === 0) return [];
  const grow = 1 + 1.4 * pulse;
  const fade = Math.round(200 * (1 - pulse));
  return [
    new ScatterplotLayer<SurchargeNode>({
      id: "surcharge",
      data: surcharge as SurchargeNode[],
      getPosition: (d) => [d.lon, d.lat],
      // Radius by discharge, so a manhole shifting 0.4 m³/s reads bigger than one at 0.01.
      // Square root because the eye compares areas, and the marker's area is what it is.
      getRadius: (d) => 40 + 110 * Math.sqrt(Math.min(d.q ?? 0, 1)),
      radiusUnits: "meters",
      radiusMinPixels: 3,
      radiusMaxPixels: 16,
      radiusScale: grow,
      filled: true,
      getFillColor: [SURCHARGE_RGB[0], SURCHARGE_RGB[1], SURCHARGE_RGB[2], Math.max(fade, 70)],
      stroked: true,
      getLineColor: SURCHARGE_LINE,
      lineWidthMinPixels: 1,
      pickable: false,
      updateTriggers: { getRadius: surcharge, getFillColor: fade },
    }),
  ];
}

export interface DeckAnimationOptions {
  reducedMotion: boolean;
  surchargeVisible: number;
  reversedVisible: number;
}

/**
 * Whether deck must redraw every frame on its own (`DeckGL._animate`). Seam for MO3, which moves
 * the M8 pulse and the M9 dash onto a GPU clock. **False today**: the pulse above is a React state
 * loop, so deck redraws because its layers change, not because it animates.
 */
export function deckAnimates(options: DeckAnimationOptions): boolean {
  void options;
  return false;
}
