"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { FloodMap } from "@/components/map/flood-map";
import type { Isochrone } from "@/components/map/city-map";
import { apiUrl } from "@/lib/api/client";
import type { RunDepth } from "@/lib/api/run-depth";
import { loadDrainHealth, type DrainHealth } from "@/lib/api/drains";
import { loadHotspots, type Hotspot, type HotspotSet } from "@/lib/api/hotspots";
import type { MapFocus } from "@/components/map/city-map";
import { loadSurcharge, type SurchargeSet } from "@/lib/api/surcharge";
import { reversedFlowSummary } from "@/components/map/layers/reversed-flow";
import { AppShell } from "@/components/varuna/app-shell";
import { MapSlot } from "@/components/varuna/map-slot";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import { ReplayPanel } from "@/components/varuna/replay-panel";
import { HotspotDrawer } from "@/components/varuna/hotspot-drawer";
import { CyclePicker } from "@/components/varuna/cycle-picker";
import { LayerPanel, type LayerToggles, type LayerKey } from "@/components/varuna/layer-panel";
import { registerLayerShortcut, type LayerKey as ShortcutLayerKey } from "@/lib/shortcuts";
import { ProbabilityLegend } from "@/components/varuna/probability-legend";
import { SegmentPopover } from "@/components/varuna/segment-popover";
import { Skeleton } from "@/components/varuna/skeleton";
import type { SegmentPick } from "@/components/map/city-map";
import { useTruthPins } from "@/lib/hooks/use-truth-pins";
import { RightRail } from "@/components/varuna/right-rail";
import { SkyPanel } from "@/components/varuna/sky-panel";
import { TimeBar } from "@/components/varuna/time-bar";
import { edgeFadeStyle, useScrollEdges } from "./use-scroll-edges";
import { fetchOpeningRunId } from "@/lib/opening-run";
import { DEFAULT_CITY, cityFromSearch } from "@/lib/city";
import { DEFAULT_SIM_TIME } from "@/lib/stores/replay";
import { useRunStore } from "@/lib/stores/run";
import { useUiStore } from "@/lib/stores/ui";

/**
 * The command console (CLAUDE.md section 7.2). The map slot, the replay panel, the right rail and
 * the time bar are the Phase 0 shell; `CityMap`, the real time bar and the hotspot drawer land in
 * Phase 6.
 *
 * The rain panel on the left is Phase 3 scaffolding (task P3.8): it proves the Sky cube is real and
 * readable from the browser before there is a map to draw it on. Phase 6 deletes it - the panel, its
 * toggle and these three lines - and keeps `FanChart`, which the hotspot drawer needs anyway.
 */
/** IST clock time of a step, or a dash before the run has loaded. */
function formatStep(iso: string | undefined): string {
  if (!iso) return "--:--";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? "--:--"
    : parsed.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      });
}

/** Motion M7: 5-minute steps advance about three a second while playing. */
const PLAY_INTERVAL_MS = 320;

/** How many learned pipes to ask for. The cycle writes the 6,000 worst by blockage, which is what
 * `/drains` asks for too, so the console's Drains mode and the X-ray colour the same set. */
const LEARNED_EDGE_LIMIT = 6000;

/**
 * The console, behind the Suspense boundary `useSearchParams` needs.
 *
 * Without it `next build` refuses the route: a client component reading the query string cannot be
 * prerendered, and Next asks for the boundary rather than opting the whole page into client
 * rendering. The fallback is the empty map slot the console shows before its run has loaded anyway.
 */
export function ConsoleScreen() {
  return (
    <Suspense
      fallback={
        <AppShell>
          <div className="relative h-full min-h-0 w-full">
            <MapSlot />
          </div>
        </AppShell>
      }
    >
      <ConsoleView />
    </Suspense>
  );
}

