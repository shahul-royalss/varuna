"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { BookmarkPlus, Trash2, Umbrella } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/varuna/bottom-sheet";
import { EmptyState } from "@/components/varuna/empty-state";
import { LanguageToggle } from "@/components/varuna/language-toggle";
import { FloodMap } from "@/components/map/flood-map";
import type { RunDepth } from "@/lib/api/run-depth";
import { apiUrl } from "@/lib/api/client";
import { PublicLegend } from "@/components/varuna/public-legend";
import { VehicleSelector, type PublicProfile } from "@/components/varuna/vehicle-selector";
import { Wordmark } from "@/components/varuna/wordmark";
import { useIsClient } from "@/lib/hooks";
import { formatIst } from "@/lib/format";
import { useRunStore } from "@/lib/stores/run";

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

interface SavedLocation {
  id: string;
  name: string;
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

  const currentRun = useRunStore((state) => state.currentRun);
  const runTime = currentRun ? formatIst(currentRun.cycle_ts) : null;

  // The public map does not scrub: a commuter wants now, and "now" is the run's first step. The
  // "passable until" times below are what carries the forecast instead, which is the form the
  // question actually takes on a phone ("can I still get home?").
  const step = 0;
  const [run, setRun] = useState<RunDepth | null>(null);
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  const onLoaded = useCallback((loaded: RunDepth) => setRun(loaded), []);

  // Street names, from the city's own segment layer. The run carries depths per `segment_id` and
  // nothing else; a list of ids would be useless to a commuter.
  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl("/v1/city/mumbai/layers/segments"), { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { features: [] }))
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
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  /** The streets this run wets worst, with the last time each is still passable for the vehicle. */
  const nearby = useMemo(() => {
    if (!run) return [];
    const stops = STOPS_AT_CM[profile];
    const rows: {
      id: string;
      name: string;
      peakCm: number;
      passableUntil: string | null;
    }[] = [];
    for (const [id, series] of run.depthCm) {
      const peak = series.length ? Math.max(...series) : 0;
      // Only streets this vehicle would have to think about: half its stopping depth or more.
      if (peak < stops * 0.5) continue;
      const firstOver = series.findIndex((cm) => cm >= stops);
      rows.push({
        id,
        name: names.get(id) ?? "Unnamed road",
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
    return rows.slice(0, NEARBY_LIMIT);
  }, [run, profile, names]);

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
    if (!currentRun) return;
    const entry: SavedLocation = {
      id: `loc-${Date.now()}`,
      name: `Saved at ${formatIst(new Date().toISOString())}`,
    };
    persist([entry, ...saved].slice(0, 8));
  }, [currentRun, persist, saved]);

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line bg-deep px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <Wordmark size="sm" withMark />
          <LanguageToggle />
        </div>
        <p className="mt-2 type-micro text-text-3">
          Forecast from the last VARUNA run - updates every 5 minutes
          {runTime ? <span className="num"> - run at {runTime} IST</span> : null}
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
          onLoaded={onLoaded}
          passableBelowCm={STOPS_AT_CM[profile]}
          showRaster={false}
          showBuildings={false}
          showSurcharge={false}
          showHotspots
        />

        <Button
          size="lg"
          className="absolute right-4 z-30 h-11"
          style={{ bottom: 112 }}
          render={<Link href={REPORT_ROUTE} />}
          nativeButton={false}
        >
          <Umbrella aria-hidden="true" />
          Report water
        </Button>

        <BottomSheet containerHeight={sheetHeight} title="Streets to avoid">
          <div className="flex flex-col gap-5">
            {nearby.length === 0 ? (
              <EmptyState
                size="sm"
                title="No streets scored yet"
                description="The public map fills after the first run."
              />
            ) : (
              <ul className="divide-y divide-line rounded-panel border border-line">
                {nearby.map((street) => (
                  <li key={street.id} className="flex items-center justify-between gap-3 px-3 py-3">
                    <span className="min-w-0">
                      <span className="block truncate type-small text-text">{street.name}</span>
                      <span className="num block type-micro text-text-2">
                        {street.passableUntil
                          ? `Passable until ${street.passableUntil}`
                          : "Impassable now"}
                      </span>
                    </span>
                    <span className="num shrink-0 type-small text-text-2">
                      {street.peakCm.toFixed(0)} cm
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <section aria-labelledby="saved-locations" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 id="saved-locations" className="type-small font-medium text-text">
                  Saved locations
                </h2>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={saveCurrent}
                  disabled={!currentRun}
                  title={
                    currentRun ? undefined : "Available once a run has scored the streets around you"
                  }
                >
                  <BookmarkPlus aria-hidden="true" />
                  Save this location
                </Button>
              </div>
              {!isClient || saved.length === 0 ? (
                <p className="type-micro text-text-3">
                  {currentRun
                    ? "Save a location to get its passable-until time first."
                    : "Available once a run has scored the streets around you."}
                </p>
              ) : (
                <ul className="divide-y divide-line rounded-panel border border-line">
                  {saved.map((location) => (
                    <li key={location.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0 truncate type-small text-text">{location.name}</span>
                      <Button
                        size="icon-sm"
                        variant="ghost"
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
