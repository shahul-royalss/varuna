/**
 * The cycle the console opens on when no `?run=` names one (CLAUDE.md 15: "The replay is
 * pre-seeked to 06:40 and paused on load").
 *
 * Without it the API hands back the newest run, which on the replay is the calm cycle after the
 * storm has passed. The opening instant is the replay store's default simulated time, and a run
 * is matched by instant rather than by string, so a cycle time written with `Z` or with `+05:30`
 * matches the same run. When no baked run sits at the opening, the console keeps the API's
 * default rather than inventing a nearby one.
 */
export interface RunSummary {
  run_id: string;
  cycle_ts: string;
}

export function openingRunId(runs: readonly RunSummary[], openingTs: string): string | undefined {
  const target = Date.parse(openingTs);
  if (!Number.isFinite(target)) return undefined;
  return runs.find((run) => Date.parse(run.cycle_ts) === target)?.run_id;
}