function ConsoleView() {
  const router = useRouter();
  // The query string, read through `useSearchParams` rather than `window.location`.
  //
  // It used to be read once, in a `useState` initialiser. Under the App Router that runs while the
  // router is still mid-navigation, so a `next/link` to `/console?run=<id>` landed with no run and
  // fell back to the newest - and a second link, from one console URL to another, never changed
  // anything at all, because an initialiser runs once per mount. This hook is the router's own
  // value and re-renders when it changes, which is what makes a navigation land where it points.
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const pinnedRun = searchParams.get("run") ?? undefined;
  // Which city this console is of. Only read by the fetches, never rendered, so the server's
  // Mumbai and a client's `?city=` can never disagree on screen.
  const city = cityFromSearch(search);
  const replayPanelOpen = useUiStore((s) => s.replayPanelOpen);
  const [skyPanelOpen, setSkyPanelOpen] = useState(false);
  const [run, setRun] = useState<RunDepth | null>(null);
  // Stable identity: `FloodMap` keys its load effect on this, so an inline arrow here re-ran
  // the whole run + city-layer fetch on every render of the console.
  const setReplayPanelOpen = useUiStore((s) => s.setReplayPanelOpen);
  const setStoreRun = useRunStore((s) => s.setRun);
  const handleLoaded = useCallback(
    (loaded: RunDepth) => {
      setRun(loaded);
      // The chrome - mode banner, run stamp, verification chip - reads the run store, so a run
      // the map has loaded has to land there too or the top bar goes on saying "No runs yet"
      // over a console that is plainly showing one.
      const p = loaded.provenance;
      setStoreRun({
        run_id: p.runId,
        // The city the console is of, not a literal: a Chennai run in the store as "mumbai" is
        // how the top bar ends up naming the wrong city over the right water.
        city,
        cycle_ts: p.cycleTs ?? "",
        mode: p.mode === "live" ? "live" : "replay",
        replay_mode: p.mode === "live" ? "live" : "baked",
        ensemble_n: p.ensembleN,
        mass_balance_err: p.massBalanceErr,
        // Section 7.2's stamp reads "... · baked · 3.9 s". Without the timings the stamp had no
        // time to print, and its total rule (top-level stages only, ADR-0046) never ran.
        stage_ms: p.stageMs,
        bundle: p.bundle,
      });
      // The replay panel is open on an empty console because it holds the command that fixes
      // that (P0.12). Once a run has landed the map is the screen, so the panel gets out of its
      // way; the icon rail brings it back.
      setReplayPanelOpen(false);
    },
    [city, setReplayPanelOpen, setStoreRun],
  );
  // With no `?run=`, open on the cycle the demo script starts from (CLAUDE.md 15, 06:40) rather
  // than the newest run the API would pick, which on the replay is the calm one after the storm.
  // The map holds its load for the moment it takes to read the registry, so nobody watches 09:10
  // load and then swap. If the registry is slow or has no run at the opening, the API's default
  // stands - and that default is now per city too, so a city with nothing baked gets its own
  // empty state rather than another city's water.
  //
  // The lookup is stamped with the city it asked about, which is what lets "still looking" be
  // derived rather than tracked: a result for a different city is, by definition, stale.
  const [opening, setOpening] = useState<{ city: string; runId?: string } | null>(null);
  useEffect(() => {
    if (pinnedRun !== undefined || opening?.city === city) return;
    let cancelled = false;
    const controller = new AbortController();
    fetchOpeningRunId(city, DEFAULT_SIM_TIME, apiUrl, controller.signal).then((runId) => {
      if (!cancelled) setOpening({ city, runId });
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [city, pinnedRun, opening?.city]);

  // The URL wins over the lookup: `?run=` is the operator saying which cycle, and a stale answer
  // from a lookup that ran before they said it must not outrank them.
  const runParam = pinnedRun ?? (opening?.city === city ? opening.runId : undefined);
  const mapReady = pinnedRun !== undefined || opening?.city === city;
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  // The loaded set is stamped with the run it belongs to, which is what lets "loading" be
  // derived rather than tracked: a rail whose stamp does not match the map's run is, by
  // definition, still catching up. One state, no flag to fall out of step with it.
  const [loadedHotspots, setLoadedHotspots] = useState<{
    runId: string;
    set: HotspotSet | null;
  } | null>(null);
  const [surcharge, setSurcharge] = useState<{ runId: string; set: SurchargeSet | null } | null>(
    null,
  );
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  // Reachability bands live here rather than in the rail, because two things need them: the rail
  // draws the clocks and the map draws the polygons, and the rail is unmounted whenever the
  // hotspot drawer is open.
  const [isochrones, setIsochrones] = useState<Isochrone[]>([]);
  const [layers, setLayers] = useState<LayerToggles>({
    satellite: true,
    // Off by default: the depth ramp is what an operator reads first, and probability is the
    // question they ask second (CLAUDE.md 7.2 puts it behind a toggle, not in front of one).
    probability: false,
    raster: true,
    segments: true,
    surcharge: true,
    // Off by default (CLAUDE.md 6.7); it is also the largest layer VARUNA serves.
    drains: false,
    // Off when the imagery is on: the footprints are the *same buildings* the photograph already
    // shows, so drawing both puts a grey polygon over every roof and loses the texture that makes
    // the basemap worth having. The toggle brings them back for anyone who wants the derived GIS.
    buildings: false,
    hotspots: true,
  });
  // The exceedance the probability layer asks about. CLAUDE.md 7.2's four: the depth at which
  // each class of vehicle stops, so the question is always "who is stopped here?".
  const [probabilityThresholdCm, setProbabilityThresholdCm] = useState(30);

  // The event's sourced pins, dropping as the clock reaches each one (task P6.12, motion M18).
  // The only observations on this screen that VARUNA did not compute.
  // Keyed on the run's own bundle and its current step, so the ticker follows the scrub the
  // map is showing rather than a clock somewhere else on the page.
  // The street the operator last clicked (task P6.9). Cleared by clicking empty map, by Escape,
  // and by a new run - a popover about a segment of a run that is no longer on screen is a lie.
  const [pick, setPick] = useState<SegmentPick | null>(null);

  const truth = useTruthPins(run?.provenance.bundle ?? undefined, run?.validTs[step] ?? null);

  // The layer column scrolls, and nothing said so: over the aerial basemap the thin `--line`
  // scrollbar thumb is invisible, so at 1366 x 768 with probability and drains on the column read
  // as though it ended at the cut. Two affordances, neither of them motion: a scrollbar in
  // `--line-strong` on a `--well` track with its gutter reserved, and a 20 px fade applied as a
  // mask on whichever edge has something hidden - a mask makes the clipped row translucent rather
  // than laying anything over it, so no row is covered and no click is intercepted.
  // Destructured rather than kept as one object: the React compiler's lint infers that whatever
  // reaches a `ref` prop is a ref, and then reads of its siblings during render are ref reads.
  const { attach: attachColumn, above: columnAbove, below: columnBelow } = useScrollEdges();

  const toggleLayer = useCallback(
    (key: LayerKey, next: boolean) => setLayers((current) => ({ ...current, [key]: next })),
    [],
  );

  // The rail loads once the map has told us which run it settled on, so the two can never be
  // describing different cycles. `?run=` may be absent, in which case the API picks the newest
  // run and the map reports back which one that was.
  const loadedRunId = run?.provenance.runId;
  useEffect(() => {
    if (!loadedRunId) return;
    const controller = new AbortController();
    loadHotspots(loadedRunId, controller.signal)
      .then((set) => setLoadedHotspots({ runId: loadedRunId, set }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // A rail that cannot load is an empty rail, never a broken console: the map, the scrub
        // and the run stamp are all still telling the truth about this run.
        console.error("Hotspots failed to load", error);
        setLoadedHotspots({ runId: loadedRunId, set: null });
      });
    return () => controller.abort();
  }, [loadedRunId]);

  // Same shape for the surcharge product: stamped with its run, loaded once, scrubbed for free.
  useEffect(() => {
    if (!loadedRunId) return;
    const controller = new AbortController();
    loadSurcharge(loadedRunId, controller.signal)
      .then((set) => setSurcharge({ runId: loadedRunId, set }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("Surcharge failed to load", error);
        setSurcharge({ runId: loadedRunId, set: null });
      });
    return () => controller.abort();
  }, [loadedRunId]);

  // The drain map Pulse learned, fetched the first time the operator asks for the layer (task
  // P7.9). Never on mount: `drain_health.geojson` is 2.3 MB a run and section 6.7 has the layer
  // off by default. Stamped with its run, like the rail and the surcharge set, so switching cycle
  // re-asks rather than colouring the new run's pipes with the old run's posterior.
  //
  // Without this the layer drew the whole inferred network at the *prior* the city pipeline gave
  // it - pipes, but not the learning. The posterior is what "Drains (health)" means.
  const [drainHealth, setDrainHealth] = useState<{ runId: string; set: DrainHealth | null } | null>(
    null,
  );
  useEffect(() => {
    if (!layers.drains || !loadedRunId || drainHealth?.runId === loadedRunId) return;
    const controller = new AbortController();
    loadDrainHealth(loadedRunId, controller.signal, LEARNED_EDGE_LIMIT)
      .then((set) => setDrainHealth({ runId: loadedRunId, set }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // A run without a learned map still has pipes to draw, at their prior; the panel says so.
        console.error("Drain health failed to load", error);
        setDrainHealth({ runId: loadedRunId, set: null });
      });
    return () => controller.abort();
  }, [layers.drains, loadedRunId, drainHealth?.runId]);

  // Derived, not tracked: a posterior stamped with a different run than the map's is, by
  // definition, still in flight (the same rule the hotspot rail uses).
  const learned = drainHealth && drainHealth.runId === loadedRunId ? drainHealth.set : null;
  const learnedDrains = useMemo(
    () =>
      (learned?.edges ?? []).map((edge) => ({
        id: edge.id,
        path: edge.path,
        beta: edge.betaMean,
        diameter: edge.diameterM,
      })),
    [learned],
  );
  const drainsPending = layers.drains && Boolean(loadedRunId) && drainHealth?.runId !== loadedRunId;

  const current = loadedHotspots?.runId === loadedRunId ? loadedHotspots : null;
  const hotspots = current?.set ?? null;
  const hotspotsLoading = Boolean(loadedRunId) && current === null;
  const selected = hotspots?.hotspots.find((h) => h.id === selectedHotspotId) ?? null;

  // Selecting a hotspot flies the map to it and rings it (motion M10). The key carries the click
  // count so choosing the same row after panning away flies back rather than doing nothing.
  // Switching cycle resets the scrub: step 12 of the 06:40 forecast is not step 12 of the 08:40
  // one, and carrying the index across would silently change what the readout means.
  const pickCycle = useCallback(
    (runId: string) => {
      setSelectedHotspotId(null);
      setStep(0);
      setPlaying(false);
      // Through the router, not `window.history`: the run the map loads is now derived from
      // `useSearchParams`, so the address bar is the single place a cycle is chosen and the back
      // button means what it says.
      const next = new URLSearchParams(search);
      next.set("run", runId);
      router.replace(`/console?${next.toString()}`, { scroll: false });
    },
    [router, search],
  );

  const selectHotspot = useCallback((hotspot: Hotspot) => {
    setSelectedHotspotId(hotspot.id);
    setFocus({ lon: hotspot.lon, lat: hotspot.lat, key: `${hotspot.id}-${Date.now()}`, zoom: 14 });
  }, []);

  // Play advances the same `step` the slider and the keyboard write, so there is one clock and
  // no way for the readout to disagree with the map.
  useEffect(() => {
    if (!playing || !run) return;
    const id = window.setInterval(() => {
      setStep((current) => {
        if (current >= run.provenance.nSteps - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, run]);

  // Space plays, the arrows scrub (CLAUDE.md 6.10). Ignored while the operator is typing.
  useEffect(() => {
    if (!run) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === " ") {
        event.preventDefault();
        setPlaying((p) => !p);
      } else if (event.key === "ArrowLeft") {
        setPlaying(false);
        setStep((s) => Math.max(0, s - 1));
      } else if (event.key === "ArrowRight") {
        setPlaying(false);
        setStep((s) => Math.min(run.provenance.nSteps - 1, s + 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);

  // CLAUDE.md 7.2's layer shortcuts, registered rather than handled locally. The registry in
  // lib/shortcuts.ts exists so the `?` overlay can ask which keys actually do something: it
  // was built and never used, so the overlay listed ten layer shortcuts while the console
  // handled six, and R, I, 3 and W were dead keys advertised as working. Registering here
  // makes the overlay's answer true by construction, and section 17's "never a dead control"
  // applies to a key the same way it applies to a button.
  useEffect(() => {
    if (!run) return;
    const toggles: Partial<Record<ShortcutLayerKey, LayerKey>> = {
      p: "probability",
      d: "drains",
      s: "surcharge",
      g: "hotspots",
    };
    const unsubscribes = Object.entries(toggles).map(([key, layer]) =>
      registerLayerShortcut(key as ShortcutLayerKey, () =>
        setLayers((current) => ({ ...current, [layer]: !current[layer] })),
      ),
    );
    return () => unsubscribes.forEach((off) => off());
  }, [run]);

  return (
    <AppShell
      rightRail={
        // The drawer slides in *over* the rail (CLAUDE.md 7.2), so it takes the same slot.
        selected ? (
          <HotspotDrawer
            hotspot={selected}
            step={step}
            stepMin={run?.provenance.stepMin ?? 5}
            validTs={run?.validTs ?? []}
            onClose={() => setSelectedHotspotId(null)}
          />
        ) : (
          <RightRail
            hotspots={hotspots}
            runId={run?.provenance.runId ?? null}
            truthPins={truth.passed}
            step={step}
            selectedHotspotId={selectedHotspotId}
            onSelectHotspot={selectHotspot}
            hotspotsLoading={hotspotsLoading}
            simTime={run?.validTs[step] ?? null}
            onIsochrones={setIsochrones}
          />
        )
      }
      bottomBar={<TimeBar />}
    >
      <div className="relative h-full min-h-0 w-full">
        {/* The map is the one memorable element on this screen (CLAUDE.md 6.1); everything else
            floats over it. `MapSlot` stays behind it as the legend and attribution host. */}
        <MapSlot legendClearsRightPanel={replayPanelOpen} />
        <FloodMap
          // Passed rather than left to the map's own `currentCity()`: that reads `window` during
          // render, which is the same staleness the run parameter had.
          city={city}
          runId={runParam}
          deferLoad={!mapReady}
          step={step}
          onLoaded={handleLoaded}
          hotspots={hotspots?.hotspots ?? []}
          selectedHotspotId={selectedHotspotId}
          surcharge={surcharge?.runId === loadedRunId ? surcharge?.set : null}
          focus={focus}
          isochrones={isochrones}
          showRaster={layers.raster}
          showSegments={layers.segments}
          showSurcharge={layers.surcharge}
          showDrains={layers.drains}
          drains={learnedDrains}
          showBuildings={layers.buildings}
          showHotspots={layers.hotspots}
          showSatellite={layers.satellite}
          probabilityThresholdCm={layers.probability ? probabilityThresholdCm : undefined}
          truthPins={layers.hotspots ? truth.dropping : undefined}
          onSegmentPick={setPick}
          attribution={false}
        />

        {/* The scrub. Owned here so the map, the readout and the keyboard share one step. */}
        {run ? (
          <div className="pointer-events-auto absolute bottom-4 left-1/2 z-30 w-[min(680px,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-[var(--line)] bg-[var(--ink)]/80 p-3 backdrop-blur-[12px]">
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPlaying((p) => !p)}
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? "Pause" : "Play"}
              </Button>
              <input
                type="range"
                min={0}
                max={Math.max(run.provenance.nSteps - 1, 0)}
                value={step}
                onChange={(event) => {
                  setPlaying(false);
                  setStep(Number(event.target.value));
                }}
                className="h-1 flex-1 cursor-pointer accent-[var(--tide)]"
                aria-label="Scrub the forecast"
              />
              <span className="num min-w-[132px] text-right text-[13px] text-[var(--text)]">
                {formatStep(run.validTs[step])} · +{step * run.provenance.stepMin} min
              </span>
            </div>
            <p className="num mt-2 text-[12px] text-[var(--text-3)]">
              run {run.provenance.runId} · {run.provenance.mode} ·{" "}
              {run.provenance.ensembleN === 1
                ? "1 member (deterministic)"
                : `${run.provenance.ensembleN} members`}
              {run.provenance.massBalanceErr != null
                ? ` · mass balance ${(run.provenance.massBalanceErr * 100).toFixed(3)} %`
                : ""}
            </p>
          </div>
        ) : null}

        {/* Capped well above the canvas floor: at 1366 x 768 the depth legend reaches inboard to
            clear the replay panel, and the legend is always visible (CLAUDE.md section 6.7), so the
            column stops short of it and scrolls instead.

            The column itself scrolls (UI_SPEC 8, task D-17). It used to be a plain flex column
            with a `max-h`, which at 1366 x 768 simply clipped: the panel needs about 324 px, the
            rows below the fold were unreachable, and turning the wheel over them did nothing
            because there was no scroll container to turn. `min-h-0` lets the flex column shrink
            to its cap and `overflow-y-auto` gives the wheel something to move; `overscroll-contain`
            stops the scroll chaining out of the column when it reaches the end, which is what
            would hand the gesture to the map behind it. */}
        <div
          data-testid="console-map-column"
          ref={attachColumn}
          data-scroll-above={columnAbove ? "yes" : "no"}
          data-scroll-below={columnBelow ? "yes" : "no"}
          style={edgeFadeStyle({ above: columnAbove, below: columnBelow })}
          className="absolute top-4 left-4 z-20 flex max-h-[calc(100%-12rem)] min-h-0 w-[380px] max-w-[calc(100%-2rem)] [scrollbar-color:var(--line-strong)_var(--well)] [scrollbar-gutter:stable] flex-col items-start gap-2 overflow-x-hidden overflow-y-auto overscroll-contain"
        >
          {/* The chips are 414 px of clock times in a 380 px column, so they wrap to a second row
              rather than spilling over the map (UI_SPEC 8). */}
          {/* Only on the default city. `CyclePicker` reads `/v1/runs` with no city, which answers
              with Mumbai's cycles whoever asks - so on `?city=chennai` every chip was a Mumbai run
              waiting to be pinned to a Chennai map. Better no picker than a wrong one
              (CLAUDE.md 17); the chips come back for every city once the component takes one. */}
          {city === DEFAULT_CITY ? (
            <CyclePicker
              currentRunId={run?.provenance.runId}
              onPick={pickCycle}
              className="w-full flex-wrap"
            />
          ) : null}
          {pick && run ? (
            <SegmentPopover
              pick={pick}
              step={step}
              validTs={run.validTs}
              onClose={() => setPick(null)}
            />
          ) : null}
          <LayerPanel
            value={layers}
            onChange={toggleLayer}
            counts={{
              surcharge: surcharge?.set?.nodes.length,
              hotspots: hotspots?.hotspots.length,
            }}
            details={{
              surcharge: surcharge?.set ? reversedFlowSummary(surcharge.set) : undefined,
            }}
          />
          {/* Below the panel, never over it (UI_SPEC 8): the legend used to be positioned
              absolutely at a fixed offset from the map's top-left, which put it on top of the
              layer rows as soon as probability mode was on. */}
          {layers.probability ? (
            <ProbabilityLegend
              thresholdCm={probabilityThresholdCm}
              onThresholdChange={setProbabilityThresholdCm}
              deterministic={(run?.provenance.ensembleN ?? 1) <= 1}
            />
          ) : null}
          {/* What the Drains layer is actually showing. An honesty label, not fine print
              (CLAUDE.md 6.8): most of this graph has never been observed, and the operator has to
              be able to tell the pipes the filter moved from the pipes it never saw. */}
          {layers.drains ? (
            <div className="rounded-panel border-line w-[248px] border bg-[var(--ink)]/85 p-3 backdrop-blur-[12px]">
              {drainsPending ? (
                <>
                  <p className="type-small text-text-2">Loading the drain map Pulse learned.</p>
                  <Skeleton className="mt-2" lines={2} />
                </>
              ) : learned ? (
                // Three numbers, all from the run's own product, and the last clause is load
                // bearing: the cycle writes the worst 6,000 pipes, so a pipe the filter moved
                // that ranks below them is on the map at its prior. Saying "275 pipes moved" and
                // stopping there would claim a re-colouring the map does not draw.
                <p className="type-small text-text-2">
                  Inferred graph. Pulse moved{" "}
                  <span className="num">{learned.nUpdated.toLocaleString("en-IN")}</span> of{" "}
                  <span className="num">{learned.nEdges.toLocaleString("en-IN")}</span> pipes; the{" "}
                  <span className="num">{learned.edges.length.toLocaleString("en-IN")}</span> worst
                  are drawn at their posterior and the rest at the pipeline&apos;s prior.
                </p>
              ) : (
                <p className="type-small text-text-2">
                  This run has no learned drain map, so every pipe is drawn at the pipeline&apos;s
                  prior. Bake a cycle with Pulse to give them a posterior.
                </p>
              )}
            </div>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setSkyPanelOpen((open) => !open)}>
            {skyPanelOpen ? "Hide the rain nowcast" : "Show the rain nowcast"}
          </Button>
          {skyPanelOpen ? (
            <div className="min-h-0 w-full overflow-y-auto">
              <PanelErrorBoundary title="Rain nowcast">
                <SkyPanel />
              </PanelErrorBoundary>
            </div>
          ) : null}
        </div>

        {replayPanelOpen ? (
          <div className="absolute top-4 right-4 z-20 max-h-[calc(100%-2rem)] w-[360px] max-w-[calc(100%-2rem)] overflow-y-auto">
            <ReplayPanel />
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
