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
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import { GlobeIntro } from "@/components/landing/globe-intro";
// **Loaded on demand, not in the landing page's first bundle.** `FloodMap` pulls in all of
// deck.gl, and the hero's opening seconds are an SVG globe that needs none of it - so shipping it
// up front cost the landing page its Largest Contentful Paint (3.5 s against a 2.5 s budget) and
// a Lighthouse performance score of 0.41. The import starts when the globe does, so the map is
// usually ready by the time the morph wants to hand over to it, and the handover already waits
// for both halves.
const FloodMap = dynamic(
  () => import("@/components/map/flood-map").then((m) => ({ default: m.FloodMap })),
  {
    ssr: false,
    // No placeholder: the globe is on screen underneath until the handover.
    loading: () => null,
  },
);
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/varuna/wordmark";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { DUR, DUR_MS, EASE_UI, presetFor } from "@/lib/motion";

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

/**
 * The least opacity the first keyframe paints at.
 *
 * Chrome never records a Largest Contentful Paint for text painted at exactly zero opacity, and a
 * composited opacity animation does not repaint the text as it fades in - so a CSS fade from 0
 * leaves the page with **no LCP at all** (Lighthouse: `NO_LCP`, measured 2026-09-22). One per cent
 * is invisible on `--ink` and lets the headline's first paint count as the paint it is. The
 * catalogue's 0 is still what the preset says and what the parity test reads.
 */
export const M2_FIRST_PAINT_OPACITY = 0.01;

/** A motion preset's `initial` or `animate` target as the CSS a keyframe can carry. */
function m2KeyframeCss(target: Record<string, unknown>): string {
  const opacity = Math.max(Number(target.opacity ?? 1), M2_FIRST_PAINT_OPACITY);
  const filter = String(target.filter ?? "none");
  const y = Number(target.y ?? 0);
  return `opacity:${opacity};filter:${filter};transform:translateY(${y}px)`;
}

/** The keyframes' name; one rule for every line of hero copy. */
export const M2_KEYFRAMES = "varuna-m2-blur-fade";

/**
 * The stylesheet M2 runs on, built from the catalogue's preset rather than written out, so the
 * parity test on section 8 still covers every value. Reduced motion removes the animation
 * outright: the global escape hatch only shortens durations, and a copy line with a 300 ms
 * `animation-delay` would otherwise sit invisible for that long (M2's reduced form is "instant").
 */
export function m2Stylesheet(): string {
  const { initial, animate } = presetFor("M2", false);
  const from = m2KeyframeCss((initial || {}) as Record<string, unknown>);
  const to = m2KeyframeCss(animate as Record<string, unknown>);
  return (
    `@keyframes ${M2_KEYFRAMES}{from{${from}}to{${to}}}` +
    `@media (prefers-reduced-motion: reduce){[data-motion="M2"]{animation:none!important}}`
  );
}

/** The `animation` shorthand for the line at `index`: the preset's duration, easing and stagger. */
export function m2Animation(index: number): string {
  const { transition } = presetFor("M2", false);
  const seconds = Number((transition as { duration?: number }).duration ?? DUR.panel);
  const ease = (transition as { ease?: readonly number[] }).ease ?? EASE_UI;
  return `${M2_KEYFRAMES} ${Math.round(seconds * 1000)}ms cubic-bezier(${ease.join(",")}) ${
    index * DUR_MS.staggerCopy
  }ms both`;
}

/**
 * Motion M2: the hero copy's blur-fade entrance, once, 60 ms apart. The values are the catalogue's
 * (`presetFor("M2")` and `DUR.staggerCopy` in lib/motion.ts), not local literals, so the parity
 * test on section 8 covers them.
 *
 * **It is a CSS animation, not a `motion.div`.** A framer entrance starts from `opacity: 0` in the
 * server HTML and waits for hydration to reveal anything, so the headline - the page's Largest
 * Contentful Paint - painted only once every script on the page had run: 4.7-5.5 s on a 4x
 * throttled phone, 8.96 s in Lighthouse's mobile run. The same preset as keyframes starts with the
 * first paint and needs no JavaScript at all. Under reduced motion the stylesheet removes the
 * animation, so the copy is simply there (M2's "instant").
 */
