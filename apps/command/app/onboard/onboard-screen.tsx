"use client";

import { MapPinned } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { CityMap } from "@/components/map/city-map";
import { AppShell } from "@/components/varuna/app-shell";
import { LogStream, type LogLine } from "@/components/varuna/log-stream";
import { MapSlot } from "@/components/varuna/map-slot";
import {
  IDLE_ONBOARDING_STEPS,
  ONBOARDING_STEP_IDS,
  OnboardingSteps,
  type OnboardingStepId,
  type OnboardingStepState,
} from "@/components/varuna/onboarding-steps";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import { loadBuildings, loadDrains, type DrainPath } from "@/lib/api/city-layers";
import {
  latestOnboard,
  pollOnboard,
  startOnboard,
  type OnboardJob,
  type OnboardStepId,
} from "@/lib/api/onboard";
import {
  allSegments,
  joinSegments,
  loadRunDepth,
  type GeoSegment,
  type RunDepth,
} from "@/lib/api/run-depth";
import { apiUrl } from "@/lib/api/client";
import { useLive, type LiveTopicFilter } from "@/lib/api/live";
import type { LiveEvent } from "@/lib/api/schemas";
import { useLayerFade } from "@/lib/hooks/use-layer-fade";
import { formatIst } from "@/lib/format";
import { OnboardLayers, type WizardLayerId, type WizardLayerState } from "./onboard-layers";

/** The shape `/v1/city/{city}/layers/segments` returns, as the two readers below want it. */
type SegmentCollection = Parameters<typeof allSegments>[0];

/** The city the wizard builds on stage (CLAUDE.md 3.3's `CHN-SOUTH`). */
const CITY = "chennai";
const DESIGN_STORM = "CHN-IDF-25yr";

/** How often the job is polled. A build is minutes long; a second is smooth and costs nothing. */
const POLL_MS = 1000;

/** The one socket topic the wizard listens to. Module-level so `useLive` never re-subscribes. */
const ONBOARD_TOPICS: readonly LiveTopicFilter[] = ["onboard.progress"];

/** Chennai's AOI (CLAUDE.md 3.3), so the map frames the right place before any layer arrives. */
const CHENNAI_BOUNDS: [[number, number], [number, number]] = [
  [80.2, 12.96],
  [80.28, 13.05],
];

/** Pipes drawn at once. Chennai's graph is smaller than Mumbai's, but the cap keeps 60 fps. */
const MAP_EDGE_LIMIT = 4000;

/** The API's step names to the component's. Two vocabularies for one list, joined in one place. */
const STEP_OF: Record<OnboardStepId, OnboardingStepId> = {
  choose_area: "area",
  fetch_open_data: "fetch",
  condition_terrain: "condition",
  infer_drains: "drains",
  build_graph: "graph",
  first_forecast: "forecast",
};

/**
 * Which step writes each map layer, as the index of that step in `ONBOARDING_STEP_IDS`.
 *
 * The wizard tries a layer as soon as its step has completed, and again on every later step, so a
 * layer appears the moment the pipeline has actually written it rather than at a time this screen
 * has decided looks good. In practice `varuna_city.export` writes the map GeoJSONs near the end
 * of the build, so most of the stack lands within a few seconds of each other - the order is the
 * pipeline's, not a script's.
 */
const LAYER_AFTER: Record<Exclude<WizardLayerId, "depth">, number> = {
  streets: ONBOARDING_STEP_IDS.indexOf("fetch"),
  buildings: ONBOARDING_STEP_IDS.indexOf("fetch"),
  drains: ONBOARDING_STEP_IDS.indexOf("drains"),
};

/**
 * Turn one job into the six step rows the wizard shows.
 *
 * The API reports which step it is on and the overall progress; the rows before it are done and
 * the rows after are waiting. Per-step elapsed time is not reported separately, so the running
 * step carries the job's elapsed time and the rest carry none - rather than a number this screen
 * would have to invent (CLAUDE.md 6).
 */
