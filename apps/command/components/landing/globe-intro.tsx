"use client";

/**
 * The hero's opening: a globe that unrolls into a world map, and then hands over to Mumbai.
 *
 * **Why it belongs on this page.** VARUNA's claim is a scale change - global forecasting stops at
 * 12 km, and the water arrives at 30 m. The morph *is* that claim: the camera starts where every
 * weather product starts, flattens the whole world, and then the world is replaced by one city's
 * streets with the run's own water on them. It is the only decorative motion on the site, it
 * plays once, and it earns its place by being the argument rather than illustrating it
 * (CLAUDE.md 6.1: spend the boldness in one place).
 *
 * **How it is drawn.** `d3-geo`'s projection mutator interpolates between the orthographic and
 * equirectangular *raw* projections, so this is a genuine continuous family of projections rather
 * than a cross-fade between two pictures - the coastlines deform correctly the whole way through.
 * The paths are rendered as React elements instead of by `d3-selection`, which keeps one rendering
 * model in the app and lets the whole thing be a pure function of one number.
 *
 * **Offline.** The topology is committed to `public/world-110m.json` (108 KB) rather than fetched
 * from a CDN: CLAUDE.md 17 requires the finale to run with the venue's network off, and a hero
 * that needs jsdelivr is the one thing on the page that cannot.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  geoEquirectangularRaw,
  geoGraticule10,
  geoOrthographicRaw,
  geoPath,
  geoProjectionMutator,
  type GeoProjection,
} from "d3-geo";
import type { FeatureCollection, Geometry } from "geojson";
import { feature } from "topojson-client";

/** The SVG's own coordinate space. Everything scales from it, so the hero is resolution-free. */
const VIEW_W = 900;
const VIEW_H = 560;

/** Globe radius at the start, and half-width of the flat map at the end, in view units. */
const SCALE_GLOBE = 190;
const SCALE_FLAT = 138;

/** How long the globe turns before it starts to unroll, and how long the unrolling takes. */
const SPIN_MS = 1400;
const UNROLL_MS = 2600;

/** Degrees per second the globe turns, and the longitude it starts at - Mumbai's, so the city is
 * facing the viewer when the unrolling begins. */
const SPIN_DEG_PER_S = 22;
const MUMBAI_LON = 72.86;
const MUMBAI_LAT = 19.06;

interface WorldShape {
  land: FeatureCollection<Geometry>;
}

/** The interpolated projection: `alpha` 0 is a globe, 1 is a flat equirectangular map. */
function morphProjection(alpha: number) {
  // `geoProjectionMutator` takes a factory of raw projections and returns a function of the
  // mutable parameter; the typings describe the zero-argument shape, so the call is narrowed here.
  const mutate = geoProjectionMutator(
    (t: number) => (lambda: number, phi: number) => {
      const [x0, y0] = geoOrthographicRaw(lambda, phi);
      const [x1, y1] = geoEquirectangularRaw(lambda, phi);
      return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
    },
  ) as unknown as (t: number) => GeoProjection;
  return mutate(alpha);
}

/** Ease-out cubic: fast at the start, settling into the flat map rather than stopping dead. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export interface GlobeIntroProps {
  /** Called once the morph has finished, so the hero can hand over to the live city map. */
  onDone?: () => void;
  /** Skip the animation and render the finished flat map (reduced motion). */
  still?: boolean;
}

