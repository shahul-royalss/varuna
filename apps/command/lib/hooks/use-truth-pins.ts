"use client";

/**
 * The sourced ground-truth pins, dropping as the replay clock passes each one (task P6.12, M18).
 *
 * This is the 2:40 moment of the demo script: the clock reaches 08:47, a pin lands on Gandhi
 * Market, and the street underneath it has been red for the last ninety minutes. So the timing has
 * to come from the **clock**, not from a page-load animation - a pin that drops when the console
 * opens says nothing at all.
 *
 * Each pin carries an `age` from 0 to 1 over its first {@link DROP_MS}, which the map turns into
 * a spring and a ripple. Under reduced motion every pin is fully aged the moment the clock passes
 * it, so it appears without animating (CLAUDE.md 8's M18 fallback).
 *
 * **When each pin landed is state, not a ref.** It is read to compute what is rendered, which is
 * the definition of state; a ref there is both a lint error and a real bug waiting - React would
 * be free to skip the render that shows the drop.
 */

import { useEffect, useMemo, useState } from "react";

import { loadGroundTruth, pinsSoFar, type GroundTruthPin } from "@/lib/api/ground-truth";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";

/** Motion M18: the pin drops and its ripple expands over 600 ms (CLAUDE.md 8). */
export const DROP_MS = 600;

export interface DroppedPin extends GroundTruthPin {
  /** 0 to 1 over the drop; 1 once it has landed. */
  age: number;
}

export interface TruthPinState {
  /** Everything the clock has passed, newest first: what the ticker lists. */
  passed: GroundTruthPin[];
  /** The same pins with their drop progress, for the map. Only those inside the AOI. */
  dropping: DroppedPin[];
  /** Every curated pin for the bundle, whether the clock has reached it or not. */
  all: GroundTruthPin[];
}

export function useTruthPins(bundle: string | undefined, simTime: string | null): TruthPinState {
  const [all, setAll] = useState<GroundTruthPin[]>([]);
  const reducedMotion = usePrefersReducedMotion();
  // Wall-clock ms at which each pin was first seen to have been passed. Wall clock, not replay
  // time: at 30x a 600 ms drop in replay time would be over in twenty milliseconds.
  const [landed, setLanded] = useState<Record<string, number>>({});
  const [now, setNow] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    loadGroundTruth(bundle, controller.signal)
      .then((set) => setAll(set?.pins ?? []))
      .catch(() => setAll([]));
    return () => controller.abort();
  }, [bundle]);

  const passed = useMemo(() => (simTime ? pinsSoFar(all, simTime) : []), [all, simTime]);
  const passedIds = useMemo(() => passed.map((p) => p.id).join("|"), [passed]);

  // **One loop owns both.** When the clock passes a new pin this starts a `requestAnimationFrame`
  // loop that stamps it and then advances `now` until every drop has finished. Doing the stamping
  // in its own effect meant a synchronous setState in an effect body - the cascading-render the
  // lint rule guards - where this is the shape the rule asks for: a callback from an external
  // system, the wall clock, writing what it read.
  //
  // Scrubbing backwards un-drops pins, which is correct: the ticker is a record of what has
  // happened *by now*, and "now" is wherever the operator put it.
  useEffect(() => {
    const live = passedIds ? passedIds.split("|") : [];
    let frame = 0;

    const tick = () => {
      const at = performance.now();
      let stillDropping = false;

      setLanded((current) => {
        const next: Record<string, number> = {};
        let changed = live.length !== Object.keys(current).length;
        for (const id of live) {
          const stamp = current[id] ?? at;
          next[id] = stamp;
          if (current[id] === undefined) changed = true;
          if (at - stamp < DROP_MS) stillDropping = true;
        }
        return changed ? next : current;
      });

      setNow(at);
      if (stillDropping && !reducedMotion) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [passedIds, reducedMotion]);

  const dropping = useMemo(() => {
    // `now` is 0 only on the render before the loop's first frame, where every pin is still
    // unstamped and lands on `DROP_MS` below anyway. Reading the clock here instead would make
    // this memo impure, which is exactly the unstable-result problem the rule names.
    const at = now;
    return passed
      .filter((pin) => pin.insideAoi)
      .map((pin) => {
        if (reducedMotion) return { ...pin, age: 1 };
        const stamp = landed[pin.id];
        const elapsed = stamp === undefined || at === 0 ? DROP_MS : at - stamp;
        return { ...pin, age: Math.min(1, Math.max(0, elapsed / DROP_MS)) };
      });
  }, [passed, landed, reducedMotion, now]);

  return { passed, dropping, all };
}
