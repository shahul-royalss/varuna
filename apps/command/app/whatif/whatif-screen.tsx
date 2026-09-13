"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { MAX_CLEANED_SEGMENTS, runWhatIf, type WhatIfResult } from "@/lib/api/whatif";

import { AppShell } from "@/components/varuna/app-shell";
import { EmptyState } from "@/components/varuna/empty-state";
import { DeltaTable, type DeltaRow } from "@/components/varuna/delta-table";
import { CityMap } from "@/components/map/city-map";
import { CyclePicker } from "@/components/varuna/cycle-picker";
import { MapSlot } from "@/components/varuna/map-slot";
import { apiUrl } from "@/lib/api/client";
import { allSegments, type GeoSegment } from "@/lib/api/run-depth";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import {
  DEFAULT_WHATIF_VALUES,
  WhatIfControls,
  formatRainScale,
  formatTideOffset,
  type WhatIfValues,
} from "@/components/varuna/whatif-controls";

/** Delta rows arrive from the emulator in Phase 7; until then the table shows its empty state. */
/** Segments shown in the delta table. More than this and nobody reads to the bottom. */
const MAX_DELTA_ROWS = 25;

/** Motion M13: the diff layer wipes left to right over 500 ms (CLAUDE.md 8). */
const WIPE_MS = 500;

/** A full-AOI Twin run on this city measures 58-114 s in six of the seven baked cycles, against
 * the 10 s CLAUDE.md 14 budget for a physics check. The control says so rather than starting
 * something that would look hung. */
const PHYSICS_DISABLED_REASON =
  "Runs the Twin on the same scenario; a full-AOI Mumbai run measures 58-114 s against a 10 s " +
  "budget, so it is not wired to this button yet";

/** The same refusal the endpoint returns (`POST /v1/whatif/physics-check`, 501), so the panel
 * says why no disagreement is on screen instead of implying the button was never pressed. */
const PHYSICS_UNAVAILABLE_REASON =
  "The check needs a Twin re-run of the scenario. A full-AOI Mumbai Twin run measures 58-114 s " +
  "in six of the seven baked cycles against a 10 s budget, so it would have to run on a bounded " +
  "hotspot crop rather than the whole AOI; that crop is not built yet (P7.8).";

/** "Top 14 by beta" is a *ranking* of pipes by how much cleaning each would move a junction, and
 * nothing computes one: Flash-lite is element-wise per segment, so a pipe that is not under the
 * street has exactly zero effect and there is nothing to rank (ADR-0042). Cleaning itself works -
 * segments picked on a hotspot are sent and cleaned - so the switch names what is missing rather
 * than implying cleaning is. */
const CLEAN_DISABLED_REASON =
  "Ranking pipes by beta needs attribution, which Flash-lite cannot compute (ADR-0042). Pick a " +
  "hotspot's segments with “Clean in what-if” instead";

/** The endpoint takes rain, tide and cleaned road segments. There is no pump-plan field. */
const PUMP_DISABLED_REASON = "The pump plan is not a what-if lever yet (P7.7)";

/** The scenario as one line of copy, so the controls and the result panel agree. Only the levers
 * the request actually carries: naming the pump switch here would claim a scenario the endpoint
 * was never asked to run (CLAUDE.md rule 6). */
function scenarioLine(values: WhatIfValues): string {
  const head = `Rain ${formatRainScale(values.rainScale)}, tide ${formatTideOffset(values.tideOffsetM)}`;
  const n = values.cleanedSegments.length;
  return n === 0 ? head : `${head}, ${n} segment${n === 1 ? "" : "s"} cleaned`;
}

/**
 * The segments a deep link asked to clean: `?segments=S100841069-000,S100841079-000`.
 *
 * Deduplicated in the order given and capped, because the URL is a hand-editable surface and a
 * list longer than the lever is written around would be silently truncated by the copy instead.
 * The cap is stated on screen when it bites.
 */
