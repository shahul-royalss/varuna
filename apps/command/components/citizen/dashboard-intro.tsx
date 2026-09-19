"use client";

/**
 * The citizen dashboard's way in (motion M27, UI_SPEC 2; task D-14).
 *
 * **What it is for.** A reader arriving at `/dashboard` has no idea what they are looking at. Four
 * seconds of vector Earth answer the only question that matters before any number does: this is
 * the whole planet, and then it is your city, at the scale of your street. The sequence is the
 * scale claim, not an animation over it.
 *
 * **Once per session.** `sessionStorage` remembers that it has played, because a judge who opens
 * the dashboard, goes to the console and comes back should not watch it again. It is cleared when
 * the tab closes, so the next demo run opens on it.
 *
 * **Always skippable, and the skip is real.** Any key, click, wheel or touch ends it, and from
 * 0.6 s a "Skip" button is on screen, taking focus - the globe itself is hidden from assistive
 * technology, because the sequence has nothing in it for a screen reader and the control does.
 *
 * **The handover rule (UI_SPEC 2).** `onDone` is what reveals the map. The dashboard mounts that
 * map underneath and frames it on the AOI while the globe is still playing, so the cross-fade
 * ends on a map that was already there - no frame of this screen ever shows an unframed world.
 *
 * **Reduced motion.** No turn and no cross-fade: the finished Mumbai frame paints once, then the
 * screen cuts to the map. The still frame is the same geometry the sequence ends on, so the cut
 * is between two pictures of the same place.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { GlobeIntro } from "@/components/landing/globe-intro";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { DUR_MS } from "@/lib/motion";

/** Remembers, for this tab only, that the entry has already played. */
export const INTRO_SESSION_KEY = "varuna.dashboard-intro.played";

/** How long the sequence runs before the "Skip" button appears (UI_SPEC 2). */
export const SKIP_AFTER_MS = 600;

export interface DashboardIntroProps {
  /** Called when the entry sequence has finished, or immediately when there is none. */
  onDone: () => void;
  /**
   * Play even if this tab has seen it. The dashboard leaves it alone; tests and a rehearsal reset
   * use it, because a demo that has to be reopened in a fresh tab is a demo waiting to go wrong.
   */
  force?: boolean;
}

/** Whether this tab has already played the entry. A blocked or absent store means "no". */
function hasPlayed(): boolean {
  try {
    return window.sessionStorage.getItem(INTRO_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * `sessionStorage` read as an external store, the way `useMediaQuery` reads `matchMedia`.
 *
 * Nothing subscribes, because nothing else in this tab writes the key. The point of the shape is
 * the server snapshot: the server has no session, so it renders as though the entry had already
 * played - nothing - and the client's first render after hydration decides for real. Deriving it
 * in an effect instead would be a setState in an effect body, which is the cascading render
 * React's own lint rule refuses.
 */
const NO_SUBSCRIPTION = () => () => {};

function markPlayed(): void {
  try {
    window.sessionStorage.setItem(INTRO_SESSION_KEY, "1");
  } catch {
    // A private window with storage blocked plays it once per load instead of once per session.
    // That is the harmless end of this failure, so it is swallowed rather than surfaced.
  }
}

export function DashboardIntro({ onDone, force = false }: DashboardIntroProps) {
  const reducedMotion = usePrefersReducedMotion();
  const seen = useSyncExternalStore(NO_SUBSCRIPTION, hasPlayed, () => true);
  const [dismissed, setDismissed] = useState(false);
  const playing = !dismissed && (force || !seen);
  const [skippable, setSkippable] = useState(false);
  const [fading, setFading] = useState(false);
  const revealed = useRef(false);
  const skipRef = useRef<HTMLButtonElement | null>(null);

  /** Tell the dashboard to show its map. Exactly once, however many ways we get here. */
  const reveal = useCallback(() => {
    if (revealed.current) return;
    revealed.current = true;
    onDone();
  }, [onDone]);

  /** Reveal the map and take the globe away in the same frame: the skip, and the cut. */
  const finish = useCallback(() => {
    markPlayed();
    reveal();
    setDismissed(true);
  }, [reveal]);

  /**
   * The globe has reached its last frame. The dashboard's map is revealed now and the globe is
   * held, fading, for exactly `heroHandover` - so the reader never sees `--ink` between the two,
   * and the map they end on was framed on the AOI before the fade began.
   */
  const handOver = useCallback(() => {
    markPlayed();
    reveal();
    setFading(true);
    window.setTimeout(() => setDismissed(true), DUR_MS.heroHandover);
  }, [reveal]);

  // Already seen this session, or dismissed: hand over on the frame after mount, so the dashboard
  // is never left waiting for a sequence that is not going to play.
  useEffect(() => {
    if (!playing) reveal();
  }, [playing, reveal]);

  /**
   * Reduced motion: the still frame paints, then the screen cuts. It is deliberately not held for
   * a beat - a reader who has asked for less motion has not asked to be made to wait - so the
   * frame is on screen for one paint and the map takes over.
   */
  useEffect(() => {
    if (!playing || !reducedMotion) return;
    const raf = requestAnimationFrame(() => finish());
    return () => cancelAnimationFrame(raf);
  }, [finish, playing, reducedMotion]);

  useEffect(() => {
    if (!playing || reducedMotion) return;
    const timer = window.setTimeout(() => setSkippable(true), SKIP_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [playing, reducedMotion]);

  // UI_SPEC 10 asks for the skip to be first in the tab order. The overlay covers the page but
  // does not remove it from the tab order, so the button takes focus when it appears: that is
  // what "first" has to mean for a control sitting on top of everything else.
  useEffect(() => {
    if (skippable) skipRef.current?.focus();
  }, [skippable]);

  // Any key, click, wheel or touch ends it. A reader who has started doing something has told us
  // they are finished watching, and making them find the button would be the rude reading.
  useEffect(() => {
    if (!playing) return;
    const skip = () => finish();
    window.addEventListener("keydown", skip);
    window.addEventListener("pointerdown", skip);
    window.addEventListener("wheel", skip, { passive: true });
    window.addEventListener("touchstart", skip, { passive: true });
    return () => {
      window.removeEventListener("keydown", skip);
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("wheel", skip);
      window.removeEventListener("touchstart", skip);
    };
  }, [finish, playing]);

  if (!playing) return null;

  return (
    <div
      data-slot="dashboard-intro"
      data-fading={fading ? "true" : "false"}
      className="bg-ink fixed inset-0 z-50 motion-safe:transition-opacity motion-safe:duration-[900ms]"
      style={{ opacity: fading ? 0 : 1 }}
    >
      <GlobeIntro sequence="approach" still={reducedMotion} onDone={handOver} />
      {skippable ? (
        <button
          ref={skipRef}
          type="button"
          data-slot="dashboard-intro-skip"
          onClick={finish}
          className="border-line bg-deep text-small text-text-2 hover:text-text focus-visible:outline-tide rounded-control absolute right-6 bottom-6 inline-flex h-11 items-center border px-4 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Skip
        </button>
      ) : null}
    </div>
  );
}
