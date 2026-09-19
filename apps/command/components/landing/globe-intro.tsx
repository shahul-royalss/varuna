"use client";

/**
 * The vector Earth two screens open on: the landing hero's unrolling world map (M26) and the
 * citizen dashboard's approach to Mumbai (M27).
 *
 * **Why it belongs on these pages.** VARUNA's claim is a scale change - global forecasting stops
 * at 12 km, and the water arrives at 30 m. The morph *is* that claim: the camera starts where
 * every weather product starts and ends on one city's streets with the run's own water on them.
 * It is the only decorative motion on the site, it plays once, and it earns its place by being
 * the argument rather than illustrating it (CLAUDE.md 6.1: spend the boldness in one place).
 *
 * **How it is drawn.** `d3-geo`'s projection mutator interpolates between the orthographic and
 * equirectangular *raw* projections, so this is a genuine continuous family of projections rather
 * than a cross-fade between two pictures - the coastlines deform correctly the whole way through.
 * The paths are rendered as React elements instead of by `d3-selection`, which keeps one rendering
 * model in the app and lets the whole thing be a pure function of one number.
 *
 * **Two sequences, one geometry.** `sequence="unroll"` is M26 unchanged: turn 1.4 s, unroll 2.6 s,
 * hand over. `sequence="approach"` is M27: turn 1.4 s to bring India to the meridian, approach
 * over 1.6 s while the sphere flattens, narrow to the Mumbai AOI over 1.0 s. Every act's duration
 * is a `DUR_MS` entry from the catalogue (`lib/motion.ts`), never a local literal, so section 8
 * and this file cannot drift apart.
 *
 * **Offline.** The 110 m topology is committed to `public/world-110m.json` (108 KB) rather than
 * fetched from a CDN: CLAUDE.md 17 requires the finale to run with the venue's network off, and a
 * hero that needs jsdelivr is the one thing on the page that cannot. The approach also wants
 * finer coastlines once the frame is over India, so `public/world-50m.json` (739 KB) is committed
 * beside it and fetched **only when the approach asks for it** - the landing page never pays for
 * it, and if that second fetch fails the 110 m outline carries all three acts and nothing about
 * the sequence looks broken.
 *
 * Both files are TopoJSON from the `world-atlas` package (Mike Bostock, ISC), derived from
 * Natural Earth, which is public domain. `world-50m.json` is `world-atlas@2.0.2/countries-50m.json`
 * byte for byte, sha256 04342cdc1e3016bcd7db1630de95684d67b79fe3c8c460321e87aef469502394,
 * retrieved 2026-09-19.
 *
 * **Why the zoomed acts stay cheap.** At the arrival scale a country outline drawn whole would
 * resample into tens of thousands of points that are nowhere near the viewport. Two guards keep
 * the frame budget: the projection is clipped to the SVG's own extent, and, once the frame is
 * narrow enough for it to matter, features whose lon/lat bounds do not meet the visible window
 * are not projected at all.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  geoBounds,
  geoEquirectangularRaw,
  geoGraticule10,
  geoOrthographicRaw,
  geoPath,
  geoProjectionMutator,
  type GeoProjection,
} from "d3-geo";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { feature } from "topojson-client";

import { DUR_MS } from "@/lib/motion";

/** The SVG's own coordinate space. Everything scales from it, so the hero is resolution-free. */
const VIEW_W = 900;
const VIEW_H = 560;

/** Globe radius at the start, and half-width of the flat map at the end, in view units. */
const SCALE_GLOBE = 190;
const SCALE_FLAT = 138;

/**
 * The approach's two further scales, in view units of an equirectangular projection (radians to
 * pixels). `SCALE_INDIA` puts about 40° of longitude across the frame - the subcontinent and the
 * Arabian Sea it drains into. `SCALE_AOI` puts about 1.6° across it, so the Mumbai AOI's
 * 0.09° x 0.14° box is a readable rectangle rather than a dot, and the coast is the coast.
 */
