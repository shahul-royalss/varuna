"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { BookmarkPlus, Trash2, Umbrella } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/varuna/bottom-sheet";
import { EmptyState } from "@/components/varuna/empty-state";
import { LanguageToggle } from "@/components/varuna/language-toggle";
import { Skeleton } from "@/components/varuna/skeleton";
import { FloodMap, type FloodMapStatusKind } from "@/components/map/flood-map";
import type { RunDepth } from "@/lib/api/run-depth";
import { apiUrl } from "@/lib/api/client";
import { PublicLegend } from "@/components/varuna/public-legend";
import { VehicleSelector, type PublicProfile } from "@/components/varuna/vehicle-selector";
import { Wordmark } from "@/components/varuna/wordmark";
import { useIsClient } from "@/lib/hooks";
import { currentCity } from "@/lib/city";
import { useOpeningRun } from "@/lib/use-opening-run";
import { formatIst } from "@/lib/format";

const REPORT_ROUTE = "/report" as Route;
const SAVED_KEY = "varuna.map.saved-locations";

/** Depth at which each vehicle stops, in cm. The same numbers `varuna_route.profiles` routes on
 * and the console's depth ramp colours by, so the public map and the operator's map cannot
 * disagree about who is stopped. */
const STOPS_AT_CM: Record<PublicProfile, number> = {
  "two-wheeler": 15,
  car: 30,
  bus: 45,
  pedestrian: 30,
};

/** Streets listed in the sheet. More than this and nobody scrolls to the bottom on a phone. */
const NEARBY_LIMIT = 12;

/** What OSM calls a road with no `name` tag. 52.6 % of Mumbai's segments have none, and the
 * segment layer's `ward` is empty for every one of them, so there is nothing truer to print. */
export const UNNAMED_ROAD = "Unnamed road";

interface SavedLocation {
  id: string;
  name: string;
}

export interface NearbyStreet {
  id: string;
  /** The OSM name, `UNNAMED_ROAD` when OSM has none, or null while the names are still loading. */
  name: string | null;
  peakCm: number;
  /** Last step still passable for this vehicle, as IST; null when it is impassable already. */
  passableUntil: string | null;
}

/**
 * The streets a run wets worst for one vehicle, with the last time each is still passable.
 *
 * `names` is null while the city's segment layer is loading: a row then carries no name rather
 * than "Unnamed road", which would be a claim about OSM made before OSM was read.
 */
export function nearbyStreets(
  run: Pick<RunDepth, "depthCm" | "validTs">,
  stopsAtCm: number,
  names: ReadonlyMap<string, string> | null,
  limit = NEARBY_LIMIT,
): NearbyStreet[] {
  const rows: NearbyStreet[] = [];
  for (const [id, series] of run.depthCm) {
    const peak = series.length ? Math.max(...series) : 0;
    // Only streets this vehicle would have to think about: half its stopping depth or more.
    if (peak < stopsAtCm * 0.5) continue;
    const firstOver = series.findIndex((cm) => cm >= stopsAtCm);
    rows.push({
      id,
      name: names === null ? null : (names.get(id) ?? UNNAMED_ROAD),
      peakCm: peak,
      passableUntil:
        firstOver < 0
          ? formatIst(run.validTs[run.validTs.length - 1] ?? "")
          : firstOver === 0
            ? null
            : formatIst(run.validTs[firstOver - 1] ?? run.validTs[0] ?? ""),
    });
  }
  rows.sort((a, b) => b.peakCm - a.peakCm);
  return rows.slice(0, limit);
}

/** Why the map has no run to draw: nothing baked yet, or the load failed. */
export type ForecastProblem = "empty" | "error" | null;

/** The honesty line (CLAUDE.md 7.11), timed from the run the map is actually drawing. */
export function honestyLine(
  cycleTs: string | null | undefined,
  problem: ForecastProblem = null,
): string {
  if (cycleTs) {
    return `Forecast from the last VARUNA run at ${formatIst(cycleTs)}; updates every 5 minutes`;
  }
  if (problem === "empty") return "No VARUNA run yet; the map fills after the first run";
  if (problem === "error") return "The forecast did not load; check the connection and reload";
  return "Loading the forecast from the last VARUNA run";
}

