/**
 * The alert queue a run raised (`GET /v1/alerts`, `GET /v1/alerts/{id}.cap`; CLAUDE.md 11.10).
 *
 * Alerts are computed when the cycle runs, not when the page opens, so the queue, the map and
 * the hotspot rail are always describing the same forecast.
 */

import { api, apiUrl } from "@/lib/api/client";

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
  /**
   * Consecutive cycles the level has held at P >= 0.6 (CLAUDE.md 11.10). A run baked before the
   * cross-cycle rule counts forecast steps instead, and `persistsUnit` says which.
   */
  persistsCycles: number;
  persistsUnit: string;
  /** The cycle the level was first seen at P >= 0.6 (one cycle before it raised); null on old runs. */
  firstSeenTs: string | null;
  /** When this cycle's document went out; the raise time is kept in `raisedTs`. */
  sentTs: string | null;
  /** Escalation tiers this level reaches when raised, from config/escalation.yaml. */
  notify: string[];
  /** Pumps the desk dispatched to this place, and the sentence the phone carries for them. */
  pumps: string[];
  dispatchNote: string | null;
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

/** A level that crossed P >= 0.6 this cycle and raises next cycle if it holds. */
export interface PendingAlert {
  id: string;
  level: AlertLevel;
  headline: string;
  areaDesc: string;
  scope: string;
  peakCm: number;
  sinceTs: string;
}

/** A level that was raised and fell to P <= 0.3 this cycle. */
export interface ClearedAlert {
  situation: string;
  level: AlertLevel;
  name: string | null;
  areaDesc: string;
  raisedTs: string | null;
  clearedTs: string;
  persistsCycles: number;
}

export interface AlertSet {
  runId: string;
  cycleTs: string | null;
  alerts: RunAlert[];
  pending: PendingAlert[];
  nPending: number;
  cleared: ClearedAlert[];
  nCleared: number;
  /**
   * True when the run was baked under the cross-cycle rule. False on a run written before it,
   * whose queue decided on one cycle and counts persistence in forecast steps.
   */
  crossCycle: boolean;
  previousRunId: string | null;
  notes: string[];
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
  first_seen_ts?: string | null;
  sent_ts?: string | null;
  notify?: string[];
  pumps?: string[];
  dispatch_note?: string | null;
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

interface RawPending {
  id?: string;
  level?: string;
  headline?: string;
  area_desc?: string;
  scope?: string;
  peak_cm?: number;
  since_ts?: string;
}

interface RawCleared {
  situation?: string;
  level?: string;
  name?: string | null;
  area_desc?: string;
  raised_ts?: string | null;
  cleared_ts?: string;
  persists_cycles?: number;
}

function toLevel(raw: string | undefined): AlertLevel {
  return (LEVELS.includes(raw ?? "") ? raw : "watch") as AlertLevel;
}

/** An unknown state is read as `raised`: never claim an alert has been seen when it has not. */
function toState(raw: string | undefined): AlertState {
  return (STATES.includes(raw ?? "") ? raw : "raised") as AlertState;
}

/** Fetch a run's alerts. Returns null when the run predates the alert product. */
export async function loadAlerts(runId?: string, signal?: AbortSignal): Promise<AlertSet | null> {
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
    pending?: RawPending[];
    n_pending?: number;
    cleared?: RawCleared[];
    n_cleared?: number;
    hysteresis?: { previous_run_id?: string | null } | null;
    notes?: string[];
  };

  const pending = (body.pending ?? []).map((p, i) => ({
    id: p.id ?? `pending-${i}`,
    level: toLevel(p.level),
    headline: p.headline ?? "",
    areaDesc: p.area_desc ?? "",
    scope: p.scope ?? "segment",
    peakCm: p.peak_cm ?? 0,
    sinceTs: p.since_ts ?? "",
  }));
  const cleared = (body.cleared ?? []).map((c, i) => ({
    situation: c.situation ?? `cleared-${i}`,
    level: toLevel(c.level),
    name: c.name ?? null,
    areaDesc: c.area_desc ?? "",
    raisedTs: c.raised_ts ?? null,
    clearedTs: c.cleared_ts ?? "",
    persistsCycles: c.persists_cycles ?? 0,
  }));