const SCALE_INDIA = 1290;
const SCALE_AOI = 32000;

/**
 * Act durations, from the motion catalogue. M26 is turn plus unroll; M27 is turn, approach,
 * arrive. Section 8 lists exactly these `DUR_MS` keys against those two rows.
 */
const SPIN_MS = DUR_MS.globeTurn;
const UNROLL_MS = DUR_MS.globeUnroll;
const APPROACH_MS = DUR_MS.globeApproach;
const ARRIVE_MS = DUR_MS.globeArrive;

/** Degrees per second the globe turns, and the longitude it starts at - Mumbai's, so the city is
 * facing the viewer when the unrolling begins. */
const SPIN_DEG_PER_S = 22;
const MUMBAI_LON = 72.86;
const MUMBAI_LAT = 19.06;

/**
 * Where the approach's first act ends: the middle of the subcontinent, so India faces the reader
 * square-on before the frame starts closing on one city of it.
 */
const INDIA_LON = 79;
const INDIA_LAT = 22;

/** Where the approach's first act begins: mid-Atlantic, so the turn east is the whole Old World. */
const START_LON = -28;

/** The country whose outline strengthens as the frame approaches it (UI_SPEC 2, act 2). */
const HIGHLIGHT_NAME = "India";

/** The Mumbai AOI (CLAUDE.md 3.3), drawn as a box in the final act. */
const AOI = { west: 72.815, east: 72.905, south: 18.995, north: 19.135 };

/** Committed topologies, coarse first. The fine one is fetched only by the approach. */
const TOPOLOGY_110M = "/world-110m.json";
const TOPOLOGY_50M = "/world-50m.json";

/** Which opening is playing: the landing hero's (M26) or the dashboard's (M27). */
export type GlobeSequence = "unroll" | "approach";

/** One country with its lon/lat bounds, computed once so the zoomed acts can cull cheaply. */
interface Land {
  feature: Feature<Geometry>;
  /** [west, south, east, north] in degrees. */
  bounds: [number, number, number, number];
  name: string;
}

interface WorldShape {
  land: Land[];
}

/** Total length of a sequence, in milliseconds. */
export function sequenceMs(sequence: GlobeSequence): number {
  return sequence === "approach" ? SPIN_MS + APPROACH_MS + ARRIVE_MS : SPIN_MS + UNROLL_MS;
}

/** The interpolated projection: `alpha` 0 is a globe, 1 is a flat equirectangular map. */
function morphProjection(alpha: number) {
  // `geoProjectionMutator` takes a factory of raw projections and returns a function of the
  // mutable parameter; the typings describe the zero-argument shape, so the call is narrowed here.
  const mutate = geoProjectionMutator((t: number) => (lambda: number, phi: number) => {
    const [x0, y0] = geoOrthographicRaw(lambda, phi);
    const [x1, y1] = geoEquirectangularRaw(lambda, phi);
    return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
  }) as unknown as (t: number) => GeoProjection;
  return mutate(alpha);
}

/** Ease-out cubic: fast at the start, settling into the flat map rather than stopping dead. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Zoom is multiplicative, so scales interpolate in the log, or the approach lurches at the end. */
function zoomLerp(from: number, to: number, t: number): number {
  return from * Math.pow(to / from, t);
}

/** Where the camera is at `elapsed`: everything the SVG draws is a pure function of this. */
export interface GlobeFrame {
  /** 0 a globe, 1 a flat equirectangular map. */
  alpha: number;
  /** Projection scale in view units. */
  scale: number;
  /** Longitude and latitude at the centre of the frame. */
  centre: [number, number];
  /** 0 to 1 as the highlighted country's outline strengthens (acts 2 and 3). */
  highlight: number;
  /** 0 to 1 as the AOI box appears in the final act. */
  aoi: number;
  /** True once the sequence has run its length. */
  finished: boolean;
}

