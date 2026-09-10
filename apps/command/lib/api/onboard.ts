/**
 * City-in-a-box jobs (`POST /v1/onboard`, `GET /v1/onboard/{id}`; CLAUDE.md 7.9, 12).
 *
 * The wizard polls rather than relying only on the WebSocket. A build is minutes long and the
 * one thing that must not happen on stage is a progress bar that stops moving because a socket
 * dropped; polling every second costs one small request and is the state of record.
 */

import { apiUrl } from "@/lib/api/client";

export type OnboardStatus = "none" | "queued" | "running" | "finished" | "failed";

/** The six steps the wizard shows, in order (CLAUDE.md 7.9). */
export type OnboardStepId =
  | "choose_area"
  | "fetch_open_data"
  | "condition_terrain"
  | "infer_drains"
  | "build_graph"
  | "first_forecast";

export interface OnboardJob {
  jobId: string | null;
  city: string;
  status: OnboardStatus;
  step: OnboardStepId;
  /** 0 to 1 across the whole build. */
  progress: number;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedS: number;
  /** The pipeline's own log lines, newest last. Never composed here. */
  logTail: string[];
  firstRunId: string | null;
  error: string | null;
  /** Whether `city/<city>/segments.parquet` already exists, so a built city reads as built. */
  built: boolean;
}

function parse(body: Record<string, unknown>): OnboardJob {
  return {
    jobId: (body.job_id as string | null) ?? null,
    city: String(body.city ?? ""),
    status: (body.status as OnboardStatus) ?? "none",
    step: (body.step as OnboardStepId) ?? "choose_area",
    progress: Number(body.progress ?? 0),
    startedAt: (body.started_at as string | null) ?? null,
    finishedAt: (body.finished_at as string | null) ?? null,
    elapsedS: Number(body.elapsed_s ?? 0),
    logTail: (body.log_tail as string[]) ?? [],
    firstRunId: (body.first_run_id as string | null) ?? null,
    error: (body.error as string | null) ?? null,
    built: Boolean(body.built),
  };
}

async function call(path: string, init?: RequestInit): Promise<OnboardJob> {
  const response = await fetch(apiUrl(path), init);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const envelope = body.error as { message?: string } | undefined;
    throw new Error(envelope?.message ?? `Onboarding failed: HTTP ${response.status}`);
  }
  return parse(body);
}

/** Start a build, or rejoin the one already running for this city. */
export function startOnboard(city: string, designStorm = "CHN-IDF-25yr"): Promise<OnboardJob> {
  return call("/v1/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ city, design_storm: designStorm, from_cache_only: true }),
  });
}

export function pollOnboard(jobId: string, signal?: AbortSignal): Promise<OnboardJob> {
  return call(`/v1/onboard/${encodeURIComponent(jobId)}`, { signal });
}

/** What the wizard asks on load, so a reopened tab rejoins a build already in flight. */
export function latestOnboard(city: string, signal?: AbortSignal): Promise<OnboardJob> {
  return call(`/v1/onboard/city/${encodeURIComponent(city)}`, { signal });
}