export function GlobeIntro({ onDone, still = false }: GlobeIntroProps) {
  const [world, setWorld] = useState<WorldShape | null>(null);
  const [phase, setPhase] = useState(still ? 1 : 0);
  const done = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/world-110m.json", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((topology: unknown) => {
        if (!topology) return;
        // `world-110m.json` is a TopoJSON topology with a `countries` object; typing it precisely
        // would pull in `topojson-specification` for one field, so it is narrowed here instead.
        const topo = topology as { objects: { countries: unknown } };
        const land = feature(
          topo as never,
          topo.objects.countries as never,
        ) as unknown as FeatureCollection<Geometry>;
        setWorld({ land });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // One animation frame loop drives the whole thing: `phase` runs 0 to 1 over the spin and the
  // unrolling together, and every geometry below is a pure function of it.
  useEffect(() => {
    if (still) return;
    let raf = 0;
    const start = performance.now();
    const total = SPIN_MS + UNROLL_MS;
    const tick = (now: number) => {
      const elapsed = now - start;
      setPhase(Math.min(elapsed / total, 1));
      if (elapsed < total) {
        raf = requestAnimationFrame(tick);
      } else if (!done.current) {
        done.current = true;
        onDone?.();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [still, onDone]);

  const { landPaths, graticulePath, spherePath, alpha } = useMemo(() => {
    const elapsed = phase * (SPIN_MS + UNROLL_MS);
    const unrollT = Math.max(0, Math.min((elapsed - SPIN_MS) / UNROLL_MS, 1));
    const a = still ? 1 : easeOut(unrollT);

    // The globe turns while it is still a globe, and settles on Mumbai as it flattens: the
    // rotation eases back to the city's longitude so the hand-over is over the right place.
    const spun = still ? 0 : (elapsed / 1000) * SPIN_DEG_PER_S;
    const lambda = -MUMBAI_LON - spun * (1 - a);
    const phi = -MUMBAI_LAT * (1 - a);

    const projection = morphProjection(a)
      .scale(SCALE_GLOBE + (SCALE_FLAT - SCALE_GLOBE) * a)
      .translate([VIEW_W / 2, VIEW_H / 2])
      .rotate([lambda, phi, 0])
      .precision(0.4);

    const path = geoPath(projection);
    const clean = (d: string | null) =>
      d && !d.includes("NaN") && !d.includes("Infinity") ? d : null;

    return {
      alpha: a,
      landPaths: (world?.land.features ?? [])
        .map((f) => clean(path(f)))
        .filter((d): d is string => d !== null),
      graticulePath: clean(path(geoGraticule10())),
      spherePath: clean(path({ type: "Sphere" })),
    };
  }, [phase, still, world]);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="h-full w-full"
      // `meet`, not `slice`: the globe is the subject and cropping it to fill a wide hero cuts
      // the poles off. The letterboxing is invisible because the page behind it is `--ink` too.
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="A globe unrolling into a world map, before the view settles on Mumbai"
    >
      {/* The ocean inside the sphere: `--deep`, the same panel colour the console uses, so the
          globe reads as part of the product rather than as an illustration bolted on. */}
      {spherePath ? (
        <path d={spherePath} fill="var(--deep)" stroke="var(--line-strong)" strokeWidth={1} />
      ) : null}
      {graticulePath ? (
        <path
          d={graticulePath}
          fill="none"
          stroke="var(--line)"
          strokeWidth={0.6}
          opacity={0.75}
        />
      ) : null}
      {landPaths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="var(--well)"
          stroke="var(--line-strong)"
          strokeWidth={0.6}
        />
      ))}
      {/* Mumbai, marked from the moment it is visible: the point the whole page is about. The
          ring grows as the map flattens, so the eye is already there when the city map arrives. */}
      <MumbaiMark alpha={alpha} phase={phase} still={still} />
    </svg>
  );
}

function MumbaiMark({
  alpha,
  phase,
  still,
}: {
  alpha: number;
  phase: number;
  still: boolean;
}) {
  const point = useMemo(() => {
    const elapsed = phase * (SPIN_MS + UNROLL_MS);
    const spun = still ? 0 : (elapsed / 1000) * SPIN_DEG_PER_S;
    const projection = morphProjection(alpha)
      .scale(SCALE_GLOBE + (SCALE_FLAT - SCALE_GLOBE) * alpha)
      .translate([VIEW_W / 2, VIEW_H / 2])
      .rotate([-MUMBAI_LON - spun * (1 - alpha), -MUMBAI_LAT * (1 - alpha), 0]);
    return projection([MUMBAI_LON, MUMBAI_LAT]);
  }, [alpha, phase, still]);

  if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
  const [x, y] = point;
  // Held back until the globe has turned to face the city, then grown with the unrolling.
  const opacity = Math.min(Math.max(alpha * 2, 0), 1);

  return (
    <g opacity={opacity}>
      <circle cx={x} cy={y} r={3} fill="var(--tide)" />
      <circle
        cx={x}
        cy={y}
        r={6 + 14 * alpha}
        fill="none"
        stroke="var(--tide)"
        strokeWidth={1.2}
        opacity={0.7}
      />
      <text
        x={x + 12 + 14 * alpha}
        y={y + 4}
        className="num fill-[var(--text-2)]"
        fontSize={11}
      >
        Mumbai
      </text>
    </g>
  );
}
