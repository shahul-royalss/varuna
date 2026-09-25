/**
 * What-if against a baked run (`POST /v1/whatif`; CLAUDE.md 7.7).
 *
 * The level in every number here is the Twin's own forecast for the run; the emulator supplies
 * only the difference the scenario makes. The response carries the emulator's measured skill so
 * the screen can print it beside the answer rather than implying one it does not have.
 */

import { apiUrl } from "@/lib/api/client";

export interface WhatIfSegment {
  segmentId: string;
  beforeCm: number;
  afterCm: number;
  deltaCm: number;
}

export interface WhatIfResult {
  runId: string;
  /** How the number was made, e.g. "twin_level_emulator_delta". */
  method: string;
  emulator: { rmseCm: number; csi30cm: number; nTrainingRuns: number };
  nImproved: number;
  nWorse: number;
  ms: number;
  segments: WhatIfSegment[];
  worstAfter: WhatIfSegment[];
  /**
   * The ids the run actually cleaned, echoed by the handler. Not the ids asked for: an id this
   * city has no segment for is dropped, so the screen prints what was cleaned rather than what
   * was requested (CLAUDE.md rule 6).
   */
  cleanedSegments: string[];
  /** Ids asked for that are not road segments in this city, so the operator can see the gap. */
  cleanedUnmatched: string[];
  notes: string[];
}

/**
 * How many segments a deep link carries. Section 7.7's cleaning lever is "clean top 14", so
 * fourteen is the size the copy and the demo are written around; a hotspot with more segments
 * than that sends its first fourteen and the lab says how many it got.
 */
export const MAX_CLEANED_SEGMENTS = 14;

/**
 * What the request carries. The endpoint has no pump-plan field, so that lever is not a member
 * here: the screen's switch for it is disabled and says so rather than being read into a body
 * that omits it.
 */
export interface WhatIfScenario {
  rainScale: number;
  tideOffsetM: number;
  /**
   * The baked cycle the question is about. Omitted, the handler answers about the newest run,
   * and on this replay that is 09:10 IST - after the storm, where the whole AOI is nearly dry
   * and a rain scenario has almost nothing to move (CLAUDE.md 12: every response carries a
   * `run_id`, and the screen prints the one it got back).
   */
  runId?: string;
  /**
   * Road-segment ids to clean (blockage to 0.05 on the pipe under each). Road segments, not
   * drain edges: the two vocabularies are disjoint and the endpoint refuses a body of edge ids
   * with 422. A hotspot's `segmentIds` are the ids this takes.
   */
  cleanedSegments?: string[];
}

function toSegments(rows: Record<string, unknown>[] | undefined): WhatIfSegment[] {
  return (rows ?? []).map((r) => ({
    segmentId: String(r.segment_id ?? ""),
    beforeCm: Number(r.before_cm ?? 0),
    afterCm: Number(r.after_cm ?? 0),
    deltaCm: Number(r.delta_cm ?? 0),
  }));
}

/** Run a scenario. Throws with the API's own message when it refuses one. */
export async function runWhatIf(
  scenario: WhatIfScenario,
  signal?: AbortSignal,
): Promise<WhatIfResult> {
  const response = await fetch(apiUrl("/v1/whatif"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      // Undefined is dropped by `JSON.stringify`, which is the request the handler reads as
      // "the newest run" - the same default the cycle picker starts on.
      run_id: scenario.runId,
      rain_scale: scenario.rainScale,
      tide_offset_m: scenario.tideOffsetM,
      // Cleaning is expressed as road-segment ids in the API. Absent, an empty list is the
      // honest request: the response's notes then say the scenario was rain only.
      cleaned_segments: scenario.cleanedSegments ?? [],
    }),
  });

  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const envelope = body.error as { message?: string } | undefined;
    throw new Error(envelope?.message ?? `What-if failed: HTTP ${response.status}`);
  }

  const emulator = (body.emulator ?? {}) as Record<string, number>;
  return {
    runId: String(body.run_id ?? ""),
    method: String(body.method ?? ""),
    emulator: {
      rmseCm: Number(emulator.rmse_cm ?? 0),
      csi30cm: Number(emulator.csi_30cm ?? 0),
      nTrainingRuns: Number(emulator.n_training_runs ?? 0),
    },
    nImproved: Number(body.n_improved ?? 0),
    nWorse: Number(body.n_worse ?? 0),
    ms: Number(body.ms ?? 0),
    segments: toSegments(body.segments as Record<string, unknown>[]),
    worstAfter: toSegments(body.worst_after as Record<string, unknown>[]),
    cleanedSegments: (body.cleaned_segments as string[]) ?? [],
    cleanedUnmatched: (body.cleaned_unmatched as string[]) ?? [],
    notes: (body.notes as string[]) ?? [],
  };
}