function toSteps(job: OnboardJob | null): OnboardingStepState[] {
  if (!job || job.status === "none") return IDLE_ONBOARDING_STEPS;
  const current = ONBOARDING_STEP_IDS.indexOf(STEP_OF[job.step] ?? "area");
  const failed = job.status === "failed";
  const finished = job.status === "finished";

  return ONBOARDING_STEP_IDS.map((id, index) => {
    if (finished) return { id, progress: 100, elapsedS: 0, status: "done" as const };
    if (index < current) return { id, progress: 100, elapsedS: 0, status: "done" as const };
    if (index === current) {
      return {
        id,
        progress: Math.round(job.progress * 100),
        elapsedS: job.elapsedS,
        status: failed ? ("failed" as const) : ("running" as const),
      };
    }
    return { id, progress: 0, elapsedS: 0, status: "waiting" as const };
  });
}

/** The pipeline's lines, as the log component wants them. The text is never rewritten here. */
function toLines(job: OnboardJob | null): LogLine[] {
  if (!job) return [];
  return job.logTail.map((text, index) => ({
    // The API sends the message; the wizard stamps arrival order so the list has stable keys.
    ts: job.startedAt ?? new Date().toISOString(),
    level: /fail|error/i.test(text) ? ("error" as const) : ("info" as const),
    text: `${index + 1}. ${text}`,
  }));
}

/**
 * How far the build has got, as an index into `ONBOARDING_STEP_IDS`, or -1 before it starts.
 *
 * A finished build counts as past every step, including one that a reopened tab never watched:
 * the layers are on disk and the map must draw them.
 */
export function reachedStepIndex(job: OnboardJob | null): number {
  if (!job) return -1;
  // A city built in an earlier session has no job in the API's memory - jobs do not outlive the
  // process - but its layers are on disk, and a wizard that drew nothing for them would be
  // telling the operator Chennai had not been built when it had.
  if (job.built || job.status === "finished") return ONBOARDING_STEP_IDS.length;
  if (job.status === "none") return -1;
  const current = ONBOARDING_STEP_IDS.indexOf(STEP_OF[job.step] ?? "area");
  // The step it is on has not finished, so only the ones before it have written anything.
  return current;
}

/**
 * The step of the first forecast with the most streets over 15 cm - the depth ramp's first wet
 * band (CLAUDE.md 6.2).
 *
 * A design storm's water arrives during the run, so step 0 is a nearly dry Chennai: drawing it
 * would end the wizard on a map that looks like nothing happened. This picks the wettest step,
 * and the panel prints which time it is showing, so the map is a moment the run actually
 * contains rather than an unlabelled "peak".
 */
export function wettestStep(depthCm: Map<string, number[]>, overCm = 15): number {
  const counts: number[] = [];
  for (const series of depthCm.values()) {
    for (let step = 0; step < series.length; step += 1) {
      if (series[step] >= overCm) counts[step] = (counts[step] ?? 0) + 1;
    }
  }
  let best = 0;
  for (let step = 1; step < counts.length; step += 1) {
    if ((counts[step] ?? 0) > (counts[best] ?? 0)) best = step;
  }
  return best;
}

/**
 * Where the finish card's button goes (task D-21).
 *
 * The city alone is not enough. `/console` opens on the cycle the demo script starts from, and
 * that rule is about Mumbai's 2 July replay; a Chennai console with no run named would fall back
 * to whatever the API calls newest for Chennai, which before this build existed was nothing at
 * all. Naming this build's own first run is what makes the card land on the water it just made.
 */
export function consoleHref(city: string, runId: string | null): string {
  const params = new URLSearchParams({ city });
  if (runId) params.set("run", runId);
  return `/console?${params.toString()}`;
}

/**
 * City-in-a-box wizard (CLAUDE.md 7.9, tasks P9.5, P9.6 and D-21).
 *
 * Every line in the log comes from `services/city` and every step's status comes from the job, so
 * a judge watching this is watching the pipeline rather than an animation. The map stacks the
 * layers as the build writes them - roads, buildings, the inferred drain graph, and finally the
 * first forecast's depth - each fading in over 400 ms (motion M19).
 */
