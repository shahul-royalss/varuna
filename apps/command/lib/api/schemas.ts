/**
 * Zod schemas for the VARUNA API (CLAUDE.md section 10.3 run.json, section 11.11 bus
 * topics, section 12 API contract). These are deliberately lenient (`looseObject`) so the
 * console keeps rendering while the API grows; the generated `types.ts` (pnpm typegen) is
 * the strict contract and these schemas validate what the console actually relies on.
 */
import { z } from "zod";

/** Error envelope: every API error is `{ "error": { code, message, run_id } }`. */
export const ApiErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    run_id: z.string().nullish(),
  }),
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelope>;

/** `run.json` mode: a run is either computed live or served from a bake. */
export const RUN_MODES = ["live", "baked"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** System mode shown in the mode banner. */
export const SYSTEM_MODES = ["replay", "live", "degraded"] as const;
export type SystemMode = (typeof SYSTEM_MODES)[number];

export const RunVersions = z.looseObject({
  sky: z.string().optional(),
  twin: z.string().optional(),
  flash: z.string().optional(),
});

/** Mirrors `data/runs/<run_id>/run.json` (CLAUDE.md section 10.3). */
export const RunMeta = z.looseObject({
  run_id: z.string(),
  city: z.string(),
  cycle_ts: z.string(),
  radar_frame_ts: z.string().nullish(),
  versions: RunVersions.optional(),
  mode: z.string(),
  ensemble_n: z.number().int().nullish(),
  stage_ms: z.record(z.string(), z.number()).default({}),
  mass_balance_err: z.number().nullish(),
  bundle: z.string().nullish(),
  valid_ts: z.string().nullish(),
});
export type RunMeta = z.infer<typeof RunMeta>;

/** `GET /v1/runs` may answer with a bare array or `{ runs: [...] }`; both normalise to an array. */
export const RunList = z
  .union([z.array(RunMeta), z.looseObject({ runs: z.array(RunMeta) })])
  .transform((value) => (Array.isArray(value) ? value : value.runs));
export type RunList = z.infer<typeof RunList>;

/** `GET /healthz`: liveness plus mode, bundle and the last run. */
export const Health = z.looseObject({
  status: z.string(),
  mode: z.string().nullish(),
  city: z.string().nullish(),
  bundle: z.string().nullish(),
  last_run: z.union([RunMeta, z.string()]).nullish(),
  version: z.string().nullish(),
  time: z.string().nullish(),
});
export type Health = z.infer<typeof Health>;

/** Stage names in cycle order (CLAUDE.md section 11.11). */
export const CYCLE_STAGES = [
  "decode",
  "sky",
  "twin",
  "flash",
  "pulse",
  "products",
  "route",
  "alerts",
  "publish",
] as const;
export type CycleStageName = (typeof CYCLE_STAGES)[number];

export const CycleStage = z.looseObject({
  name: z.string(),
  ms: z.number().nullish(),
  status: z.string().nullish(),
});
export type CycleStage = z.infer<typeof CycleStage>;

/** `GET /v1/cycle/status`: the live cycle and its per-stage timings. */
export const CycleStatus = z.looseObject({
  status: z.string(),
  run_id: z.string().nullish(),
  stage_ms: z.record(z.string(), z.number()).default({}),
  stages: z.array(CycleStage).optional(),
  current_stage: z.string().nullish(),
  started_at: z.string().nullish(),
  total_ms: z.number().nullish(),
  message: z.string().nullish(),
});
export type CycleStatus = z.infer<typeof CycleStatus>;

/** Topics relayed on `WS /v1/live` (CLAUDE.md section 11.11) plus the heartbeat pair. */
export const LIVE_TOPICS = [
  "runs.published",
  "cycle.stage",
  "alert.raised",
  "alert.updated",
  "alert.cleared",
  "obs.assimilated",
  "replay.clock",
  "onboard.progress",
  "ping",
  "pong",
] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];

/** Every live event is `{ type, ts?, payload? }`. */
export const LiveEvent = z.looseObject({
  type: z.string(),
  ts: z.string().nullish(),
  payload: z.unknown().optional(),
});
export type LiveEvent = z.infer<typeof LiveEvent>;

export const ReplayClockPayload = z.looseObject({
  sim_time: z.string(),
  playing: z.boolean().optional(),
  speed: z.number().optional(),
  bundle: z.string().nullish(),
});
export type ReplayClockPayload = z.infer<typeof ReplayClockPayload>;

export const CycleStagePayload = z.looseObject({
  stage: z.string(),
  ms: z.number().nullish(),
  status: z.string().nullish(),
  run_id: z.string().nullish(),
});
export type CycleStagePayload = z.infer<typeof CycleStagePayload>;

export const OnboardProgressPayload = z.looseObject({
  job: z.string(),
  step: z.string(),
  progress: z.number().min(0).max(1).optional(),
  elapsed_s: z.number().nullish(),
  log: z.string().nullish(),
  done: z.boolean().optional(),
});
export type OnboardProgressPayload = z.infer<typeof OnboardProgressPayload>;

/** Depth chips on the report flow map to centimetres with a stated uncertainty (section 11.6). */
export const DEPTH_HINTS = ["ankle", "knee", "waist"] as const;
export type DepthHint = (typeof DEPTH_HINTS)[number];
export const DEPTH_HINT_CM: Record<DepthHint, { cm: number; sd: number; label: string }> = {
  ankle: { cm: 10, sd: 8, label: "Ankle" },
  knee: { cm: 45, sd: 12, label: "Knee" },
  waist: { cm: 90, sd: 15, label: "Waist" },
};

/** `POST /v1/reports` body. */
export const ReportInput = z.object({
  ts: z.string(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  depth_hint: z.enum(DEPTH_HINTS),
  text: z.string().max(280).optional(),
  photo_data_url: z.string().optional(),
  source: z.string().default("public-map"),
});
export type ReportInput = z.infer<typeof ReportInput>;

/** `POST /v1/reports` response; `feedback_streets` is Pulse's "improved the forecast for N streets". */
export const ReportResponse = z.looseObject({
  id: z.string().nullish(),
  accepted: z.boolean().optional(),
  feedback_streets: z.number().int().nullish(),
  message: z.string().nullish(),
});
export type ReportResponse = z.infer<typeof ReportResponse>;
