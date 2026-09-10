/**
 * Routing and reachability (`POST /v1/route`, `GET /v1/reachability`; CLAUDE.md 7.4, 12).
 *
 * Places are resolved from the city's own layers rather than from coordinates typed into this
 * file: hospitals and fire stations come from the asset register, junctions from the chronic
 * hotspot register, and both carry a `source_url` there (CLAUDE.md 7). A hard-coded lon/lat for
 * "Hindmata" would be a number nobody can check.
 */

import { apiUrl } from "@/lib/api/client";

export interface Place {
  id: string;
  name: string;
  kind: "hospital" | "fire_station" | "hotspot";
  lon: number;
  lat: number;
}

export interface RouteLeg {
  minutes: number;
  distanceM: number;
  maxDepthCm: number;
  depart: string;
  arrive: string;
  safeUntil: string | null;
  path: [number, number][];
  streets: string[];
}

export interface RouteAvoided {
  segmentId: string;
  name: string;
  depthCm: number;
  probability: number;
  at: string;
}

export interface RoutePlan {
  runId: string;
  profile: string;
  departAt: string;
  naive: RouteLeg | null;
  varuna: RouteLeg | null;
  alternates: RouteLeg[];
  avoided: RouteAvoided[];
  notes: string[];
  ms: number;
}

export interface ReachabilityBand {
  minutes: number;
  areaKm2: number;
  dryAreaKm2: number;
  nJunctions: number;
  nJunctionsDry: number;
  rings: [number, number][][];
}

export interface ReachabilityResult {
  runId: string;
  facility: Place;
  validTs: string;
  profile: string;
  collapsed: boolean;
  shareOfDry: number;
  bands: ReachabilityBand[];
  ms: number;
}

function leg(raw: Record<string, unknown> | null | undefined): RouteLeg | null {
  if (!raw) return null;
  return {
    minutes: Number(raw.minutes ?? 0),
    distanceM: Number(raw.distance_m ?? 0),
    maxDepthCm: Number(raw.max_depth_cm ?? 0),
    depart: String(raw.depart ?? ""),
    arrive: String(raw.arrive ?? ""),
    safeUntil: (raw.safe_until as string | null) ?? null,
    path: (raw.path as [number, number][]) ?? [],
    streets: (raw.streets as string[]) ?? [],
  };
}

/** Every place the trip pickers offer, hospitals first then chronic junctions. */
export async function loadPlaces(city = "mumbai", signal?: AbortSignal): Promise<Place[]> {
  const [facilities, hotspots] = await Promise.all([
    fetch(apiUrl(`/v1/route/facilities?city=${city}`), { signal })
      .then((r) => (r.ok ? r.json() : { facilities: [] }))
      .catch(() => ({ facilities: [] })),
    fetch(apiUrl(`/v1/city/${city}/layers/hotspots`), { signal })
      .then((r) => (r.ok ? r.json() : { features: [] }))
      .catch(() => ({ features: [] })),
  ]);

  const out: Place[] = [];
  for (const f of (facilities.facilities ?? []) as Record<string, unknown>[]) {
    out.push({
      id: String(f.asset_id ?? ""),
      name: String(f.name ?? ""),
      kind: f.kind === "fire_station" ? "fire_station" : "hospital",
      lon: Number(f.lon),
      lat: Number(f.lat),
    });
  }
  for (const feature of (hotspots.features ?? []) as Record<string, never>[]) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const geometry = feature.geometry as { type?: string; coordinates?: number[] } | undefined;
    if (geometry?.type !== "Point" || !geometry.coordinates) continue;
    out.push({
      id: String(props.hotspot_id ?? props.id ?? props.name ?? ""),
      name: String(props.name ?? "Unnamed junction"),
      kind: "hotspot",
      lon: Number(geometry.coordinates[0]),
      lat: Number(geometry.coordinates[1]),
    });
  }
  return out;
}

export interface RouteQuery {
  origin: Place;
  destination: Place;
  departAt: string;
  profile: string;
  riskTolerance: number;
  runId?: string;
}

/** Plan a trip. Throws with the API's own message when it refuses one. */
export async function planRoute(query: RouteQuery, signal?: AbortSignal): Promise<RoutePlan> {
  const response = await fetch(apiUrl("/v1/route"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      origin: [query.origin.lon, query.origin.lat],
      destination: [query.destination.lon, query.destination.lat],
      depart_at: query.departAt,
      profile: query.profile,
      risk_tolerance: query.riskTolerance,
      run_id: query.runId,
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const envelope = body.error as { message?: string } | undefined;
    throw new Error(envelope?.message ?? `Route failed: HTTP ${response.status}`);
  }
  return {
    runId: String(body.run_id ?? ""),
    profile: String(body.profile ?? ""),
    departAt: String(body.depart_at ?? ""),
    naive: leg(body.naive as Record<string, unknown> | null),
    varuna: leg(body.varuna as Record<string, unknown> | null),
    alternates: ((body.alternates as Record<string, unknown>[]) ?? [])
      .map(leg)
      .filter((r): r is RouteLeg => r !== null),
    avoided: ((body.avoided as Record<string, unknown>[]) ?? []).map((a) => ({
      segmentId: String(a.segment_id ?? ""),
      name: String(a.name ?? ""),
      depthCm: Number(a.depth_cm ?? 0),
      probability: Number(a.probability ?? 0),
      at: String(a.at ?? ""),
    })),
    notes: (body.notes as string[]) ?? [],
    ms: Number(body.ms ?? 0),
  };
}

/** One facility's catchment at one instant. */
export async function loadReachability(
  facility: string,
  at: string,
  profile: string,
  signal?: AbortSignal,
  runId?: string,
): Promise<ReachabilityResult> {
  const params = new URLSearchParams({ facility, t: at, profile });
  if (runId) params.set("run_id", runId);
  const response = await fetch(apiUrl(`/v1/reachability?${params}`), { signal });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const envelope = body.error as { message?: string } | undefined;
    throw new Error(envelope?.message ?? `Reachability failed: HTTP ${response.status}`);
  }
  const f = (body.facility ?? {}) as Record<string, unknown>;
  return {
    runId: String(body.run_id ?? ""),
    facility: {
      id: String(f.asset_id ?? ""),
      name: String(f.name ?? ""),
      kind: f.kind === "fire_station" ? "fire_station" : "hospital",
      lon: Number(f.lon),
      lat: Number(f.lat),
    },
    validTs: String(body.valid_ts ?? ""),
    profile: String(body.profile ?? ""),
    collapsed: Boolean(body.collapsed),
    shareOfDry: Number(body.share_of_dry ?? 1),
    bands: ((body.bands as Record<string, unknown>[]) ?? []).map((b) => ({
      minutes: Number(b.minutes ?? 0),
      areaKm2: Number(b.area_km2 ?? 0),
      dryAreaKm2: Number(b.dry_area_km2 ?? 0),
      nJunctions: Number(b.n_junctions ?? 0),
      nJunctionsDry: Number(b.n_junctions_dry ?? 0),
      rings: (b.rings as [number, number][][]) ?? [],
    })),
    ms: Number(body.ms ?? 0),
  };
}