  return {
    runId: body.run_id ?? "",
    cycleTs: body.cycle_ts ?? null,
    pending,
    nPending: body.n_pending ?? pending.length,
    cleared,
    nCleared: body.n_cleared ?? cleared.length,
    crossCycle: Boolean(body.hysteresis),
    previousRunId: body.hysteresis?.previous_run_id ?? null,
    notes: body.notes ?? [],
    alerts: (body.alerts ?? []).map((a, i) => ({
      id: a.id ?? `alert-${i}`,
      runId: a.run_id ?? "",
      level: toLevel(a.level),
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
      firstSeenTs: a.first_seen_ts ?? null,
      sentTs: a.sent_ts ?? null,
      notify: a.notify ?? [],
      pumps: a.pumps ?? [],
      dispatchNote: a.dispatch_note ?? null,
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
  const response = await fetch(apiUrl(`/v1/alerts/${encodeURIComponent(alertId)}.cap${query}`), {
    signal,
  });
  if (!response.ok) throw new Error(`CAP failed: HTTP ${response.status}`);
  return response.text();
}

/**
 * The unit a card counts persistence in, singular, from what the API said it counted.
 *
 * "cycles" on a run baked under CLAUDE.md 11.10's cross-cycle rule; "forecast steps of 5
 * minutes" on one baked before it. The card pluralises it, so it is handed the singular.
 */
export function persistenceUnit(persistsUnit: string): string {
  return persistsUnit.startsWith("cycle") ? "cycle" : "forecast step";
}

// ---------------------------------------------------------------------------------------------
// Escalation matrix, sender and delivery log (CLAUDE.md 7.5)
// ---------------------------------------------------------------------------------------------

/** One step of `config/escalation.yaml`, ward officer to public. */
export interface EscalationStep {
  id: string;
  recipient: string;
  trigger: string;
  channel: string;
  /** Alert levels that reach this step when raised; empty when only an escalation does. */
  levels: AlertLevel[];
}

/** The matrix as the API serves it from `config/escalation.yaml`. */
export async function loadEscalation(signal?: AbortSignal): Promise<EscalationStep[]> {
  const body = await api.get<{
    tiers?: {
      id?: string;
      recipient?: string;
      trigger?: string;
      channel?: string;
      levels?: string[];
    }[];
  }>("/v1/alerts/escalation", { signal });
  return (body.tiers ?? []).map((t, i) => ({
    id: t.id ?? `tier-${i}`,
    recipient: t.recipient ?? "",
    trigger: t.trigger ?? "",
    channel: t.channel ?? "",
    levels: (t.levels ?? []).map((l) => toLevel(l)),
  }));
}

/**
 * The next step up the matrix for an alert: past every step its level already reached and any
 * step it was escalated to. Null at the top, where there is nobody left to tell.
 */
export function nextEscalation(
  alert: Pick<RunAlert, "notify" | "escalatedTo">,
  steps: readonly EscalationStep[],
): EscalationStep | null {
  const reached = new Set([...alert.notify, ...(alert.escalatedTo ? [alert.escalatedTo] : [])]);
  let top = -1;
  steps.forEach((step, i) => {
    if (reached.has(step.id)) top = i;
  });
  return steps[top + 1] ?? null;
}

/** Whether a real phone sender is configured where the API runs. Never a key, never a number. */
export interface SenderStatus {
  configured: boolean;
  provider: string | null;
  channel: string | null;
  toMasked: string | null;
}

export async function loadSender(signal?: AbortSignal): Promise<SenderStatus> {
  const body = await api.get<{
    configured?: boolean;
    provider?: string | null;
    channel?: string | null;
    to_masked?: string | null;
  }>("/v1/alerts/sender", { signal });
  return {
    configured: body.configured === true,
    provider: body.provider ?? null,
    channel: body.channel ?? null,
    toMasked: body.to_masked ?? null,
  };
}

/** One line of the delivery log: a mock render or a real attempt, in the API's own words. */
export interface DeliveryRow {
  id: string;
  alertId: string;
  /** "Dashboard", "WhatsApp mock", "SMS mock", "Real send (twilio)". */
  label: string;
  kind: "mock" | "real";
  /** "Shown on the alert queue", "Rendered, not sent", "Sent", "Failed", "Refused". */
  status: string;
  ts: string;
  toMasked: string | null;
  error: string | null;
  user: string | null;
}

export interface DeliveryLog {
  runId: string;
  rows: DeliveryRow[];
  nReal: number;
  notes: string[];
}

export async function loadDelivery(
  runId?: string,
  signal?: AbortSignal,
  limit = 20,
): Promise<DeliveryLog> {
  const body = await api.get<{
    run_id?: string;
    n_real?: number;
    notes?: string[];
    rows?: {
      id?: string;
      alert_id?: string;
      label?: string;
      kind?: string;
      status?: string;
      ts?: string | null;
      to_masked?: string | null;
      error?: string | null;
      user?: string | null;
    }[];
  }>("/v1/alerts/delivery", { query: { run_id: runId, limit }, signal });
  return {
    runId: body.run_id ?? "",
    nReal: body.n_real ?? 0,
    notes: body.notes ?? [],
    rows: (body.rows ?? []).map((r, i) => ({
      id: r.id ?? `row-${i}`,
      alertId: r.alert_id ?? "",
      label: r.label ?? "",
      kind: r.kind === "real" ? "real" : "mock",
      status: r.status ?? "",
      ts: r.ts ?? "",
      toMasked: r.to_masked ?? null,
      error: r.error ?? null,
      user: r.user ?? null,
    })),
  };
}