/** One junction the physics check compared: the emulator's change against the Twin's. */
export interface PhysicsCheckHotspot {
  hotspotId: string;
  name: string;
  emulatorDeltaCm: number;
  twinDeltaCm: number;
  /** `|emulator - Twin|`, the number the check is about. */
  diffCm: number;
}

/**
 * `POST /v1/whatif/physics-check` (CLAUDE.md 7.7, P7.8): the same scenario re-run on the coupled
 * Twin over a window around the run's worst junction, compared as changes and not as levels.
 */
export interface PhysicsCheckResult {
  runId: string;
  /** Section 7.7's sentence, from the endpoint: "Emulator vs physics: max difference ...". */
  summary: string;
  toleranceCm: number;
  agrees: boolean;
  maxDiffCm: number | null;
  maxDiffHotspot: string | null;
  hotspots: PhysicsCheckHotspot[];
  /** Junctions ranked high enough to check that fell outside the one window, named. */
  outside: string[];
  window: { sizeM: number; nodes: number; edges: number; centre: string };
  massBalance: { baseline: number; scenario: number; budget: number };
  ms: number;
  budgetMs: number;
  notes: string[];
}

/** Run the physics check on a scenario. Throws with the API's own message when it refuses one. */
export async function runPhysicsCheck(
  scenario: WhatIfScenario,
  signal?: AbortSignal,
): Promise<PhysicsCheckResult> {
  const response = await fetch(apiUrl("/v1/whatif/physics-check"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      run_id: scenario.runId,
      rain_scale: scenario.rainScale,
      tide_offset_m: scenario.tideOffsetM,
      cleaned_segments: scenario.cleanedSegments ?? [],
    }),
  });

  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const envelope = body.error as { message?: string } | undefined;
    throw new Error(envelope?.message ?? `Physics check failed: HTTP ${response.status}`);
  }

  const window = (body.window ?? {}) as Record<string, unknown>;
  const balance = (body.mass_balance ?? {}) as Record<string, unknown>;
  const optionalNumber = (value: unknown) =>
    value === null || value === undefined ? null : Number(value);
  return {
    runId: String(body.run_id ?? ""),
    summary: String(body.summary ?? ""),
    toleranceCm: Number(body.tolerance_cm ?? 5),
    agrees: Boolean(body.agrees),
    maxDiffCm: optionalNumber(body.max_diff_cm),
    maxDiffHotspot: body.max_diff_hotspot ? String(body.max_diff_hotspot) : null,
    hotspots: ((body.hotspots as Record<string, unknown>[]) ?? []).map((r) => ({
      hotspotId: String(r.hotspot_id ?? ""),
      name: String(r.name ?? r.hotspot_id ?? ""),
      emulatorDeltaCm: Number(r.emulator_delta_cm ?? 0),
      twinDeltaCm: Number(r.twin_delta_cm ?? 0),
      diffCm: Number(r.diff_cm ?? 0),
    })),
    outside: (body.hotspots_outside_window as string[]) ?? [],
    window: {
      sizeM: Number(window.size_m ?? 0),
      nodes: Number(window.nodes ?? 0),
      edges: Number(window.edges ?? 0),
      centre: String(window.centre_hotspot ?? ""),
    },
    massBalance: {
      baseline: Number(balance.baseline ?? 0),
      scenario: Number(balance.scenario ?? 0),
      budget: Number(balance.budget ?? 1e-3),
    },
    ms: Number(body.ms ?? 0),
    budgetMs: Number(body.budget_ms ?? 10_000),
    notes: (body.notes as string[]) ?? [],
  };
}
