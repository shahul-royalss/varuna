/**
 * The run's ranked hotspots, for the console rail (CLAUDE.md 7.2, 11.8; `GET /v1/nowcast/hotspots`).
 *
 * Loaded once per run alongside the depth frames, not per scrub step: every hotspot carries its
 * whole 3-hour depth series, so moving the time bar reads an array index rather than the network
 * (CLAUDE.md 7.2 AC, "no network during scrub").
 */

import { apiUrl } from "@/lib/api/client";

/** Asset kinds the exposure row draws an icon for, matching `FACILITY_KINDS` in the products service. */
export type FacilityKind = "hospital" | "fire_station" | "station" | "shelter";

export interface HotspotExposure {
  /** The city pipeline's own exposure weight for the busiest road through the junction (P1.6). */
  weight: number;
  facilities: FacilityKind[];
  nearestHospital?: string;
  nearestHospitalM?: number;
  nearestStation?: string;
  nearestStationM?: number;
}

export interface Hotspot {
  rank: number;
  id: string;
  name: string;
  slug: string | null;
  lon: number;
  lat: number;
  ward: string | null;
  /** True where the register recorded the spot as a terrain sink (a subway or underpass). */
  isSink: boolean;
  /** The report this chronic spot was verified against (CLAUDE.md rule 7). */
  sourceUrl: string | null;
  sourced: boolean;
  peakDepthCm: number;
  peakTs: string | null;
  timeToPeakMin: number;
  /** Depth in cm at every step of the run, so the row can follow the scrub without a fetch. */
  depthCm: number[];
  /** 0 or 1 on a deterministic run; continuous once Flash brings the ensemble (Phase 7). */
  pImpassableAtPeak: number;
  impassableFromTs: string | null;
  minutesImpassable: number;
  expectedImpact: number;
  exposure: HotspotExposure;
}

export interface HotspotSet {
  runId: string;
  /** Which score ordered the list; printed in the rail so the ranking is never implied. */
  ranking: string;
  impassableThresholdCm: number;
  hotspots: Hotspot[];
}

interface RawExposure {
  weight?: number;
  facilities?: string[];
  nearest_hospital?: string;
  nearest_hospital_m?: number;
  nearest_station?: string;
  nearest_station_m?: number;
}

interface RawHotspot {
  rank?: number;
  hotspot_id?: string;
  name?: string;
  slug?: string | null;
  lon?: number;
  lat?: number;
  ward?: string | null;
  is_sink?: boolean;
  source_url?: string | null;
  sourced?: boolean;
  peak_depth_cm?: number;
  peak_ts?: string | null;
  time_to_peak_min?: number;
  depth_cm?: number[];
  p_impassable_at_peak?: number;
  impassable_from_ts?: string | null;
  minutes_impassable?: number;
  expected_impact?: number;
  exposure?: RawExposure;
}

const FACILITY_KINDS: readonly string[] = ["hospital", "fire_station", "station", "shelter"];

/** Fetch the ranked hotspots for a run. Returns null when the run predates hotspot ranking. */
export async function loadHotspots(
  runId: string | undefined,
  signal?: AbortSignal,
): Promise<HotspotSet | null> {
  const query = new URLSearchParams({ limit: "100" });
  if (runId) query.set("run_id", runId);

  const response = await fetch(apiUrl(`/v1/nowcast/hotspots?${query}`), { signal });
  if (!response.ok) {
    // A run baked before P5.4 has no `hotspots.json`. That is an empty rail, not a broken
    // console: the map, the scrub and the run stamp all still work.
    if (response.status === 404) return null;
    throw new Error(`Hotspots failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    run_id?: string;
    ranking?: string;
    impassable_threshold_cm?: number;
    hotspots?: RawHotspot[];
  };

  return {
    runId: body.run_id ?? "",
    ranking: body.ranking ?? "peak depth",
    impassableThresholdCm: body.impassable_threshold_cm ?? 30,
    hotspots: (body.hotspots ?? []).map((h, i) => ({
      rank: h.rank ?? i + 1,
      id: h.hotspot_id ?? h.slug ?? `hotspot-${i}`,
      name: h.name ?? "Unnamed hotspot",
      slug: h.slug ?? null,
      lon: h.lon ?? 0,
      lat: h.lat ?? 0,
      ward: h.ward ?? null,
      isSink: Boolean(h.is_sink),
      sourceUrl: h.source_url ?? null,
      sourced: Boolean(h.sourced),
      peakDepthCm: h.peak_depth_cm ?? 0,
      peakTs: h.peak_ts ?? null,
      timeToPeakMin: h.time_to_peak_min ?? 0,
      depthCm: h.depth_cm ?? [],
      pImpassableAtPeak: h.p_impassable_at_peak ?? 0,
      impassableFromTs: h.impassable_from_ts ?? null,
      minutesImpassable: h.minutes_impassable ?? 0,
      expectedImpact: h.expected_impact ?? 0,
      exposure: {
        weight: h.exposure?.weight ?? 0,
        facilities: (h.exposure?.facilities ?? []).filter((k): k is FacilityKind =>
          FACILITY_KINDS.includes(k),
        ),
        nearestHospital: h.exposure?.nearest_hospital,
        nearestHospitalM: h.exposure?.nearest_hospital_m,
        nearestStation: h.exposure?.nearest_station,
        nearestStationM: h.exposure?.nearest_station_m,
      },
    })),
  };
}
