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
  /** Edge id, so a run's learned posterior can be joined onto the full network. */
  id: string;
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
      id: String(props.edge_id ?? props.id ?? ""),
      path: feature.geometry.coordinates as [number, number][],
      beta: Number(props.beta_mean ?? props.beta ?? 0),
      diameter: Number(props.diameter_m ?? props.height_m ?? 0.6),
    });
  }
  return out;
}

/** A named facility the map labels: hospitals, fire stations and railway stations. */
export interface FacilityLabel {
  id: string;
  text: string;
  lon: number;
  lat: number;
  kind: "hospital" | "fire_station" | "station";
}

/** Which asset kinds get a name on the map, and how many of each.
 *
 * Mumbai's asset layer has 354 hospitals and 242 shelters, and naming all of them would bury the
 * map in text that says nothing about water. Hospitals and fire stations are what a route and a
 * reachability clock are *about*; stations are how a commuter locates themselves. Shelters,
 * depots and pumping stations stay unnamed until a screen asks for them. */
const LABELLED_KINDS: Record<string, FacilityLabel["kind"]> = {
  hospital: "hospital",
  fire_station: "fire_station",
  station: "station",
};

/** Named hospitals, fire stations and stations, for the map's label layer. */
export async function loadFacilityLabels(
  city: string,
  signal?: AbortSignal,
): Promise<FacilityLabel[]> {
  const features = await layer(city, "assets", signal);
  const out: FacilityLabel[] = [];
  for (const feature of features) {
    const props = feature.properties ?? {};
    const kind = LABELLED_KINDS[String(props.kind ?? "")];
    const geometry = feature.geometry;
    if (!kind || geometry?.type !== "Point") continue;
    const name = typeof props.name === "string" ? props.name.trim() : "";
    // An unnamed hospital is a dot with nothing to say; the marker layer already draws the dot.
    if (!name) continue;
    const coords = geometry.coordinates as number[];
    out.push({
      id: String(props.asset_id ?? name),
      text: name,
      lon: Number(coords[0]),
      lat: Number(coords[1]),
      kind,
    });
  }
  return out;
}
