/**
 * Loading one baked run so the map can scrub it without touching the network
 * (CLAUDE.md task P6.3, and the 7.2 acceptance criterion "no network during scrub").
 *
 * Three fetches, once, in parallel:
 *   1. `/v1/nowcast/raster/bounds` — where the rasters go, how many there are, and the run's
 *      provenance (the run stamp and its honesty notes come from here, not from a constant).
 *   2. `/v1/nowcast/segments` — the depth series per wet segment.
 *   3. `/v1/city/{city}/layers/segments` — the road geometry, which never changes with the run
 *      and so is fetched separately and cached hard by the browser.
 *
 * Then every depth PNG is decoded to an `ImageBitmap` **before** the time bar is enabled.
 * Decoding is the expensive part and doing it lazily is what makes a scrub stutter; doing it up
 * front costs a visible second on load and buys a scrub that is a texture swap.
 */

import { apiUrl } from "./client";

/** Provenance the run stamp prints, straight from `run.json`. */
export interface RunProvenance {
  runId: string;
  cycleTs: string | null;
  mode: string | null;
  bundle: string | null;
  nSteps: number;
  stepMin: number;
  ensembleN: number;
  massBalanceErr: number | null;
  stageMs: Record<string, number>;
  /** Printed verbatim under the run stamp. Never summarised (CLAUDE.md rule 6). */
  notes: string[];
}

export interface RunDepth {
  provenance: RunProvenance;
  /** Lon/lat corners for the BitmapLayer: [west, south, east, north]. */
  bounds: [number, number, number, number];
  /** One decoded frame per step; a null means that step's PNG failed to decode. */
  frames: (ImageBitmap | null)[];
  /** segment_id -> depth in cm at each step. Only segments the run wetted appear. */
  depthCm: Map<string, number[]>;
  /** ISO valid time of each step, for the time bar's labels. */
  validTs: string[];
  nSegmentsTotal: number;
}

interface BoundsResponse {
  run_id: string;
  cycle_ts: string | null;
  mode: string | null;
  bundle: string | null;
  n_steps: number;
  step_min: number;
  ensemble_n: number;
  mass_balance_err: number | null;
  stage_ms: Record<string, number>;
  notes: string[];
  bounds: { wgs84: [number, number, number, number] };
}

interface SegmentsResponse {
  valid_ts: string[];
  n_segments_total: number;
  depth_cm: Record<string, number[]>;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(path), { signal });
  if (!response.ok) {
    // The API's errors carry the command that fixes them; surfacing that beats "HTTP 404".
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(body?.error?.message ?? `${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * Decode every step's PNG into a GPU-ready bitmap.
 *
 * Sequential rather than all at once: 36 parallel decodes of a 522 x 323 RGBA image will spike
 * memory and, on an integrated GPU, stall the first paint of the map itself. One at a time keeps
 * the load smooth and still finishes well inside the time it takes an operator to read the
 * mode banner.
 */
async function decodeFrames(
  runId: string,
  nSteps: number,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<(ImageBitmap | null)[]> {
  const frames: (ImageBitmap | null)[] = [];
  for (let step = 0; step < nSteps; step += 1) {
    if (signal?.aborted) break;
    try {
      const response = await fetch(
        apiUrl(`/v1/nowcast/raster?run_id=${encodeURIComponent(runId)}&step=${step}`),
        { signal },
      );
      frames.push(response.ok ? await createImageBitmap(await response.blob()) : null);
    } catch {
      // One unreadable frame must not cost the other 35. The map draws nothing for this step
      // and the scrub passes over it, which is visible and honest.
      frames.push(null);
    }
    onProgress?.(step + 1, nSteps);
  }
  return frames;
}

/** Load one run end to end. `runId` omitted means the newest baked run with depth products.
 *
 * The city is not a parameter: a run directory already knows which city it is for, and passing a
 * second opinion in from the caller would only create a way for the two to disagree. */
export async function loadRunDepth(
  runId?: string,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<RunDepth> {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  const bounds = await getJson<BoundsResponse>(`/v1/nowcast/raster/bounds${query}`, signal);

  const [segments, frames] = await Promise.all([
    getJson<SegmentsResponse>(`/v1/nowcast/segments${query}`, signal),
    decodeFrames(bounds.run_id, bounds.n_steps, signal, onProgress),
  ]);

  return {
    provenance: {
      runId: bounds.run_id,
      cycleTs: bounds.cycle_ts,
      mode: bounds.mode,
      bundle: bounds.bundle,
      nSteps: bounds.n_steps,
      stepMin: bounds.step_min,
      ensembleN: bounds.ensemble_n,
      massBalanceErr: bounds.mass_balance_err,
      stageMs: bounds.stage_ms ?? {},
      notes: bounds.notes ?? [],
    },
    bounds: bounds.bounds.wgs84,
    frames,
    depthCm: new Map(Object.entries(segments.depth_cm ?? {})),
    validTs: segments.valid_ts ?? [],
    nSegmentsTotal: segments.n_segments_total ?? 0,
  };
}

/** Road-class widths in pixels (CLAUDE.md 6.7: 2-6 px by class, dry segments 1 px). */
const CLASS_WIDTH: Record<string, number> = {
  motorway: 6,
  trunk: 5,
  primary: 4.5,
  secondary: 3.5,
  tertiary: 3,
  residential: 2,
  service: 1.5,
  unclassified: 2,
};

export interface GeoSegment {
  id: string;
  path: [number, number][];
  depthCm: number[];
  width: number;
}

/**
 * Join the city's road geometry to the run's depth series.
 *
 * Only segments the run actually wetted are returned. The dry remainder is 19,000-odd more
 * paths that would never change colour, and drawing them costs frame rate the scrub needs
 * (CLAUDE.md 14: 55 fps at 1440 x 900). They are already on screen as the city's own street
 * layer, in the dry colour, which is exactly what they should look like.
 */
export function joinSegments(
  geojson: { features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: number[][] } }[] },
  depthCm: Map<string, number[]>,
): GeoSegment[] {
  const out: GeoSegment[] = [];
  for (const feature of geojson.features ?? []) {
    const id = String(feature.properties?.segment_id ?? "");
    const series = depthCm.get(id);
    if (!series || feature.geometry?.type !== "LineString") continue;
    out.push({
      id,
      path: feature.geometry.coordinates as [number, number][],
      depthCm: series,
      width: CLASS_WIDTH[String(feature.properties?.class ?? "residential")] ?? 2,
    });
  }
  return out;
}

/**
 * Every road in the city as a drawable path, with no depth attached.
 *
 * This is the geography layer: drawn once, in the dry colour, so the operator can see Mumbai
 * rather than a black rectangle with some orange on it. It replaces the basemap that CLAUDE.md 5
 * would have supplied - see the note at the top of `CityMap` - and unlike a tile service it comes
 * from the city VARUNA built and works with the network off (CLAUDE.md 17).
 */
export function allSegments(
  geojson: { features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: number[][] } }[] },
): GeoSegment[] {
  const out: GeoSegment[] = [];
  for (const feature of geojson.features ?? []) {
    if (feature.geometry?.type !== "LineString") continue;
    out.push({
      id: String(feature.properties?.segment_id ?? ""),
      path: feature.geometry.coordinates as [number, number][],
      depthCm: [],
      width: CLASS_WIDTH[String(feature.properties?.class ?? "residential")] ?? 2,
    });
  }
  return out;
}