/** Saved locations live in this browser only; there is no account behind the public map. */
function readSaved(): SavedLocation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SavedLocation =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as SavedLocation).id === "string" &&
        typeof (item as SavedLocation).name === "string",
    );
  } catch {
    return [];
  }
}

/** The public map (CLAUDE.md section 7.11): mobile-first, three colours, one honest line. */
export function MapScreen() {
  const [profile, setProfile] = useState<PublicProfile>("car");
  /* Read once at mount; on the server the list is empty and the section stays hidden until
   * `useIsClient` flips, so the first client render still matches the server's markup. */
  const [saved, setSaved] = useState<SavedLocation[]>(readSaved);
  const [sheetHeight, setSheetHeight] = useState(600);
  const stageRef = useRef<HTMLDivElement>(null);
  const isClient = useIsClient();

  // The public map does not scrub: a commuter wants now, and "now" is the run's first step. The
  // "passable until" times below are what carries the forecast instead, which is the form the
  // question actually takes on a phone ("can I still get home?").
  const step = 0;
  // Which city this map is of; only read by the fetches below, never rendered, so the server's
  // Mumbai and a client's `?city=` cannot disagree on screen.
  const city = currentCity();
  // Open on the 06:40 storm cycle, the same rule `/console` follows (task D-20). Without it the
  // API hands back the newest run, which on the replay is 09:10 - the calm cycle after the storm,
  // where a map about which streets are passable has nothing to say. The map holds its load until
  // the registry has answered, so nobody watches the calm cycle load and then swap.
  const opening = useOpeningRun(city);
  // The run the map drew. The public map has no app shell and so no run store behind it: the
  // honesty line and the save button read this run, not a registry row the map never loaded.
  const [run, setRun] = useState<RunDepth | null>(null);
  const [names, setNames] = useState<Map<string, string> | null>(null);
  const [namesFailed, setNamesFailed] = useState(false);
  const onLoaded = useCallback((loaded: RunDepth) => setRun(loaded), []);
  const [problem, setProblem] = useState<ForecastProblem>(null);
  const onStatus = useCallback((kind: FloodMapStatusKind) => {
    setProblem(kind === "empty" || kind === "error" ? kind : null);
  }, []);

  // Street names, from the city's own segment layer. The run carries depths per `segment_id` and
  // nothing else; a list of ids would be useless to a commuter.
  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl(`/v1/city/${city}/layers/segments`), { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((geojson: { features?: { properties?: Record<string, unknown> }[] }) => {
        const map = new Map<string, string>();
        for (const feature of geojson.features ?? []) {
          const props = feature.properties ?? {};
          const id = String(props.segment_id ?? "");
          const name = props.name;
          if (id && typeof name === "string" && name) map.set(id, name);
        }
        setNames(map);
      })
      .catch(() => {
        if (!controller.signal.aborted) setNamesFailed(true);
      });
    return () => controller.abort();
  }, [city]);

  const nearby = useMemo(
    () => (run ? nearbyStreets(run, STOPS_AT_CM[profile], names) : []),
    [run, profile, names],
  );

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const update = () => setSheetHeight(node.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const persist = useCallback((next: SavedLocation[]) => {
    setSaved(next);
    try {
      window.localStorage.setItem(SAVED_KEY, JSON.stringify(next));
    } catch {
      // A private window can refuse storage; the map still works without saved locations.
    }
  }, []);

  const saveCurrent = useCallback(() => {
    if (!run) return;
    const entry: SavedLocation = {
      id: `loc-${Date.now()}`,
      name: `Saved at ${formatIst(new Date().toISOString())}`,
    };
    persist([entry, ...saved].slice(0, 8));
  }, [run, persist, saved]);

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-line bg-deep shrink-0 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <Wordmark size="sm" withMark />
          <LanguageToggle />
        </div>
        <p className="num type-micro text-text-3 mt-2" data-slot="honesty-line">
          {honestyLine(run?.provenance.cycleTs, problem)}
        </p>
        <div className="mt-3">
          <VehicleSelector value={profile} onValueChange={setProfile} />
        </div>
        <PublicLegend profile={profile} className="mt-3" />
      </header>

      <div ref={stageRef} className="relative min-h-0 flex-1">
        {/* The same map the console draws, recoloured for a commuter: three states rather than
            six depth bands, against this vehicle's own stopping depth. */}
        <FloodMap
          step={step}
          city={city}
          runId={opening.runId}
          deferLoad={!opening.resolved}
          onLoaded={onLoaded}
          onStatus={onStatus}
          passableBelowCm={STOPS_AT_CM[profile]}
          showRaster={false}
          showBuildings={false}
          showSurcharge={false}
          showHotspots
        />

        <Button
          size="lg"
          // Under the sheet (z-20), so an opened sheet is not read through a button over its rows.
          className="absolute right-4 z-10 h-11"
          style={{ bottom: 112 }}
          render={<Link href={REPORT_ROUTE} />}
          nativeButton={false}
        >
          <Umbrella aria-hidden="true" />
          Report water
        </Button>

        <BottomSheet containerHeight={sheetHeight} title="Streets to avoid">
          <div className="flex flex-col gap-5">
            {/* The floating button sits under an opened sheet, so the sheet carries its own. */}
            <Button
              size="lg"
              variant="outline"
              className="h-11 self-start"
              render={<Link href={REPORT_ROUTE} />}
              nativeButton={false}
            >
              <Umbrella aria-hidden="true" />
              Report water
            </Button>
            {nearby.length === 0 ? (
              <EmptyState
                size="sm"
                title="No streets scored yet"
                description="The public map fills after the first run."
              />
            ) : (
              <ul className="divide-line rounded-panel border-line divide-y border">
                {nearby.map((street) => (
                  <li key={street.id} className="flex items-center justify-between gap-3 px-3 py-3">
                    <span className="min-w-0 flex-1">
                      {street.name !== null ? (
                        <span className="type-small text-text block truncate">{street.name}</span>
                      ) : namesFailed ? (
                        <span className="type-small text-text-2 block truncate">
                          Street name unavailable
                        </span>
                      ) : (
                        <Skeleton className="my-0.5 h-3.5 w-3/4" />
                      )}
                      <span className="num type-micro text-text-2 block">
                        {street.passableUntil
                          ? `Passable until ${street.passableUntil}`
                          : "Impassable now"}
                      </span>
                    </span>
                    <span className="num type-small text-text-2 shrink-0">
                      {street.peakCm.toFixed(0)} cm
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <section aria-labelledby="saved-locations" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 id="saved-locations" className="type-small text-text font-medium">
                  Saved locations
                </h2>
                {/* 44 px, the public map's touch target floor (CLAUDE.md 6.5, 7.11). */}
                <Button
                  variant="outline"
                  className="h-11 px-3"
                  onClick={saveCurrent}
                  disabled={!run}
                  title={run ? undefined : "Available once a run has scored the streets around you"}
                >
                  <BookmarkPlus aria-hidden="true" />
                  Save this location
                </Button>
              </div>
              {!isClient || saved.length === 0 ? (
                <p className="type-micro text-text-3">
                  {run
                    ? "Save a location to get its passable-until time first."
                    : "Available once a run has scored the streets around you."}
                </p>
              ) : (
                <ul className="divide-line rounded-panel border-line divide-y border">
                  {saved.map((location) => (
                    <li
                      key={location.id}
                      className="flex items-center justify-between gap-2 px-3 py-1"
                    >
                      <span className="type-small text-text min-w-0 truncate">{location.name}</span>
                      <Button
                        variant="ghost"
                        className="size-11"
                        aria-label={`Remove ${location.name}`}
                        onClick={() => persist(saved.filter((item) => item.id !== location.id))}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </BottomSheet>
      </div>
    </main>
  );
}