function parseSegments(raw: string | null): { picked: string[]; asked: number } {
  const ids = (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const unique = [...new Set(ids)];
  return { picked: unique.slice(0, MAX_CLEANED_SEGMENTS), asked: unique.length };
}

/**
 * What-if lab (CLAUDE.md section 7.7).
 *
 * What is live: the rain and tide sliders, the segments to clean, `POST /v1/whatif` on the
 * emulator (113-213 ms warm with fourteen segments cleaned, re-measured 2026-09-13 against
 * section 14's 1 s budget; the 62-78 ms on record was rain only), the difference layer with its M13
 * wipe, the delta table, and the held-out skill printed beside every answer.
 *
 * Cleaning is a lever with a ceiling rather than a refusal: the fit is element-wise per segment,
 * so a cleaned segment moves itself and nothing else (measured 0.000000 cm at the deepest street
 * with every *other* pipe in the city cleaned, ADR-0042), and the ceiling is printed beside the
 * chips before the operator presses Run.
 *
 * What is refused, and says so on screen rather than looking idle: the top-14-by-beta ranking,
 * because nothing can attribute a junction's depth to pipes on this emulator; the pump plan,
 * because the endpoint has no field for one; and the physics check, because
 * `POST /v1/whatif/physics-check` answers 501 and the Twin it would re-run measures 58-114 s in
 * the baked cycles against a 10 s budget.
 *
 * `?segments=a,b,c&run=<run id>` is the console's "Clean in what-if" deep link (P7.11): the
 * hotspot's own road segments arrive as chips and the cycle it was pressed on is the cycle the
 * question is asked about.
 */
function WhatIfLab() {
  const searchParams = useSearchParams();
  // Read once. The chips are editable after mount, so re-reading the URL on every render would
  // put back a segment the operator has just removed.
  const [deepLink] = useState(() => ({
    ...parseSegments(searchParams.get("segments")),
    runId: searchParams.get("run") ?? undefined,
    hotspot: searchParams.get("from") ?? undefined,
  }));
  const [values, setValues] = useState<WhatIfValues>({
    ...DEFAULT_WHATIF_VALUES,
    cleanedSegments: deepLink.picked,
  });
  // The city's own street geometry, so a scenario's per-segment deltas have something to be drawn
  // on. Loaded once; the scenario only ever changes the numbers attached to these paths.
  const [streets, setStreets] = useState<GeoSegment[]>([]);
  const [wipe, setWipe] = useState(1);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl("/v1/city/mumbai/layers/segments"), { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { features: [] }))
      .then((geojson) => setStreets(allSegments(geojson)))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // **Which cycle.** A what-if is a question about one forecast. Left unsaid, the handler answers
  // about the newest baked run - 09:10 IST, after the storm, 1,498 wet segments - while the same
  // scenario at 08:40 has 6,474 to move. The operator picks the cycle here as they do on the
  // console, on Alerts and on Pumps - or the deep link brings the cycle it was pressed on.
  const [runId, setRunId] = useState<string | undefined>(deepLink.runId);

  // A different cycle is a different answer, so the last one stops being shown with it.
  const pickCycle = useCallback((next: string) => {
    setRunId(next);
    setResult(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (scenario: WhatIfValues) => {
      setRunning(true);
      setError(null);
      try {
        setResult(
          await runWhatIf({
            rainScale: scenario.rainScale,
            tideOffsetM: scenario.tideOffsetM,
            cleanedSegments: scenario.cleanedSegments,
            runId,
          }),
        );
      } catch (failure) {
        // The API's own words: a refused tide scenario explains itself better than any string
        // this file could invent (CLAUDE.md 6.8 - errors say what happened and the fix).
        setError(failure instanceof Error ? failure.message : String(failure));
        setResult(null);
      } finally {
        setRunning(false);
      }
    },
    [runId],
  );

  // The scenario's deltas, joined onto the city's geometry. Only the segments the scenario
  // actually moved: the rest are already drawn as the dry base layer underneath, and pushing
  // 21,296 unchanged paths through the diff accessor would cost the frame rate for nothing.
  const diffSegments = useMemo(() => {
    if (!result || streets.length === 0) return [];
    const delta = new Map(result.segments.map((r) => [r.segmentId, r.deltaCm]));
    return streets
      .filter((s) => delta.has(s.id))
      .map((s) => ({ ...s, deltaCm: delta.get(s.id) ?? 0 }));
  }, [result, streets]);

  // Motion M13: the diff wipes in left to right over 500 ms whenever a result arrives.
  useEffect(() => {
    if (!result) return;
    if (reducedMotion) {
      const settle = requestAnimationFrame(() => setWipe(1));
      return () => cancelAnimationFrame(settle);
    }
    let frame = 0;
    const started = performance.now();
    const tick = () => {
      const t = Math.min((performance.now() - started) / WIPE_MS, 1);
      setWipe(t);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [result, reducedMotion]);

  const rows: DeltaRow[] = (result?.segments ?? []).slice(0, MAX_DELTA_ROWS).map((row) => ({
    id: row.segmentId,
    hotspot: row.segmentId,
    beforeCm: row.beforeCm,
    afterCm: row.afterCm,
    // No minutes: the endpoint reports peak depth per segment and no duration, and DeltaTable
    // drops the column when no row carries one rather than printing a computed-looking zero.
  }));

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-6 p-6">
          <PageHeader
            title="What-if lab"
            description="Ask the twin a question and get the answer before the next radar frame."
            honesty="Reduced-order emulator calibrated to VARUNA-Twin"
          />

          <CyclePicker currentRunId={result?.runId ?? runId} onPick={pickCycle} />

          <div className="grid min-h-0 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <PanelErrorBoundary title="Scenario">
              <Panel
                title="Scenario"
                description="Rain, tide and the segments to clean are levers; the pump plan is not yet."
                className="min-w-0"
              >
                <WhatIfControls
                  initial={values}
                  onChange={setValues}
                  onRun={(scenario) => void run(scenario)}
                  physicsDisabledReason={PHYSICS_DISABLED_REASON}
                  cleanedSource={deepLink.hotspot}
                  cleanDisabled
                  cleanDisabledReason={CLEAN_DISABLED_REASON}
                  pumpDisabled
                  pumpDisabledReason={PUMP_DISABLED_REASON}
                />
                {deepLink.asked > deepLink.picked.length ? (
                  // The URL is hand-editable, so a longer list is possible; saying nothing would
                  // run a smaller scenario than the address bar describes.
                  <p className="mt-3 type-micro text-text-3">
                    The link asked for {deepLink.asked} segments; the first {MAX_CLEANED_SEGMENTS}{" "}
                    are loaded.
                  </p>
                ) : null}
                {running ? (
                  <p className="mt-3 type-small text-text-3">Running the scenario...</p>
                ) : null}
                {error ? <p className="mt-3 type-small text-text-2">{error}</p> : null}
                {result ? (
                  // The run the answer is about, as /route prints it. Without it the screen says
                  // how much the scenario moved without saying which forecast it moved: the same
                  // 1.3x is 1,498 wet segments at 09:10 IST and 6,474 at 08:40.
                  <p className="mt-3 type-micro text-text-3">
                    Ran on run <span className="num">{result.runId}</span> in{" "}
                    <span className="num">{Math.round(result.ms)}</span> ms.
                    {result.cleanedSegments.length > 0
                      ? ` ${result.cleanedSegments.length} segment${result.cleanedSegments.length === 1 ? "" : "s"} cleaned.`
                      : ""}
                    {/* What the run could not clean. The endpoint drops an id this city has no
                        segment for rather than failing, so the count has to be visible or a
                        partly wrong link reads as a whole answer (rule 6). */}
                    {result.cleanedUnmatched.length > 0
                      ? ` ${result.cleanedUnmatched.length} of the ids asked for are not road segments in this city and were not cleaned.`
                      : ""}
                  </p>
                ) : null}
              </Panel>
            </PanelErrorBoundary>

            <div className="flex min-w-0 flex-col gap-4">
              <PanelErrorBoundary title="Difference layer">
                <Panel
                  title="Difference layer"
                  description="Segments coloured by change in depth: improved, worse, unchanged."
                  className="min-w-0"
                >
                  <div className="relative h-[380px] overflow-hidden rounded-control border border-line">
                    {diffSegments.length > 0 ? (
                      <CityMap
                        frames={[]}
                        rasterBounds={null}
                        baseSegments={streets}
                        segments={diffSegments}
                        surcharge={[]}
                        hotspots={[]}
                        diffMode
                        diffProgress={wipe}
                        showRaster={false}
                        showSurcharge={false}
                        showBuildings={false}
                        showHotspots={false}
                        step={0}
                      />
                    ) : (
                      <MapSlot
                        emptyState={{
                          title: "No scenario run yet",
                          // Names only the two levers this screen actually sends. The pipe and pump
                          // switches are disabled with their reasons beside them, so inviting the
                          // operator to "set the pipes" would point at a control that cannot move.
                          description: "Set the rain and the tide, then press Run what-if.",
                        }}
                      />
                    )}
                  </div>
                  <p className="mt-3 type-micro text-text-3">
                    {result
                      ? // The run and the milliseconds are stamped once, beside the scenario that
                        // produced them; this line is the count.
                        `${result.nWorse.toLocaleString("en-IN")} segments deeper, ${result.nImproved.toLocaleString("en-IN")} shallower.`
                      : `Scenario ready to run: ${scenarioLine(values)}.`}
                  </p>
                  {result ? (
                    <p className="mt-1 type-micro text-text-3">
                      Level from the Twin&rsquo;s own forecast for this run; the emulator supplies
                      only the difference. Emulator skill on held-out storms: RMSE{" "}
                      {result.emulator.rmseCm.toFixed(1)} cm, CSI{" "}
                      {result.emulator.csi30cm.toFixed(2)} at 30 cm.
                    </p>
                  ) : null}
                </Panel>
              </PanelErrorBoundary>

              <PanelErrorBoundary title="Hotspot deltas">
                <Panel
                  title="Hotspot deltas"
                  // The response carries before and after depth per hotspot; it does not carry
                  // minutes-impassable, and nothing computes it, so the panel does not
                  // promise it (rule 6).
                  description="Before and after depth per hotspot, from the emulator."
                  className="min-w-0"
                >
                  <DeltaTable rows={rows} />
                </Panel>
              </PanelErrorBoundary>

              <PanelErrorBoundary title="Physics check">
                <Panel
                  title="Physics check"
                  description="How far the emulator sits from a Twin run on the same scenario."
                  className="min-w-0"
                >
                  {/* `AgreementBar` renders the comparison the day the endpoint answers; until
                      then the panel carries the endpoint's own reason, because its empty state
                      reads as "you have not pressed the button" and the button cannot work. */}
                  <EmptyState
                    title="Physics check not available"
                    description={PHYSICS_UNAVAILABLE_REASON}
                  />
                </Panel>
              </PanelErrorBoundary>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * The lab, behind the Suspense boundary `useSearchParams` needs.
 *
 * Without it `next build` refuses the route: a client component reading the query string cannot
 * be prerendered, and Next asks for the boundary rather than silently opting the whole page into
 * client rendering. The fallback is what the lab looks like before its own data loads anyway.
 */
export function WhatIfScreen() {
  return (
    <Suspense
      fallback={
        <AppShell>
          <div className="mx-auto flex max-w-[1440px] flex-col gap-6 p-6">
            <PageHeader
              title="What-if lab"
              description="Ask the twin a question and get the answer before the next radar frame."
              honesty="Reduced-order emulator calibrated to VARUNA-Twin"
            />
          </div>
        </AppShell>
      }
    >
      <WhatIfLab />
    </Suspense>
  );
}
