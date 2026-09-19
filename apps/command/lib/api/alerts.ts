/**
 * The alert queue a run raised (`GET /v1/alerts`, `GET /v1/alerts/{id}.cap`; CLAUDE.md 11.10).
 *
 * Alerts are computed when the cycle runs, not when the page opens, so the queue, the map and
 * the hotspot rail are always describing the same forecast.
 */

import { apiUrl } from "@/lib/api/client";

export type AlertLevel = "severe" | "moderate" | "watch";

/**
 * Where an alert has got to with the people who have to act on it.
 *
 * `raised` is the cycle's own answer and is what the product carries. The other two come from
 * the ops log, folded onto the queue at read time, so they survive a reload *and* the change of
 * cycle that renames every alert (see `lib/alert-identity.ts`).
 */
export type AlertState = "raised" | "acknowledged" | "escalated";

/** One thing the desk did to an alert, oldest first. */
export interface AlertAction {
  ts: string;
  state: AlertState;
  user: string;
  note: string | null;
}

export interface RunAlert {
  id: string;
  runId: string;
  level: AlertLevel;
  thresholdCm: number;
  headline: string;
  instruction: string | null;
  areaDesc: string;
  /** "hotspot" for a chronic spot from the register, "segment" for any other street. */
  scope: string;
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
  /** The desk's state, overlaid on the product by the API. `raised` until someone acts. */
  state: AlertState;
  /** Who acknowledged it; kept even after an escalation, so the trail is not lost. */
  acknowledgedBy: string | null;
  acknowledgedTs: string | null;
  /** The step of the escalation matrix it was sent to, when it was escalated. */
  escalatedTo: string | null;
  /** Every action taken on it, oldest first; empty when nobody has touched it. */
  history: AlertAction[];
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
  scope?: string;
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
  state?: string;
  acknowledged_by?: string | null;
  acknowledged_ts?: string | null;
  escalated_to?: string | null;
  history?: {
    ts?: string;
    state?: string;
    user?: string;
    note?: string | null;
  }[];
}

const LEVELS: readonly string[] = ["severe", "moderate", "watch"];
const STATES: readonly string[] = ["raised", "acknowledged", "escalated"];

/** An unknown state is read as `raised`: never claim an alert has been seen when it has not. */
function toState(raw: string | undefined): AlertState {
  return (STATES.includes(raw ?? "") ? raw : "raised") as AlertState;
}

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
      scope: a.scope ?? (a.hotspot_id ? "hotspot" : "segment"),
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
      state: toState(a.state),
      acknowledgedBy: a.acknowledged_by ?? null,
      acknowledgedTs: a.acknowledged_ts ?? null,
      escalatedTo: a.escalated_to ?? null,
      history: (a.history ?? []).map((h) => ({
        ts: h.ts ?? "",
        state: toState(h.state),
        user: h.user ?? "unknown",
        note: h.note ?? null,
      })),
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