/**
 * The approach (M27), act by act.
 *
 * Act 1 turns the globe from the Atlantic to India at a fixed scale. Act 2 flattens the sphere
 * and closes on the subcontinent. Act 3 narrows to the Mumbai AOI, which is where the map behind
 * is already framed, so the cross-fade that follows lands on the same picture.
 */
function approachFrame(elapsed: number): GlobeFrame {
  const turn = clamp01(elapsed / SPIN_MS);
  const approach = clamp01((elapsed - SPIN_MS) / APPROACH_MS);
  const arrive = clamp01((elapsed - SPIN_MS - APPROACH_MS) / ARRIVE_MS);

  const turnEase = easeOut(turn);
  const approachEase = easeOut(approach);
  const arriveEase = easeOut(arrive);

  const lon =
    arrive > 0 ? lerp(INDIA_LON, MUMBAI_LON, arriveEase) : lerp(START_LON, INDIA_LON, turnEase);
  const lat = arrive > 0 ? lerp(INDIA_LAT, MUMBAI_LAT, arriveEase) : lerp(0, INDIA_LAT, turnEase);

  const scale =
    arrive > 0
      ? zoomLerp(SCALE_INDIA, SCALE_AOI, arriveEase)
      : zoomLerp(SCALE_GLOBE, SCALE_INDIA, approachEase);

  return {
    alpha: approachEase,
    scale,
    centre: [lon, lat],
    highlight: Math.max(approach, arrive > 0 ? 1 : 0),
    aoi: arriveEase,
    finished: elapsed >= sequenceMs("approach"),
  };
}

/** The landing hero's unrolling world map (M26), unchanged. */
function unrollFrame(elapsed: number): GlobeFrame {
  const unrollT = clamp01((elapsed - SPIN_MS) / UNROLL_MS);
  const alpha = easeOut(unrollT);
  const spun = (elapsed / 1000) * SPIN_DEG_PER_S;
  return {
    alpha,
    scale: SCALE_GLOBE + (SCALE_FLAT - SCALE_GLOBE) * alpha,
    // The globe turns while it is still a globe, and settles on Mumbai as it flattens: the
    // rotation eases back to the city's longitude so the hand-over is over the right place.
    centre: [MUMBAI_LON + spun * (1 - alpha), MUMBAI_LAT * (1 - alpha)],
    highlight: 0,
    aoi: 0,
    finished: elapsed >= sequenceMs("unroll"),
  };
}

/** The finished frame each sequence holds under reduced motion. */
function stillFrame(sequence: GlobeSequence): GlobeFrame {
  return sequence === "approach"
    ? approachFrame(sequenceMs("approach"))
    : unrollFrame(sequenceMs("unroll"));
}

/** Where the camera is, for either sequence. Exported so tests can read the acts without a DOM. */
export function frameAt(sequence: GlobeSequence, elapsed: number): GlobeFrame {
  return sequence === "approach" ? approachFrame(elapsed) : unrollFrame(elapsed);
}

/**
 * Half-width and half-height of the visible window in degrees, with a generous margin.
 *
 * Only used to decide what *not* to project, so an over-estimate costs a little work and an
 * under-estimate would drop a coastline that should be on screen. The margin is 3x.
 */
function visibleHalfDegrees(scale: number): [number, number] {
  const toDeg = 180 / Math.PI;
  const margin = 3;
  return [(VIEW_W / 2 / scale) * toDeg * margin, (VIEW_H / 2 / scale) * toDeg * margin];
}

/** Below this the whole world is in frame and culling would only cost time. */
const CULL_ABOVE_SCALE = 600;

function inWindow(land: Land, centre: [number, number], scale: number): boolean {
  if (scale < CULL_ABOVE_SCALE) return true;
  const [halfLon, halfLat] = visibleHalfDegrees(scale);
  const [west, south, east, north] = land.bounds;
  if (north < centre[1] - halfLat || south > centre[1] + halfLat) return false;
  // Longitudes wrap; comparing the delta to 180 keeps a window straddling the antimeridian honest.
  const delta = Math.abs(((east + west) / 2 - centre[0] + 540) % 360) - 180;
  const span = (east - west) / 2;
  return Math.abs(delta) - span <= halfLon;
}

