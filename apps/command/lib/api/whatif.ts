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
  notes: string[];
}

export interface WhatIfScenario {
  rainScale: number;
  tideOffsetM: number;
  cleanTop14: boolean;
  pumpPlan: boolean;
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
      rain_scale: scenario.rainScale,
      tide_offset_m: scenario.tideOffsetM,
      // Cleaning is expressed as pipes in the API; the console's "top 14" shortcut resolves to
      // them once the drain X-ray has a posterior to rank. Until it does, the switch changes
      // nothing and the response's notes say the scenario was rain only.
      cleaned_segments: [],
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
    notes: (body.notes as string[]) ?? [],
  };
}
