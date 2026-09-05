"use client";

import { create } from "zustand";

/** Whether the run was computed live or served from a bake (run.json `mode`). */
export type RunReplayMode = "baked" | "live";

/** System mode shown in the mode banner. */
export type SystemMode = "replay" | "live" | "degraded" | "none";

export type RunStatus = "none" | "loading" | "ready" | "error";

/**
 * The slice of `data/runs/<run_id>/run.json` the chrome reads (CLAUDE.md section 10.3).
 * Declared locally so the chrome does not depend on the generated API types.
 */
export interface RunMeta {
  run_id: string;
  city: string;
  /** Cycle time, ISO 8601 with +05:30. */
  cycle_ts: string;
  /** "replay" or "live": how the inputs arrived. */
  mode: string;
  /** "baked" or "live": how the products were made. */
  replay_mode: RunReplayMode;
  ensemble_n?: number | null;
  stage_ms?: Record<string, number>;
  mass_balance_err?: number | null;
  bundle?: string | null;
  /** Feeds missing in this cycle, e.g. ["radar"]; non-empty means degraded. */
  degraded_feeds?: string[];
  versions?: { sky?: string; twin?: string; flash?: string };
}

export interface RunState {
  currentRun: RunMeta | null;
  status: RunStatus;
  mode: SystemMode;
  /** What went wrong when status is "error"; plain language for the banner. */
  errorMessage: string | null;

  setRun: (run: RunMeta | null) => void;
  setStatus: (status: RunStatus, errorMessage?: string | null) => void;
  setMode: (mode: SystemMode) => void;
  clear: () => void;
}

/** Derives the banner mode from a run's provenance and missing feeds. */
export function deriveSystemMode(run: RunMeta | null): SystemMode {
  if (!run) return "none";
  if (run.degraded_feeds && run.degraded_feeds.length > 0) return "degraded";
  return run.mode === "live" ? "live" : "replay";
}

/** Total stage time in milliseconds, or null when the run has no timings. */
export function totalStageMs(run: RunMeta | null): number | null {
  if (!run?.stage_ms) return null;
  const values = Object.values(run.stage_ms).filter((v) => Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

export const useRunStore = create<RunState>()((set) => ({
  currentRun: null,
  status: "none",
  mode: "none",
  errorMessage: null,

  setRun: (run) =>
    set({
      currentRun: run,
      status: run ? "ready" : "none",
      mode: deriveSystemMode(run),
      errorMessage: null,
    }),
  setStatus: (status, errorMessage = null) =>
    set((s) => ({
      status,
      errorMessage: status === "error" ? errorMessage : null,
      mode: status === "error" && !s.currentRun ? "none" : s.mode,
    })),
  setMode: (mode) => set({ mode }),
  clear: () => set({ currentRun: null, status: "none", mode: "none", errorMessage: null }),
}));

export const selectHasRun = (s: RunState): boolean => s.currentRun !== null;
