"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { FloodMap } from "@/components/map/flood-map";
import type { Isochrone } from "@/components/map/city-map";
import type { RunDepth } from "@/lib/api/run-depth";
import { loadHotspots, type Hotspot, type HotspotSet } from "@/lib/api/hotspots";
import type { MapFocus } from "@/components/map/city-map";
import { loadSurcharge, type SurchargeSet } from "@/lib/api/surcharge";
import { AppShell } from "@/components/varuna/app-shell";
import { MapSlot } from "@/components/varuna/map-slot";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import { ReplayPanel } from "@/components/varuna/replay-panel";
import { HotspotDrawer } from "@/components/varuna/hotspot-drawer";
import { CyclePicker } from "@/components/varuna/cycle-picker";
import { LayerPanel, type LayerToggles, type LayerKey } from "@/components/varuna/layer-panel";
import { RightRail } from "@/components/varuna/right-rail";
import { SkyPanel } from "@/components/varuna/sky-panel";
import { TimeBar } from "@/components/varuna/time-bar";
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

export function ConsoleScreen() {
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
        city: "mumbai",
        cycle_ts: p.cycleTs ?? "",
        mode: p.mode === "live" ? "live" : "replay",
        replay_mode: p.mode === "live" ? "live" : "baked",
        ensemble_n: p.ensembleN,
        mass_balance_err: p.massBalanceErr,
        bundle: p.bundle,
      });
      // The replay panel is open on an empty console because it holds the command that fixes
      // that (P0.12). Once a run has landed the map is the screen, so the panel gets out of its
      // way; the icon rail brings it back.
      setReplayPanelOpen(false);
    },
    [setReplayPanelOpen, setStoreRun],
  );
  // `?run=<id>` pins the console to one baked run. The demo script (CLAUDE.md 15) opens the
  // console on a specific cycle, and without this the map always shows the newest run - which,
  // once the storm has passed, is the calm one.
  //
  // Read lazily in the initialiser rather than in an effect: it is a value the first render can
  // already know, and setting state from an effect body would cascade a second render for
  // something that never changes afterwards. `window` is guarded because this component is
  // pre-rendered on the server.
  const [runParam, setRunParam] = useState<string | undefined>(() =>
    typeof window === "undefined"
      ? undefined
      : (new URLSearchParams(window.location.search).get("run") ?? undefined),
  );
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

  const current = loadedHotspots?.runId === loadedRunId ? loadedHotspots : null;
  const hotspots = current?.set ?? null;
  const hotspotsLoading = Boolean(loadedRunId) && current === null;
  const selected = hotspots?.hotspots.find((h) => h.id === selectedHotspotId) ?? null;

  // Selecting a hotspot flies the map to it and rings it (motion M10). The key carries the click
  // count so choosing the same row after panning away flies back rather than doing nothing.
  // Switching cycle resets the scrub: step 12 of the 06:40 forecast is not step 12 of the 08:40
  // one, and carrying the index across would silently change what the readout means.
  const pickCycle = useCallback((runId: string) => {
    setRunParam(runId);
    setSelectedHotspotId(null);
    setStep(0);
    setPlaying(false);
    const url = new URL(window.location.href);
    url.searchParams.set("run", runId);
    window.history.replaceState(null, "", url);
  }, []);

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
      } else if (/^[dsgbv]$/i.test(event.key)) {
        // CLAUDE.md 7.2's layer shortcuts. The map is the screen, so these are the fastest way
        // to change what it shows without reaching for the panel. V is the satellite basemap -
        // S is already surcharge, and V for "view" is the nearest free key.
        const key = {
          d: "drains",
          s: "surcharge",
          g: "hotspots",
          b: "buildings",
          v: "satellite",
        }[event.key.toLowerCase()] as LayerKey;
        setLayers((current) => ({ ...current, [key]: !current[key] }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
          runId={runParam}
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
          showBuildings={layers.buildings}
          showHotspots={layers.hotspots}
          showSatellite={layers.satellite}
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
            rain panel stops short of it and scrolls instead. */}
        <div className="absolute top-4 left-4 z-20 flex max-h-[calc(100%-12rem)] w-[380px] max-w-[calc(100%-2rem)] flex-col items-start gap-2">
          <CyclePicker currentRunId={run?.provenance.runId} onPick={pickCycle} />
          <LayerPanel
            value={layers}
            onChange={toggleLayer}
            counts={{
              surcharge: surcharge?.set?.nodes.length,
              hotspots: hotspots?.hotspots.length,
            }}
          />
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