export function OnboardScreen() {
  const [job, setJob] = useState<OnboardJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // The city's own segment layer, kept as it arrived: `allSegments` draws the whole network and
  // `joinSegments` colours the subset the first forecast wetted, and both want this shape.
  const [roads, setRoads] = useState<SegmentCollection | null>(null);
  const [buildings, setBuildings] = useState<[number, number][][] | null>(null);
  const [drains, setDrains] = useState<DrainPath[] | null>(null);
  const [depth, setDepth] = useState<RunDepth | null>(null);
  const [show, setShow] = useState<Record<WizardLayerId, boolean>>({
    streets: true,
    buildings: true,
    drains: true,
    depth: true,
  });
  /** Which (job, layer) pairs have already been asked for, so a poll does not refetch. */
  const asked = useRef(new Set<string>());

  // Rejoin a build already in flight, so reopening the tab does not look like nothing happened.
  useEffect(() => {
    const controller = new AbortController();
    latestOnboard(CITY, controller.signal)
      .then(setJob)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // The pipeline's own `onboard.progress` events over the live socket (CLAUDE.md 7.9: "streams
  // progress over the WebSocket"). Each step start and finish for this city asks for the job at
  // once, so a step lands on screen when the pipeline reports it rather than on the next poll
  // tick; the job endpoint is what carries the log tail, so the event is the trigger and the job
  // is the state. The poll below stays as the fallback for a dropped socket.
  const liveJobId = job?.status === "running" || job?.status === "queued" ? job.jobId : null;
  const [streamed, setStreamed] = useState(0);
  const onProgress = useCallback(
    (event: LiveEvent) => {
      const payload = (event.payload ?? {}) as { city?: unknown };
      if (!liveJobId || payload.city !== CITY) return;
      setStreamed((n) => n + 1);
      pollOnboard(liveJobId)
        .then(setJob)
        .catch(() => undefined);
    },
    [liveJobId],
  );
  useLive({ topics: ONBOARD_TOPICS, onEvent: onProgress, enabled: liveJobId !== null });

  // Poll while the job is live. Stops the moment it finishes or fails.
  useEffect(() => {
    const id = job?.jobId;
    if (!id || (job.status !== "running" && job.status !== "queued")) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      pollOnboard(id, controller.signal)
        .then(setJob)
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [job?.jobId, job?.status]);

  const reached = reachedStepIndex(job);
  const jobKey = job?.jobId ?? (job?.built ? "existing" : "none");
  const firstRunId = job?.firstRunId ?? null;
  const built = job?.built ?? false;

  // Ask for each layer once its step has completed. A layer the pipeline has not written yet
  // answers 404; that is not an error here, it is "not yet", and the next step tries again.
  useEffect(() => {
    if (reached < 0) return;
    const controller = new AbortController();
    const once = (layer: string, load: () => Promise<void>) => {
      const key = `${jobKey}:${layer}`;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      void load().catch(() => {
        // Not written yet (or the request was aborted): forget the attempt so a later step retries.
        asked.current.delete(key);
      });
    };

    if (reached > LAYER_AFTER.streets) {
      once("streets", async () => {
        const response = await fetch(apiUrl(`/v1/city/${CITY}/layers/segments`), {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`segments ${response.status}`);
        setRoads((await response.json()) as SegmentCollection);
      });
    }
    if (reached > LAYER_AFTER.buildings) {
      once("buildings", async () => {
        setBuildings(await loadBuildings(CITY, controller.signal));
      });
    }
    if (reached > LAYER_AFTER.drains) {
      once("drains", async () => {
        const pipes = await loadDrains(CITY, controller.signal);
        if (pipes.length === 0) throw new Error("drains not written yet");
        setDrains(pipes.slice(0, MAP_EDGE_LIMIT));
      });
    }
    // This build's own first run, or - reopening a city built in an earlier session, where the
    // job is gone from the API's memory - whichever run is newest for it, which is what the
    // console would draw. Either way it is a run this city actually has.
    if (firstRunId || built) {
      once("depth", async () => {
        setDepth(await loadRunDepth(firstRunId ?? undefined, controller.signal, undefined, CITY));
      });
    }
    return () => controller.abort();
  }, [reached, jobKey, firstRunId, built]);

  const segments = useMemo<GeoSegment[] | null>(() => (roads ? allSegments(roads) : null), [roads]);
  // The first forecast's own wet streets, coloured by its depth.
  const wet = useMemo(
    () => (depth && roads ? joinSegments(roads, depth.depthCm) : []),
    [depth, roads],
  );

  // Motion M19: each layer fades in over 400 ms when it arrives, and instantly under reduced
  // motion. A reopened tab whose layers are already loaded reads 1 at once and does not replay.
  const fadeStreets = useLayerFade("streets", (segments?.length ?? 0) > 0 && show.streets);
  const fadeBuildings = useLayerFade("buildings", (buildings?.length ?? 0) > 0 && show.buildings);
  const fadeDrains = useLayerFade("drains", (drains?.length ?? 0) > 0 && show.drains);
  const fadeDepth = useLayerFade("depth", depth !== null && show.depth);

  // Which step of the first forecast the map draws, and the time it stands for.
  const depthStep = useMemo(() => (depth ? wettestStep(depth.depthCm) : 0), [depth]);
  const depthAt = depth?.validTs[depthStep];

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      asked.current.clear();
      setRoads(null);
      setBuildings(null);
      setDrains(null);
      setDepth(null);
      setJob(await startOnboard(CITY, DESIGN_STORM));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setStarting(false);
    }
  }, []);

  const running = job?.status === "running" || job?.status === "queued" || starting;
  const finished = job?.status === "finished";
  const hasLayers = (segments?.length ?? 0) > 0 || (drains?.length ?? 0) > 0;

  const layerState: Record<WizardLayerId, WizardLayerState> = {
    streets: { on: show.streets, count: segments?.length },
    buildings: { on: show.buildings, count: buildings?.length },
    drains: { on: show.drains, count: drains?.length },
    depth: {
      on: show.depth,
      count: depth ? depth.depthCm.size : undefined,
      detail: depthAt ? `Wettest step, ${formatIst(depthAt)} IST` : undefined,
    },
  };

  return (
    <AppShell>
      <div className="flex h-full min-h-0 flex-col lg:flex-row">
        <div
          // Focusable: until a build has run this column scrolls and holds only one button, so a
          // keyboard user could not otherwise reach the bottom of it (WCAG 2.1.1, P10.3).
          tabIndex={0}
          role="region"
          aria-label="Onboarding steps and log"
          className="focus-visible:ring-tide/50 border-line flex min-h-0 shrink-0 flex-col gap-4 overflow-y-auto border-b p-6 focus-visible:ring-3 focus-visible:outline-none lg:w-[420px] lg:border-r lg:border-b-0"
        >
          <PageHeader
            title="City in a box"
            description="Open data in, digital twin out. Chennai in minutes."
            honesty="Inferred drain graph"
          />
          <div className="flex flex-col gap-1">
            <Button onClick={() => void start()} disabled={running} aria-busy={running}>
              <MapPinned aria-hidden="true" />
              {running ? "Building Chennai" : "Start onboarding Chennai"}
            </Button>
            <p className="type-micro text-text-3 max-w-[52ch]">
              {running
                ? `Step ${Math.round((job?.progress ?? 0) * 100)} %, ${Math.round(job?.elapsedS ?? 0)} s elapsed.${
                    streamed > 0
                      ? ` ${streamed} progress ${streamed === 1 ? "event" : "events"} streamed over the live socket.`
                      : ""
                  }`
                : "Runs from city/cache/chennai: terrain, roads and land cover are already downloaded."}
            </p>
          </div>

          {error ? (
            <p className="rounded-control border-line bg-well type-small text-text-2 border p-3">
              {error}
            </p>
          ) : null}

          <PanelErrorBoundary title="Onboarding steps">
            <Panel
              title="Steps"
              description="Every step reports its own progress and elapsed time."
            >
              <OnboardingSteps steps={toSteps(job)} />
            </Panel>
          </PanelErrorBoundary>

          <PanelErrorBoundary title="Pipeline log">
            <Panel
              title="Pipeline log"
              description="Real lines from services/city, never scripted copy."
            >
              <LogStream
                lines={toLines(job)}
                emptyDescription="Logs stream here when the wizard runs."
              />
            </Panel>
          </PanelErrorBoundary>

          <Panel
            title="Finish card"
            description="What the wizard shows when the first forecast lands."
          >
            <div
              className={
                finished
                  ? "rounded-control border-line bg-well space-y-3 border p-4"
                  : "rounded-control border-line bg-well space-y-3 border p-4 opacity-60"
              }
            >
              <p className="type-body text-text-2 max-w-[52ch]">
                First forecast, uncalibrated. VARUNA learns Chennai&apos;s drains from the next
                monsoon.
              </p>
              {finished && firstRunId ? (
                <p className="type-micro text-text-3">
                  First run <span className="num">{firstRunId}</span>, built in{" "}
                  <span className="num">{Math.round(job?.elapsedS ?? 0)}</span> s.
                </p>
              ) : null}
              {finished ? (
                // A plain anchor, not `next/link`, and deliberately: `/console` reads `?run=` in
                // a `useState` initialiser, which under the App Router runs on the *server* during
                // a client-side navigation - so a `Link` here lands on the console with no run
                // pinned, and its opening rule then pins Mumbai's 06:40 cycle over a Chennai map
                // (measured in a browser, 2026-09-19). A full navigation makes the console read
                // the URL the card actually carries. The console-side fix - read the parameter in
                // an effect, and pass `city` to its run-registry lookup - belongs to that screen.
                //
                // `Button` does not take `asChild`, so a link that looks like a button carries the
                // button's own classes, and it stays a real anchor, which is what middle-click and
                // "open in new tab" need.
                <a
                  href={consoleHref(CITY, firstRunId)}
                  className="rounded-control border-line type-small text-text hover:bg-well focus-visible:ring-tide/50 inline-flex h-8 items-center gap-2 border bg-transparent px-3 focus-visible:ring-3"
                >
                  Open Chennai console
                </a>
              ) : (
                <Button variant="outline" size="sm" disabled aria-disabled="true">
                  Open Chennai console
                </Button>
              )}
              <p className="type-micro text-text-3">
                The city switcher lists Chennai once the build has written its map layers.
              </p>
            </div>
          </Panel>
        </div>

        <PanelErrorBoundary title="Onboarding map">
          <div className="relative min-h-[24rem] min-w-0 flex-1">
            {hasLayers ? (
              <>
                <CityMap
                  frames={depth && show.depth ? depth.frames : []}
                  rasterBounds={depth && show.depth ? depth.bounds : null}
                  baseSegments={show.streets ? (segments ?? []) : []}
                  segments={show.depth ? wet : []}
                  surcharge={[]}
                  hotspots={[]}
                  buildings={show.buildings ? (buildings ?? []) : []}
                  drains={show.drains ? (drains ?? []) : []}
                  bounds={CHENNAI_BOUNDS}
                  showDrains={(drains?.length ?? 0) > 0 && show.drains}
                  showRaster={depth !== null && show.depth}
                  showSurcharge={false}
                  showBuildings={(buildings?.length ?? 0) > 0 && show.buildings}
                  step={depthStep}
                  layerFade={{
                    streets: fadeStreets,
                    buildings: fadeBuildings,
                    drains: fadeDrains,
                    raster: fadeDepth,
                  }}
                />
                <div className="absolute top-4 left-4">
                  <OnboardLayers
                    value={layerState}
                    onChange={(key, next) => setShow((s) => ({ ...s, [key]: next }))}
                  />
                </div>
              </>
            ) : (
              <MapSlot
                emptyState={{
                  title: "No Chennai layers yet",
                  description: "Press Start onboarding Chennai.",
                }}
              />
            )}
          </div>
        </PanelErrorBoundary>
      </div>
    </AppShell>
  );
}
