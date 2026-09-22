/**
 * The globe's projection and its canvas painter, with nothing in it that needs a DOM or React.
 *
 * `globe-intro.tsx` draws both sequences (M26 on the landing hero, M27 on the dashboard) and owns
 * the camera: *where* the globe is at a given instant, from the motion catalogue's durations. This
 * module is only *how* one frame is drawn, which is what lets the landing hero paint its moving
 * frames in a worker (`globe-worker.ts`) while the main thread computes nothing but the camera.
 * It imports `d3-geo` and `topojson-client` and nothing else, so a worker can load it.
 */

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

/** The SVG's own coordinate space. Everything scales from it, so the hero is resolution-free. */
export const VIEW_W = 900;
export const VIEW_H = 560;

export const MUMBAI_LON = 72.86;
export const MUMBAI_LAT = 19.06;

/** One country with its lon/lat bounds, computed once so the zoomed acts can cull cheaply. */
export interface Land {
  feature: Feature<Geometry>;
  /** [west, south, east, north] in degrees. */
  bounds: [number, number, number, number];
  name: string;
}

export interface WorldShape {
  land: Land[];
}

/** Where the camera is at `elapsed`: everything the globe draws is a pure function of this. */
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

/** The interpolated projection: `alpha` 0 is a globe, 1 is a flat equirectangular map. */
export function morphProjection(alpha: number) {
  // `geoProjectionMutator` takes a factory of raw projections and returns a function of the
  // mutable parameter; the typings describe the zero-argument shape, so the call is narrowed here.
  const mutate = geoProjectionMutator((t: number) => (lambda: number, phi: number) => {
    const [x0, y0] = geoOrthographicRaw(lambda, phi);
    const [x1, y1] = geoEquirectangularRaw(lambda, phi);
    return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
  }) as unknown as (t: number) => GeoProjection;
  return mutate(alpha);
}

/** Reads one committed TopoJSON file into features with their bounds. */
export async function loadTopology(url: string, signal: AbortSignal): Promise<WorldShape | null> {
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

/**
 * The token colours a canvas paints with. Read from the stylesheet by the page and handed over,
 * so no colour is written here (CLAUDE.md 6.2) and a worker, which has no stylesheet, gets them.
 */
export interface CanvasPalette {
  deep: string;
  well: string;
  line: string;
  lineStrong: string;
  tide: string;
  text2: string;
  font: string;
}

/** The 2D context calls the painter makes; both a DOM canvas and an offscreen one provide them. */
export type Paintable = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * One frame of M26: the same projection, scale and centre, and the same strokes in the same view
 * units as the SVG, painted through `geoPath(projection, context)`.
 *
 * `width` and `height` are the canvas's CSS size; `dpr` is the device pixel ratio it is backed at.
 */
export function paintUnroll(
  context: Paintable,
  palette: CanvasPalette,
  land: readonly Land[],
  frame: GlobeFrame,
  width: number,
  height: number,
  dpr: number,
): void {
  // `xMidYMid meet`, as the SVG does it: the view box scaled to fit and centred.
  const fit = Math.min(width / VIEW_W, height / VIEW_H);
  const offsetX = (width - VIEW_W * fit) / 2;
  const offsetY = (height - VIEW_H * fit) / 2;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width * dpr, height * dpr);
  context.setTransform(dpr * fit, 0, 0, dpr * fit, dpr * offsetX, dpr * offsetY);

  const projection = morphProjection(frame.alpha)
    .scale(frame.scale)
    .translate([VIEW_W / 2, VIEW_H / 2])
    .rotate([-frame.centre[0], -frame.centre[1], 0])
    .precision(0.4);
  // d3's context typing names the DOM context; the offscreen one has the same path methods.
  const path = geoPath(projection, context as CanvasRenderingContext2D);

  context.beginPath();
  path({ type: "Sphere" });
  context.fillStyle = palette.deep;
  context.fill();
  context.lineWidth = 1;
  context.strokeStyle = palette.lineStrong;
  context.stroke();

  context.beginPath();
  path(geoGraticule10());
  context.globalAlpha = 0.75;
  context.lineWidth = 0.6;
  context.strokeStyle = palette.line;
  context.stroke();
  context.globalAlpha = 1;

  context.beginPath();
  for (const shape of land) path(shape.feature as never);
  context.fillStyle = palette.well;
  context.fill();
  context.lineWidth = 0.6;
  context.strokeStyle = palette.lineStrong;
  context.stroke();

  // The Mumbai mark, held back until the globe faces the city and grown with the flattening.
  const point = projection([MUMBAI_LON, MUMBAI_LAT]);
  const opacity = Math.min(Math.max(frame.alpha * 2, 0), 1);
  if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || opacity <= 0.01) {
    return;
  }
  const [x, y] = point;
  const grow = frame.alpha;
  context.globalAlpha = opacity;
  context.beginPath();
  context.arc(x, y, 3, 0, 2 * Math.PI);
  context.fillStyle = palette.tide;
  context.fill();
  context.globalAlpha = opacity * 0.7;
  context.beginPath();
  context.arc(x, y, 6 + 14 * grow, 0, 2 * Math.PI);
  context.lineWidth = 1.2;
  context.strokeStyle = palette.tide;
  context.stroke();
  context.globalAlpha = opacity;
  context.font = `11px ${palette.font}`;
  context.fillStyle = palette.text2;
  context.fillText("Mumbai", x + 12 + 14 * grow, y + 4);
  context.globalAlpha = 1;
}

/** Messages the landing hero sends its globe worker. */
export type GlobeWorkerMessage =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      palette: CanvasPalette;
      topologyUrl: string;
      width: number;
      height: number;
      dpr: number;
    }
  | { type: "resize"; width: number; height: number }
  | { type: "frame"; frame: GlobeFrame };