/** Reads one committed TopoJSON file into features with their bounds. */
async function loadTopology(url: string, signal: AbortSignal): Promise<WorldShape | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  const topology = (await response.json()) as unknown;
  if (!topology) return null;
  // The world-atlas topologies carry a `countries` object; typing them precisely would pull in
  // `topojson-specification` for one field, so they are narrowed here instead.
  const topo = topology as { objects: { countries: unknown } };
  const collection = feature(
    topo as never,
    topo.objects.countries as never,
  ) as unknown as FeatureCollection<Geometry>;
  const land = collection.features.map((f) => {
    const [[west, south], [east, north]] = geoBounds(f as never);
    const name = String((f.properties as { name?: unknown } | null)?.name ?? "");
    return {
      feature: f,
      bounds: [west, south, east, north] as [number, number, number, number],
      name,
    };
  });
  return { land };
}

export interface GlobeIntroProps {
  /** Called once the sequence has finished, so the page can hand over to its live map. */
  onDone?: () => void;
  /** Skip the animation and render the finished frame (reduced motion). */
  still?: boolean;
  /** Which opening to play; "unroll" (M26) by default, so the landing hero is unchanged. */
  sequence?: GlobeSequence;
}

export function GlobeIntro({ onDone, still = false, sequence = "unroll" }: GlobeIntroProps) {
  const [world, setWorld] = useState<WorldShape | null>(null);
  /** The finer topology, once it has arrived; null means the approach runs on 110 m throughout. */
  const [fine, setFine] = useState<WorldShape | null>(null);
  const [elapsed, setElapsed] = useState(still ? sequenceMs(sequence) : 0);
  const done = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadTopology(TOPOLOGY_110M, controller.signal)
      .then((shape) => {
        if (shape) setWorld(shape);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // The 50 m coastline, for acts 2 and 3 only. The landing hero never asks for it, and a failure
  // here is not an error state: the sequence simply keeps the outline it already has.
  useEffect(() => {
    if (sequence !== "approach") return;
    const controller = new AbortController();
    void loadTopology(TOPOLOGY_50M, controller.signal)
      .then((shape) => {
        if (shape) setFine(shape);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [sequence]);

  // One animation frame loop drives the whole thing: `elapsed` is the only state it writes, and
  // every geometry below is a pure function of it.
  useEffect(() => {
    if (still) return;
    let raf = 0;
    const start = performance.now();
    const total = sequenceMs(sequence);
    const tick = (now: number) => {
      const since = now - start;
      setElapsed(Math.min(since, total));
      if (since < total) {
        raf = requestAnimationFrame(tick);
      } else if (!done.current) {
        done.current = true;
        onDone?.();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [still, onDone, sequence]);

  const frame = useMemo(
    () => (still ? stillFrame(sequence) : frameAt(sequence, elapsed)),
    [elapsed, sequence, still],
  );

  const { landPaths, graticulePath, spherePath, aoiPath, point } = useMemo(() => {
    // Acts 2 and 3 draw the finer coastline once it is here; act 1 keeps the coarse one, so the
    // detail rises at an act boundary rather than popping mid-turn.
    const source = sequence === "approach" && frame.alpha > 0 && fine ? fine : world;

    const projection = morphProjection(frame.alpha)
      .scale(frame.scale)
      .translate([VIEW_W / 2, VIEW_H / 2])
      .rotate([-frame.centre[0], -frame.centre[1], 0])
      .precision(0.4);
    // Clipping in projected space is what keeps the arrival act affordable: a country outline is
    // cut to the SVG's own box before it is resampled into a path string. Only the approach needs
    // it - the unroll never leaves the viewBox - and M26 is left exactly as it was.
    if (sequence === "approach") {
      projection.clipExtent([
        [0, 0],
        [VIEW_W, VIEW_H],
      ]);
    }

    const path = geoPath(projection);
    const clean = (d: string | null) =>
      d && !d.includes("NaN") && !d.includes("Infinity") ? d : null;

    const lands = (source?.land ?? []).filter((land) => inWindow(land, frame.centre, frame.scale));

    return {
      landPaths: lands
        .map((land) => ({
          d: clean(path(land.feature as never)),
          highlighted: land.name === HIGHLIGHT_NAME,
        }))
        .filter((entry): entry is { d: string; highlighted: boolean } => entry.d !== null),
      graticulePath: clean(path(geoGraticule10())),
      spherePath: clean(path({ type: "Sphere" })),
      aoiPath:
        frame.aoi > 0
          ? clean(
              path({
                type: "Polygon",
                coordinates: [
                  [
                    [AOI.west, AOI.south],
                    [AOI.east, AOI.south],
                    [AOI.east, AOI.north],
                    [AOI.west, AOI.north],
                    [AOI.west, AOI.south],
                  ],
                ],
              } as never),
            )
          : null,
      point: projection([MUMBAI_LON, MUMBAI_LAT]),
    };
  }, [fine, frame, sequence, world]);

  // The dashboard's globe is decoration in front of a map the reader is waiting for, and its
  // skip button is the real control (UI_SPEC 10), so the canvas is hidden from assistive
  // technology there. The landing hero's globe is the page's only picture, so it keeps its label.
  const labelling =
    sequence === "approach"
      ? ({ "aria-hidden": true } as const)
      : ({
          role: "img",
          "aria-label": "A globe unrolling into a world map, before the view settles on Mumbai",
        } as const);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="h-full w-full"
      // `meet`, not `slice`: the globe is the subject and cropping it to fill a wide hero cuts
      // the poles off. The letterboxing is invisible because the page behind it is `--ink` too.
      preserveAspectRatio="xMidYMid meet"
      data-slot="globe-intro"
      data-sequence={sequence}
      {...labelling}
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
          // The graticule is a globe's furniture; past the subcontinent it is 10° apart and off
          // the frame, so it fades rather than leaving one stray line across Mumbai.
          opacity={0.75 * (1 - frame.aoi)}
        />
      ) : null}
      {landPaths.map((land, i) => (
        <path
          key={i}
          d={land.d}
          fill="var(--well)"
          stroke={land.highlighted && frame.highlight > 0 ? "var(--text-2)" : "var(--line-strong)"}
          strokeWidth={land.highlighted ? 0.6 + 1.2 * frame.highlight : 0.6}
        />
      ))}
      {aoiPath ? (
        <path
          d={aoiPath}
          fill="none"
          stroke="var(--tide)"
          strokeWidth={1.2}
          opacity={frame.aoi}
          data-slot="globe-aoi"
        />
      ) : null}
      <MumbaiMark point={point} frame={frame} />
    </svg>
  );
}

function MumbaiMark({ point, frame }: { point: [number, number] | null; frame: GlobeFrame }) {
  if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
  const [x, y] = point;
  // Held back until the globe has turned to face the city, then grown with the flattening. In the
  // approach the ring shrinks away again once the AOI box takes over as the subject.
  const opacity = Math.min(Math.max(frame.alpha * 2, 0), 1) * (1 - frame.aoi);
  if (opacity <= 0.01) return null;
  const grow = frame.alpha;

  return (
    <g opacity={opacity}>
      <circle cx={x} cy={y} r={3} fill="var(--tide)" />
      <circle
        cx={x}
        cy={y}
        r={6 + 14 * grow}
        fill="none"
        stroke="var(--tide)"
        strokeWidth={1.2}
        opacity={0.7}
      />
      <text x={x + 12 + 14 * grow} y={y + 4} className="num fill-[var(--text-2)]" fontSize={11}>
        Mumbai
      </text>
    </g>
  );
}
