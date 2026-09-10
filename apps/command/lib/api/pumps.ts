/**
 * The run's pump inventory and dispatch plan (`GET /v1/pumps`; CLAUDE.md 11.10, 7.6).
 *
 * The inventory is synthetic — twelve lorries at real OSM ward-office depots with invented
 * capacities — and the benefit is a documented reduced model, not a physics run. Both labels
 * come down the wire so the board can print them rather than the client asserting them.
 */

import { apiUrl } from "@/lib/api/client";

export interface PumpUnit {
  id: string;
  capacityM3PerHour: number;
  depot: string;
  status: string;
}

export interface PumpAssignment {
  pumpId: string;
  capacityM3PerHour: number;
  depot: string;
  targetId: string;
  targetName: string;
  lon: number | null;
  lat: number | null;
  etaMin: number;
  minutesBefore: number;
  minutesAfter: number;
  minutesSaved: number;
}

export interface PumpPlan {
  runId: string;
  thresholdCm: number;
  /** "Bathtub estimate, not a physics run" — printed beside every benefit number. */
  benefitLabel: string;
  inventory: string;
  pumps: PumpUnit[];
  assignments: PumpAssignment[];
  unassigned: { name: string; minutesAbove: number }[];
  totalMinutesSaved: number;
}

interface RawPump {
  pump_id?: string;
  capacity_m3_per_h?: number;
  depot?: string | null;
  status?: string;
}

interface RawAssignment {
  pump_id?: string;
  capacity_m3_per_h?: number;
  depot?: string | null;
  hotspot_id?: string;
  hotspot_name?: string;
  lon?: number | null;
  lat?: number | null;
  eta_min?: number;
  minutes_before?: number;
  minutes_after?: number;
  minutes_saved?: number;
}

/** Fetch the plan. Returns null when the run predates the pump product. */
export async function loadPumpPlan(
  runId?: string,
  signal?: AbortSignal,
): Promise<PumpPlan | null> {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  const response = await fetch(apiUrl(`/v1/pumps${query}`), { signal });
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Pump plan failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    run_id?: string;
    threshold_cm?: number;
    benefit_label?: string;
    inventory?: string;
    pumps?: RawPump[];
    assignments?: RawAssignment[];
    unassigned?: { name?: string; minutes_above?: number }[];
    total_minutes_saved?: number;
  };

  return {
    runId: body.run_id ?? "",
    thresholdCm: body.threshold_cm ?? 45,
    benefitLabel: body.benefit_label ?? "",
    inventory: body.inventory ?? "synthetic",
    pumps: (body.pumps ?? []).map((p, i) => ({
      id: p.pump_id ?? `P-${i}`,
      capacityM3PerHour: p.capacity_m3_per_h ?? 0,
      depot: p.depot ?? "depot",
      status: p.status ?? "available",
    })),
    assignments: (body.assignments ?? []).map((a, i) => ({
      pumpId: a.pump_id ?? `P-${i}`,
      capacityM3PerHour: a.capacity_m3_per_h ?? 0,
      depot: a.depot ?? "depot",
      targetId: a.hotspot_id ?? `target-${i}`,
      targetName: a.hotspot_name ?? "",
      lon: a.lon ?? null,
      lat: a.lat ?? null,
      etaMin: a.eta_min ?? 0,
      minutesBefore: a.minutes_before ?? 0,
      minutesAfter: a.minutes_after ?? 0,
      minutesSaved: a.minutes_saved ?? 0,
    })),
    unassigned: (body.unassigned ?? []).map((u) => ({
      name: u.name ?? "",
      minutesAbove: u.minutes_above ?? 0,
    })),
    totalMinutesSaved: body.total_minutes_saved ?? 0,
  };
}
