/**
 * The drain map Pulse learned (`GET /v1/drains/health`, `/v1/observations`; CLAUDE.md 11.6).
 *
 * Every pipe here is a **belief**, not a measurement: the geometry is inferred from roads and
 * terrain, and the blockage is a posterior with a standard deviation that an ensemble Kalman
 * filter moved using traffic anomalies and citizen reports. The UI has to carry all three facts
 * together, which is why `betaSd` and `confidence` come down the wire beside `betaMean`.
 */

import { apiUrl } from "@/lib/api/client";

export interface DrainEdge {
  id: string;
  street: string | null;
  path: [number, number][];
  betaMean: number;
  betaSd: number;
  betaPrior: number;
  betaDelta: number;
  capacityReductionPct: number;
  diameterM: number;
  observations: number;
  explains: string[];
  /** Always "inferred" in the prototype; the map draws these dashed because of it. */
  confidence: string;
  lastUpdate: string | null;
}

export interface DrainHealth {
  runId: string;
  /** Which observation operator the filter used, e.g. "capacity_deficit". */
  operator: string;
  note: string;
  nEdges: number;
  nUpdated: number;
  edges: DrainEdge[];
  notes: string[];
}

export interface AssimilatedObservation {
  id: string;
  kind: "traffic" | "report";
  ts: string;
  place: string;
  edgeId: string | null;
  depthCm: number;
  depthSdCm: number;
  speedKmh: number | null;
  baselineKmh: number | null;
  z: number | null;
  chip: string | null;
  synthetic: boolean;
}

export interface ObservationSet {
  runId: string;
  nTraffic: number;
  nReports: number;
  nAssimilated: number;
  nEdgesUpdated: number;
  observations: AssimilatedObservation[];
  notes: string[];
}

interface RawFeature {
  geometry?: { coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

/** Fetch the learned drain map. Returns null when the run predates Pulse. */
export async function loadDrainHealth(
  runId?: string,
  signal?: AbortSignal,
  limit = 4000,
): Promise<DrainHealth | null> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (runId) query.set("run_id", runId);
  const response = await fetch(apiUrl(`/v1/drains/health?${query}`), { signal });
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Drain health failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    run_id?: string;
    operator?: string;
    note?: string;
    n_edges?: number;
    n_updated?: number;
    notes?: string[];
    features?: RawFeature[];
  };

  return {
    runId: body.run_id ?? "",
    operator: body.operator ?? "",
    note: body.note ?? "",
    nEdges: body.n_edges ?? 0,
    nUpdated: body.n_updated ?? 0,
    notes: body.notes ?? [],
    edges: (body.features ?? []).map((f, i) => {
      const p = f.properties ?? {};
      return {
        id: String(p.edge_id ?? `edge-${i}`),
        street: (p.street as string | null) ?? null,
        path: (f.geometry?.coordinates as [number, number][]) ?? [],
        betaMean: Number(p.beta_mean ?? 0),
        betaSd: Number(p.beta_sd ?? 0),
        betaPrior: Number(p.beta_prior ?? 0),
        betaDelta: Number(p.beta_delta ?? 0),
        capacityReductionPct: Number(p.capacity_reduction_pct ?? 0),
        diameterM: Number(p.diameter_m ?? 0),
        observations: Number(p.observations ?? 0),
        explains: (p.explains as string[]) ?? [],
        confidence: String(p.confidence ?? "inferred"),
        lastUpdate: (p.last_update as string | null) ?? null,
      };
    }),
  };
}

/** Fetch what Pulse assimilated. Returns null when the run predates Pulse. */
export async function loadObservations(
  runId?: string,
  signal?: AbortSignal,
): Promise<ObservationSet | null> {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  const response = await fetch(apiUrl(`/v1/observations${query}`), { signal });
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Observations failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    run_id?: string;
    n_traffic?: number;
    n_reports?: number;
    n_assimilated?: number;
    n_edges_updated?: number;
    notes?: string[];
    observations?: Record<string, unknown>[];
  };

  return {
    runId: body.run_id ?? "",
    nTraffic: body.n_traffic ?? 0,
    nReports: body.n_reports ?? 0,
    nAssimilated: body.n_assimilated ?? 0,
    nEdgesUpdated: body.n_edges_updated ?? 0,
    notes: body.notes ?? [],
    observations: (body.observations ?? []).map((o, i) => ({
      id: String(o.report_id ?? o.segment_id ?? `obs-${i}`),
      kind: o.kind === "report" ? "report" : "traffic",
      ts: String(o.ts ?? ""),
      place: String(o.place ?? o.segment_id ?? o.edge_id ?? "—"),
      edgeId: (o.edge_id as string | null) ?? null,
      depthCm: Number(o.depth_cm ?? 0),
      depthSdCm: Number(o.depth_sd_cm ?? 0),
      speedKmh: o.speed_kmh === undefined ? null : Number(o.speed_kmh),
      baselineKmh: o.baseline_kmh === undefined ? null : Number(o.baseline_kmh),
      z: o.z === undefined ? null : Number(o.z),
      chip: (o.chip as string | null) ?? null,
      synthetic: Boolean(o.synthetic),
    })),
  };
}

/** The desilting CSV's URL, for the export button. */
export function desiltingCsvUrl(runId?: string): string {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  return apiUrl(`/v1/drains/health.csv${query}`);
}
