"use client";

/**
 * The landing hero (CLAUDE.md 7.1, motions M1 and M2).
 *
 * Two acts. First a globe unrolls into a world map and settles on Mumbai (`GlobeIntro`), which
 * is the product's whole claim as a picture: global forecasting stops at 12 km, and the water
 * arrives at 30 m. Then it cross-fades into the real thing - the same read-only `FloodMap` the
 * console runs, against the same baked run, scrubbing three hours in eight seconds and looping.
 * The first thing a judge sees is the product working rather than a rendering of it.
 *
 * It pauses on hover (M1), holds still under reduced motion, and stops entirely while the tab is
 * hidden - a landing page that keeps a WebGL canvas animating in a background tab is a landing
 * page that drains a laptop before the demo starts.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";

import { GlobeIntro } from "@/components/landing/globe-intro";
import { FloodMap } from "@/components/map/flood-map";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/varuna/wordmark";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";

/** Steps in a run: 36 five-minute frames, three hours (CLAUDE.md 10.3). */
const N_STEPS = 36;

/** One full sweep, in milliseconds. CLAUDE.md 7.1 asks for eight seconds. */
const LOOP_MS = 8000;

/** The frame reduced motion holds: +120 min, where the storm has arrived. */
const STILL_STEP = 24;

const FRAME_MS = LOOP_MS / N_STEPS;

function useScrubLoop(enabled: boolean): number {
  // The loop's own position, advanced only from the animation frame. When the loop is off - the
  // pointer is over the hero, or the reader prefers reduced motion - the *rendered* step is the
  // still frame instead, derived below rather than written into state, so pausing costs no
  // render and resuming picks up exactly where it left off.
  const [step, setStep] = useState(0);
  const frame = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let last = performance.now();
    let elapsed = 0;
    const tick = (now: number) => {
      // A hidden tab throttles rAF to about once a second, which would make the loop lurch when
      // the user comes back. Reading the real delta keeps it in step with the clock instead.
      const delta = Math.min(now - last, 250);
      last = now;
      if (!document.hidden) {
        elapsed += delta;
        const next = Math.floor((elapsed / FRAME_MS) % N_STEPS);
        if (next !== frame.current) {
          frame.current = next;
          setStep(next);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

  return enabled ? step : STILL_STEP;
}

const COPY_STAGGER_S = 0.06;

function BlurFade({ children, index }: { children: React.ReactNode; index: number }) {
  const reducedMotion = usePrefersReducedMotion();
  if (reducedMotion) return <>{children}</>;
  return (
    <motion.div
      initial={{ opacity: 0, filter: "blur(8px)", y: 8 }}
      animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
      transition={{ duration: 0.5, delay: index * COPY_STAGGER_S, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function Hero() {
  const reducedMotion = usePrefersReducedMotion();
  const [hovered, setHovered] = useState(false);
  // The hand-over needs both halves ready: the globe finished unrolling *and* the run's 36 frames
  // decoded. Firing on the globe alone left a blank hero for the second or two the map still
  // needed, which is the worst possible first impression - so the flat world map holds until
  // there is something to hand over to.
  const [morphDone, setMorphDone] = useState(reducedMotion);
  const [mapReady, setMapReady] = useState(false);
  const handedOver = morphDone && mapReady;
  const onMorphDone = useCallback(() => setMorphDone(true), []);
  const onMapLoaded = useCallback(() => setMapReady(true), []);
  const step = useScrubLoop(!reducedMotion && !hovered && handedOver);

  return (
    <section
      className="relative min-h-dvh w-full overflow-hidden bg-ink"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* The city map is mounted from the start and revealed underneath, so the hand-over is a
          fade rather than a load: by the time the globe is gone the run's 36 frames are decoded
          and the scrub is already running. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 motion-safe:transition-opacity motion-safe:duration-[900ms]"
        style={{ opacity: handedOver ? 1 : 0, transitionDelay: handedOver ? "0ms" : undefined }}
      >
        <FloodMap
          mode="hero"
          step={step}
          onLoaded={onMapLoaded}
          showSurcharge
          showBuildings
          showHotspots
        />
      </div>

      {!handedOver ? (
        <div
          aria-hidden="true"
          className="absolute inset-0 motion-safe:transition-opacity motion-safe:duration-[900ms]"
        >
          <GlobeIntro onDone={onMorphDone} still={reducedMotion} />
        </div>
      ) : null}

      {/* The copy needs a readable ground without hiding the map: a one-sided wash from the left,
          which is where the text is, fading to nothing over the middle third. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-r from-ink via-ink/80 to-transparent lg:to-40%"
      />

      <div className="relative flex min-h-dvh items-center px-6 py-16 sm:px-12 lg:px-24">
        <div className="flex max-w-[52ch] flex-col items-start gap-6">
          <BlurFade index={0}>
            <Wordmark size="lg" />
          </BlurFade>
          <BlurFade index={1}>
            <h1 className="max-w-[14ch] font-display text-display font-semibold tracking-display sm:text-hero">
              Every street. Three hours early.
            </h1>
          </BlurFade>
          <BlurFade index={2}>
            <p className="max-w-[54ch] text-h3 text-text-2">
              VARUNA turns Doppler radar into street-by-street flood depth for the next three hours,
              learns the city&apos;s hidden drains from every flood, and routes emergency services
              around what is coming.
            </p>
          </BlurFade>
          <BlurFade index={3}>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" render={<Link href="/console" />} nativeButton={false}>
                Open the console
              </Button>
              <Button
                size="lg"
                variant="outline"
                render={<Link href="/console?bundle=MUM-2019-07-02&autoplay=1" />}
                nativeButton={false}
              >
                Watch the 2 July 2019 replay
              </Button>
            </div>
          </BlurFade>
          <BlurFade index={4}>
            <p className="text-small text-text-3">
              SIH 2026 · PS SIH26085 · Ministry of Earth Sciences
            </p>
          </BlurFade>
        </div>
      </div>

      {/* The readout, so the loop is legibly a forecast and not an animation. */}
      <div
        hidden={!handedOver}
        className="pointer-events-none absolute bottom-6 right-6 rounded-control border border-line bg-ink/70 px-3 py-2 max-lg:hidden"
      >
        <p className="num text-small text-text-2">
          {String(6 + Math.floor((40 + step * 5) / 60)).padStart(2, "0")}:
          {String((40 + step * 5) % 60).padStart(2, "0")} IST · +{step * 5} min
        </p>
      </div>
    </section>
  );
}
