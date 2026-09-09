/**
 * Manholes surcharging and pipes running backwards (`GET /v1/nowcast/surcharge`; CLAUDE.md 11.4).
 *
 * The demo's 1:40 moment: red markers where the drain is pushing water back up into the street,
 * and the trunk the sea is holding shut. Loaded once per run with every step's discharge, so the
 * markers follow the scrub without a fetch.
 */

import { apiUrl } from "@/lib/api/client";

export interface SurchargeNodeSeries {
  id: string;
  lon: number;
  lat: number;
  /** Peak discharge out of the manhole over the run, in m³/s. */
  peakQ: number;
  /** Discharge at each step, so a marker only appears while the manhole is actually surcharging. */
  q: number[];
}

export interface ReversedEdge {
  id: string;
  /** True where the downstream end is a tidal outfall — the sea holding the drain shut. */
  tidal: boolean;
  steps: number[];
  minQ: number;
}

export interface SurchargeSet {
  runId: string;
  nodesTotal: number;
  nodes: SurchargeNodeSeries[];
  reversedEdges: ReversedEdge[];
  reversedAtTidalOutfall: number;
}

interface RawNode {
  node_id?: string;
  lon?: number;
  lat?: number;
  peak_q_m3s?: number;
  q_m3s?: number[];
}

interface RawEdge {
  edge_id?: string;
  tidal?: boolean;
  steps?: number[];
  min_q_m3s?: number;
}

/** Fetch a run's surcharge product. Returns null when the run predates it. */
export async function loadSurcharge(
  runId: string | undefined,
  signal?: AbortSignal,
): Promise<SurchargeSet | null> {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  const response = await fetch(apiUrl(`/v1/nowcast/surcharge${query}`), { signal });
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Surcharge failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    run_id?: string;
    n_nodes_total?: number;
    n_reversed_at_tidal_outfall?: number;
    nodes?: RawNode[];
    reversed_edges?: RawEdge[];
  };

  return {
    runId: body.run_id ?? "",
    nodesTotal: body.n_nodes_total ?? 0,
    reversedAtTidalOutfall: body.n_reversed_at_tidal_outfall ?? 0,
    nodes: (body.nodes ?? []).map((n, i) => ({
      id: n.node_id ?? `node-${i}`,
      lon: n.lon ?? 0,
      lat: n.lat ?? 0,
      peakQ: n.peak_q_m3s ?? 0,
      q: n.q_m3s ?? [],
    })),
    reversedEdges: (body.reversed_edges ?? []).map((e, i) => ({
      id: e.edge_id ?? `edge-${i}`,
      tidal: Boolean(e.tidal),
      steps: e.steps ?? [],
      minQ: e.min_q_m3s ?? 0,
    })),
  };
}
