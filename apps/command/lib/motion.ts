/**
 * The motion catalogue (CLAUDE.md section 8) as code. Nothing on a screen may move unless it is
 * a row in `M`; every row has a reduced-motion branch. Durations are seconds (framer units);
 * `DUR_MS` carries the same numbers in milliseconds for CSS, deck.gl and timers.
 *
 * Constants are safe to import anywhere. `useMotionPref()` is a client hook.
 */
import { useReducedMotion, type Target, type TargetAndTransition, type Transition } from "motion/react";
import { tokens } from "@varuna/tokens";

/** Global UI easing: cubic-bezier(0.2, 0.8, 0.2, 1). */
export const EASE_UI: readonly [number, number, number, number] = [0.2, 0.8, 0.2, 1];

/** Spring for handles and pins (stiffness 400, damping 32). */
export const SPRING: Transition = {
  type: "spring",
  stiffness: tokens.motion.spring.stiffness,
  damping: tokens.motion.spring.damping,
};

/** Durations in milliseconds, from tokens.json plus the per-row values in section 8. */
export const DUR_MS = {
  micro: tokens.motion.duration_ms.micro,
  microMin: tokens.motion.duration_ms.micro_min,
  microMax: tokens.motion.duration_ms.micro_max,
  panel: tokens.motion.duration_ms.panel,
  flight: tokens.motion.duration_ms.flight,
  drawOnMax: tokens.motion.duration_ms.draw_on_max,
  surchargePulse: tokens.motion.surcharge_pulse_ms,
  heroLoop: 8000,
  colourTween: 120,
  drawerSlide: 220,
  crossFade: 300,
  diffWipe: 500,
  rowHighlight: 600,
  routeDrawOn: 1200,
  alertSlide: 180,
  phoneShake: 300,
  pinRipple: 600,
  layerFade: 400,
  budgetFill: 200,
  staggerCopy: 60,
  staggerPipes: 40,
} as const;

/** The same durations in seconds for framer transitions. */
export const DUR = Object.fromEntries(
  Object.entries(DUR_MS).map(([key, ms]) => [key, ms / 1000]),
) as { readonly [K in keyof typeof DUR_MS]: number };

/** MapLibre flyTo curve. */
export const FLY_TO_CURVE = tokens.motion.fly_to_curve;

/** Tween on the global easing; the default for micro and panel motions. */
export function tween(seconds: number, extra: Transition = {}): Transition {
  return { duration: seconds, ease: EASE_UI, ...extra };
}

export type MotionId =
  | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8" | "M9" | "M10" | "M11" | "M12"
  | "M13" | "M14" | "M15" | "M16" | "M17" | "M18" | "M19" | "M20" | "M21" | "M22" | "M23" | "M24";

/** Framer props for one motion; spread onto a `motion.*` element. */
export interface MotionPreset {
  initial?: Target | false;
  animate?: TargetAndTransition;
  exit?: TargetAndTransition;
  transition?: Transition;
}

export interface MotionSpec {
  id: MotionId;
  where: string;
  motion: string;
  trigger: string;
  /** What the reduced-motion user sees instead. */
  reduced: string;
  /** Framer preset for the full motion; absent when the motion lives in CSS, deck.gl or MapLibre. */
  full?: MotionPreset;
  /** Framer preset under reduced motion; absent means render the final state with no animation. */
  fallback?: MotionPreset;
}

const instant: MotionPreset = { initial: false, animate: { opacity: 1 }, transition: { duration: 0 } };

