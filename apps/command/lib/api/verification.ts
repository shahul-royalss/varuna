/**
 * Verification scores (`GET /v1/verification`; CLAUDE.md 7.10, 12).
 *
 * The response carries what could be scored and, separately, what could not and why. Both are
 * rendered: a dashboard that quietly omits the scores it cannot compute is a dashboard that
 * flatters itself.
 */

import { apiUrl } from "@/lib/api/client";

export interface Contingency {
  hits: number;
  misses: number;
  falseAlarms: number;
}

export interface ThresholdRow {
  thresholdCm: number;
  contingency: Contingency;
  csi: number | null;
  pod: number | null;
  far: number | null;
  medianLeadMin: number | null;
  nHitsEarly: number;
  nHitsAfter: number;
}

export interface MatchedPin {
  pinId: string;
  name: string;
  kind: string;
  pinTs: string;
  forecastTs: string;
  leadMin: number;
  sourceUrl: string;
}

export interface MissedPin {
  pinId: string;
  name: string;
  kind: string;
  pinTs: string;
  deepestNearbyCm: number;
  reason: string;
  sourceUrl: string;
}

export interface Verification {
  event: string;
  runIds: string[];
  window: [string, string] | null;
  headlineThresholdCm: number;
  nPins: number;
  nInWindow: number;
  byThreshold: ThresholdRow[];
  headline: ThresholdRow;
  matched: MatchedPin[];
  missed: MissedPin[];
  unavailable: Record<string, string>;
  notes: string[];
}

function row(raw: Record<string, unknown>): ThresholdRow {
  const c = (raw.contingency ?? {}) as Record<string, number>;
  const s = (raw.scores ?? {}) as Record<string, number | null>;
  return {
    thresholdCm: Number(raw.threshold_cm ?? 0),
    contingency: {
      hits: Number(c.hits ?? 0),
      misses: Number(c.misses ?? 0),
      falseAlarms: Number(c.false_alarms ?? 0),
    },
    csi: s.csi ?? null,
    pod: s.pod ?? null,
    far: s.far ?? null,
    medianLeadMin: s.median_lead_min ?? null,
    nHitsEarly: Number(s.n_hits_early ?? 0),
    nHitsAfter: Number(s.n_hits_after ?? 0),
  };
}

export async function loadVerification(
  event = "MUM-2019-07-02",
  signal?: AbortSignal,
): Promise<Verification> {
  const response = await fetch(apiUrl(`/v1/verification?event=${encodeURIComponent(event)}`), {
    signal,
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const envelope = body.error as { message?: string } | undefined;
    throw new Error(envelope?.message ?? `Verification failed: HTTP ${response.status}`);
  }

  const truth = (body.ground_truth ?? {}) as Record<string, number>;
  const rows = Object.values(
    (body.by_threshold ?? {}) as Record<string, Record<string, unknown>>,
  ).map(row);
  rows.sort((a, b) => a.thresholdCm - b.thresholdCm);
  const headlineCm = Number(body.headline_threshold_cm ?? 15);

  return {
    event: String(body.event ?? event),
    runIds: (body.run_ids as string[]) ?? [],
    window: (body.window as [string, string] | null) ?? null,
    headlineThresholdCm: headlineCm,
    nPins: Number(truth.n_pins ?? 0),
    nInWindow: Number(truth.n_in_window ?? 0),
    byThreshold: rows,
    headline: rows.find((r) => r.thresholdCm === headlineCm) ?? row(body),
    matched: ((body.matched as Record<string, unknown>[]) ?? []).map((m) => ({
      pinId: String(m.pin_id ?? ""),
      name: String(m.name ?? ""),
      kind: String(m.kind ?? ""),
      pinTs: String(m.pin_ts ?? ""),
      forecastTs: String(m.forecast_ts ?? ""),
      leadMin: Number(m.lead_min ?? 0),
      sourceUrl: String(m.source_url ?? ""),
    })),
    missed: ((body.missed as Record<string, unknown>[]) ?? []).map((m) => ({
      pinId: String(m.pin_id ?? ""),
      name: String(m.name ?? ""),
      kind: String(m.kind ?? ""),
      pinTs: String(m.pin_ts ?? ""),
      deepestNearbyCm: Number(m.deepest_nearby_cm ?? 0),
      reason: String(m.reason ?? ""),
      sourceUrl: String(m.source_url ?? ""),
    })),
    unavailable: (body.unavailable as Record<string, string>) ?? {},
    notes: (body.notes as string[]) ?? [],
  };
}
