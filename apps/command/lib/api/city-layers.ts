/**
 * The city's own GIS, for the map's context layers (`GET /v1/city/{city}/layers/{name}`).
 *
 * These are the layers that make the console look like a map of Mumbai rather than a chart of
 * some lines: 39,259 building footprints and the 49,770-edge inferred drain graph. Both are
 * large — the drains are 18 MB of GeoJSON — so neither is on the path to first paint. The map
 * draws the run as soon as it has one and these arrive behind it, buildings first because they
 * are what the eye reads as "a city", drains only when the operator turns them on.
 */

import { apiUrl } from "@/lib/api/client";

/** A building footprint's outer ring, in lon/lat. */
export type BuildingPolygon = [number, number][];

export interface DrainPath {
  path: [number, number][];
  /** Prior blockage 0-1 from the city pipeline; Pulse replaces it with a posterior in Phase 7. */
  beta: number;
  diameter: number;
}

interface Feature {
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

async function layer(city: string, name: string, signal?: AbortSignal): Promise<Feature[]> {
  const response = await fetch(apiUrl(`/v1/city/${city}/layers/${name}`), { signal });
  if (!response.ok) throw new Error(`Layer ${name}: HTTP ${response.status}`);
  const body = (await response.json()) as { features?: Feature[] };
  return body.features ?? [];
}

/**
 * Building outlines, flattened to outer rings.
 *
 * Only the outer ring of each footprint: courtyards are a metre or two of detail at a zoom where
 * the whole building is a few pixels, and carrying them would double the geometry for something
 * nobody can see.
 */
export async function loadBuildings(
  city: string,
  signal?: AbortSignal,
): Promise<BuildingPolygon[]> {
  const features = await layer(city, "buildings", signal);
  const out: BuildingPolygon[] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "Polygon") {
      const rings = geometry.coordinates as BuildingPolygon[];
      if (rings?.[0]?.length) out.push(rings[0]);
    } else if (geometry.type === "MultiPolygon") {
      for (const rings of (geometry.coordinates as BuildingPolygon[][]) ?? []) {
        if (rings?.[0]?.length) out.push(rings[0]);
      }
    }
  }
  return out;
}

/** The inferred drain graph as drawable paths, with the blockage prior each edge carries. */
export async function loadDrains(city: string, signal?: AbortSignal): Promise<DrainPath[]> {
  const features = await layer(city, "drains", signal);
  const out: DrainPath[] = [];
  for (const feature of features) {
    if (feature.geometry?.type !== "LineString") continue;
    const props = feature.properties ?? {};
    out.push({
      path: feature.geometry.coordinates as [number, number][],
      beta: Number(props.beta_mean ?? props.beta ?? 0),
      diameter: Number(props.diameter_m ?? props.height_m ?? 0.6),
    });
  }
  return out;
}