/** Every row of the catalogue. Add a row here before adding a motion anywhere. */
export const M: Readonly<Record<MotionId, MotionSpec>> = {
  M1: {
    id: "M1",
    where: "Landing hero",
    motion: "Map auto-scrubs -60 to +180 min in 8 s, loops, pauses on hover",
    trigger: "page load",
    reduced: "static +120 min frame",
  },
  M2: {
    id: "M2",
    where: "Landing hero copy",
    motion: "Blur-fade entrance, stagger 60 ms, once",
    trigger: "page load",
    reduced: "instant",
    full: {
      initial: { opacity: 0, filter: "blur(6px)", y: 6 },
      animate: { opacity: 1, filter: "blur(0px)", y: 0 },
      transition: tween(DUR.panel),
    },
    fallback: instant,
  },
  M3: {
    id: "M3",
    where: "Landing cycle diagram",
    motion: "Beams travelling between pipeline nodes",
    trigger: "in view",
    reduced: "static arrows",
  },
  M4: {
    id: "M4",
    where: "Landing proof, hotspot drawer, delta tables",
    motion: "Numbers roll to new values (NumberFlow)",
    trigger: "value change or in view",
    reduced: "instant",
  },
  M5: {
    id: "M5",
    where: "Landing roadmap",
    motion: "Beam traces the timeline on scroll",
    trigger: "scroll",
    reduced: "static line",
  },
  M6: {
    id: "M6",
    where: "Console time bar",
    motion: "Scrub handle springs; layers restyle instantly",
    trigger: "drag or keys",
    reduced: "same, no spring",
    full: { transition: SPRING },
    fallback: { transition: { duration: 0 } },
  },
  M7: {
    id: "M7",
    where: "Console play mode",
    motion: "Depth colours tween between 5-min steps (120 ms)",
    trigger: "play",
    reduced: "no tween",
  },
  M8: {
    id: "M8",
    where: "Surcharge markers",
    motion: "Expanding ring pulse, 1.6 s",
    trigger: "data",
    reduced: "static ring",
  },
  M9: {
    id: "M9",
    where: "Reversed-flow edges",
    motion: "Dash offset animates in the flow direction",
    trigger: "data",
    reduced: "static dashed red",
  },
  M10: {
    id: "M10",
    where: "Hotspot select",
    motion: "900 ms fly-to plus ring highlight fades in",
    trigger: "click",
    reduced: "jump cut",
    full: { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: tween(DUR.panel) },
    fallback: instant,
  },
  M11: {
    id: "M11",
    where: "Hotspot and attribution drawer",
    motion: "Slides in 220 ms; responsible pipes glow in sequence (40 ms stagger)",
    trigger: "open",
    reduced: "instant",
    full: {
      initial: { x: 24, opacity: 0 },
      animate: { x: 0, opacity: 1 },
      exit: { x: 24, opacity: 0 },
      transition: tween(DUR.drawerSlide),
    },
    fallback: instant,
  },
  M12: {
    id: "M12",
    where: "Drain X-ray before and after",
    motion: "Pipe colours cross-fade 300 ms; hotspot depth rolls",
    trigger: "toggle",
    reduced: "instant",
    full: { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: tween(DUR.crossFade) },
    fallback: instant,
  },
  M13: {
    id: "M13",
    where: "What-if result",
    motion: "Diff layer wipes left to right 500 ms; delta rows highlight 600 ms",
    trigger: "result",
    reduced: "instant",
    full: {
      initial: { clipPath: "inset(0 100% 0 0)" },
      animate: { clipPath: "inset(0 0% 0 0)" },
      transition: tween(DUR.diffWipe),
    },
    fallback: instant,
  },
  M14: {
    id: "M14",
    where: "Route planner",
    motion: "Naive route draws dashed grey, VARUNA route draws on over 1.2 s; avoided segments flash once",
    trigger: "result",
    reduced: "both shown at once",
    full: { initial: { pathLength: 0 }, animate: { pathLength: 1 }, transition: tween(DUR.routeDrawOn) },
    fallback: { initial: false, animate: { pathLength: 1 }, transition: { duration: 0 } },
  },
  M15: {
    id: "M15",
    where: "Reachability",
    motion: "Isochrone polygons morph on scrub (300 ms)",
    trigger: "scrub",
    reduced: "instant",
  },
  M16: {
    id: "M16",
    where: "Alerts",
    motion: "Card slides into the queue 180 ms; phone mock message pops with a 300 ms shake and optional sound",
    trigger: "new alert",
    reduced: "fade only, no sound",
    full: {
      initial: { y: -12, opacity: 0 },
      animate: { y: 0, opacity: 1 },
      exit: { opacity: 0 },
      transition: tween(DUR.alertSlide),
    },
    fallback: { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: tween(DUR.micro) },
  },
  M17: {
    id: "M17",
    where: "Pump board",
    motion: "Card flies to the hotspot column; benefit numbers roll",
    trigger: "drag or optimise",
    reduced: "instant move",
    full: { transition: tween(DUR.panel) },
    fallback: { transition: { duration: 0 } },
  },
  M18: {
    id: "M18",
    where: "Ground-truth pins",
    motion: "Pin drops (scale 0 to 1 spring) with a 600 ms ripple; ticker row slides in",
    trigger: "replay clock passes timestamp",
    reduced: "pin appears, no ripple",
    full: { initial: { scale: 0, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: SPRING },
    fallback: instant,
  },
  M19: {
    id: "M19",
    where: "Onboarding",
    motion: "Each completed step stacks a map layer with a 400 ms fade; final depth fade-in",
    trigger: "step complete",
    reduced: "instant",
    full: { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: tween(DUR.layerFade) },
    fallback: instant,
  },
  M20: {
    id: "M20",
    where: "Mode banner",
    motion: "Colour cross-fade 300 ms; degraded pulses once",
    trigger: "mode change",
    reduced: "colour change only",
  },
  M21: {
    id: "M21",
    where: "Cycle budget bar",
    motion: "Stage segments fill as timings arrive (200 ms width tween)",
    trigger: "WS cycle.stage",
    reduced: "instant",
    full: { transition: tween(DUR.budgetFill) },
    fallback: { transition: { duration: 0 } },
  },
  M22: {
    id: "M22",
    where: "Skeletons",
    motion: "Shimmer only",
    trigger: "loading",
    reduced: "static blocks",
  },
  M23: {
    id: "M23",
    where: "Page navigation",
    motion: "None, instant",
    trigger: "navigation",
    reduced: "none",
  },
  M24: {
    id: "M24",
    where: "Public map bottom sheet",
    motion: "Drag with rubber-band, snap points",
    trigger: "drag",
    reduced: "tap to expand",
    full: { transition: SPRING },
    fallback: { transition: { duration: 0 } },
  },
};

/** Ordered list for the design page and tests. */
export const MOTION_IDS = Object.keys(M) as MotionId[];

/** The preset a component should spread, given the user's motion preference. */
export function presetFor(id: MotionId, reduced: boolean): MotionPreset {
  const spec = M[id];
  if (reduced) return spec.fallback ?? instant;
  return spec.full ?? instant;
}

/** Stagger transition for a list (copy lines, responsible pipes). */
export function stagger(childSeconds: number, base: Transition = tween(DUR.panel)): Transition {
  return { ...base, staggerChildren: childSeconds };
}

export interface MotionPref {
  /** True when the OS asks for reduced motion (null from the hook is treated as false). */
  reduced: boolean;
  /** Picks the full or fallback value. */
  pick: <T>(full: T, fallback: T) => T;
  /** Framer props for a catalogue row under the current preference. */
  preset: (id: MotionId) => MotionPreset;
  /** Duration in seconds, zero under reduced motion. */
  seconds: (seconds: number) => number;
}

/**
 * Client hook: wraps `useReducedMotion` so every component asks the same question the same way.
 * Returns stable helpers; call inside client components only.
 */
export function useMotionPref(): MotionPref {
  const reduced = useReducedMotion() === true;
  return {
    reduced,
    pick: (full, fallback) => (reduced ? fallback : full),
    preset: (id) => presetFor(id, reduced),
    seconds: (seconds) => (reduced ? 0 : seconds),
  };
}
