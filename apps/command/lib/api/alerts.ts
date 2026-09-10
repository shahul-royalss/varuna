/**
 * The alert queue a run raised (`GET /v1/alerts`, `GET /v1/alerts/{id}.cap`; CLAUDE.md 11.10).
 *
 * Alerts are computed when the cycle runs, not when the page opens, so the queue, the map and
 * the hotspot rail are always describing the same forecast.
 */

import { apiUrl } from "@/lib/api/client";

export type AlertLevel = "severe" | "moderate" | "watch";

export interface RunAlert {
  id: string;
  runId: string;
  level: AlertLevel;
  thresholdCm: number;
  headline: string;
  instruction: string | null;
  areaDesc: string;
  hotspotId: string | null;
  lon: number | null;
  lat: number | null;
  peakCm: number;
  windowFrom: string;
  windowTo: string;
  raisedTs: string;
  /** How long the threshold stayed crossed, in forecast steps (see `persistsUnit`). */
  persistsCycles: number;
  persistsUnit: string;
  triggerP: number;
  /** "Exercise" on every replay alert — the document says on its face that it is a drill. */
  capStatus: string;
  sourceUrl: string | null;
}

export interface AlertSet {
  runId: string;
  cycleTs: string | null;
  alerts: RunAlert[];
}

interface RawAlert {
  id?: string;
  run_id?: string;
  level?: string;
  threshold_cm?: number;
  headline?: string;
  instruction?: string | null;
  area_desc?: string;
  hotspot_id?: string | null;
  lon?: number | null;
  lat?: number | null;
  peak_cm?: number;
  window_from?: string;
  window_to?: string;
  raised_ts?: string;
  persists_cycles?: number;
  persists_unit?: string;
  trigger_p?: number;
  cap_status?: string;
  source_url?: string | null;
}

const LEVELS: readonly string[] = ["severe", "moderate", "watch"];

/** Fetch a run's alerts. Returns null when the run predates the alert product. */
export async function loadAlerts(
  runId?: string,
  signal?: AbortSignal,
): Promise<AlertSet | null> {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  const response = await fetch(apiUrl(`/v1/alerts${query}`), { signal });
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Alerts failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    run_id?: string;
    cycle_ts?: string | null;
    alerts?: RawAlert[];
  };

  return {
    runId: body.run_id ?? "",
    cycleTs: body.cycle_ts ?? null,
    alerts: (body.alerts ?? []).map((a, i) => ({
      id: a.id ?? `alert-${i}`,
      runId: a.run_id ?? "",
      level: (LEVELS.includes(a.level ?? "") ? a.level : "watch") as AlertLevel,
      thresholdCm: a.threshold_cm ?? 15,
      headline: a.headline ?? "",
      instruction: a.instruction ?? null,
      areaDesc: a.area_desc ?? "",
      hotspotId: a.hotspot_id ?? null,
      lon: a.lon ?? null,
      lat: a.lat ?? null,
      peakCm: a.peak_cm ?? 0,
      windowFrom: a.window_from ?? "",
      windowTo: a.window_to ?? "",
      raisedTs: a.raised_ts ?? "",
      persistsCycles: a.persists_cycles ?? 1,
      persistsUnit: a.persists_unit ?? "forecast steps of 5 minutes",
      triggerP: a.trigger_p ?? 1,
      capStatus: a.cap_status ?? "Exercise",
      sourceUrl: a.source_url ?? null,
    })),
  };
}

/** The CAP 1.2 document for one alert, as XML text. */
export async function loadCap(
  alertId: string,
  runId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  const response = await fetch(
    apiUrl(`/v1/alerts/${encodeURIComponent(alertId)}.cap${query}`),
    { signal },
  );
  if (!response.ok) throw new Error(`CAP failed: HTTP ${response.status}`);
  return response.text();
}