export function BlurFade({ children, index }: { children: React.ReactNode; index: number }) {
  return (
    <div data-motion="M2" style={{ animation: m2Animation(index) }}>
      {children}
    </div>
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
      className="bg-ink relative min-h-dvh w-full overflow-hidden"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* M2's keyframes, in the server HTML so the copy enters before any script runs. */}
      <style dangerouslySetInnerHTML={{ __html: m2Stylesheet() }} />
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
          // No surcharge pulse on the hero. M8 is a console motion, and it asks deck to redraw on
          // every animation frame; each redraw re-applies the depth raster's sampler, where
          // luma.gl 9.3.6 builds a debug string of every GL constant's name whether or not it is
          // logging (`getGLKeys` in `_setSamplerParameters`). Profiled on the steady loop, that
          // was 9.8 s of samples in a 10 s window. Without the pulse the map redraws when the
          // loop moves a step - 4.5 times a second rather than 60.
          showSurcharge={false}
          // No footprints on the hero. Section 6.7 draws buildings only from zoom 14 and the hero
          // frames the whole AOI at about 12, so they were never meant to be seen here - and
          // they are 11 MB of JSON and 39,259 polygons to tessellate on the main thread while
          // the loop is trying to start.
          showBuildings={false}
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
          which is where the text is, gone by the middle. Stopping it at 60 % rather than letting
          it run to the right edge is what leaves the aerial imagery visible - a gradient that is
          80 % ink across the whole width is just a dark rectangle over a photograph. */}
      <div
        aria-hidden="true"
        className="from-ink via-ink/70 absolute inset-0 bg-gradient-to-r from-15% via-40% to-transparent to-60%"
      />

      <div className="relative flex min-h-dvh items-center px-6 py-16 sm:px-12 lg:px-24">
        <div className="flex max-w-[52ch] flex-col items-start gap-6">
          <BlurFade index={0}>
            <Wordmark size="lg" />
          </BlurFade>
          <BlurFade index={1}>
            <h1 className="font-display text-display tracking-display sm:text-hero max-w-[14ch] font-semibold">
              Every street. Three hours early.
            </h1>
          </BlurFade>
          <BlurFade index={2}>
            <p className="text-h3 text-text-2 max-w-[54ch]">
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
          {/* UI_SPEC 1: the way in for everybody who is not an operator. Underlined as well as
              tinted, because colour alone is not a link (CLAUDE.md 6.10). */}
          <BlurFade index={4}>
            <p className="text-small text-text-2">
              Are you not an operator?{" "}
              <Link
                href="/dashboard"
                className="text-tide underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tide)]"
              >
                Open the citizen dashboard
              </Link>
            </p>
          </BlurFade>
          {/* Index 5, not 4: the dashboard link above is a new step in M2's 60 ms stagger, and
              two lines sharing an index would enter together rather than in order. */}
          <BlurFade index={5}>
            <p className="text-small text-text-3">
              SIH 2026 · PS SIH26085 · Ministry of Earth Sciences
            </p>
          </BlurFade>
        </div>
      </div>

      {/* The readout, so the loop is legibly a forecast and not an animation. */}
      <div
        hidden={!handedOver}
        className="rounded-control border-line bg-ink/70 pointer-events-none absolute right-6 bottom-6 border px-3 py-2 max-lg:hidden"
      >
        <p className="num text-small text-text-2">
          {String(6 + Math.floor((40 + step * 5) / 60)).padStart(2, "0")}:
          {String((40 + step * 5) % 60).padStart(2, "0")} IST · +{step * 5} min
        </p>
      </div>
    </section>
  );
}
