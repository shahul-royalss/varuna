"use client";

/**
 * The citizen dashboard (`UI_SPEC` 3, task D-11).
 *
 * The console answers "what is the city doing?". This screen answers the two questions a person
 * standing in the rain actually has: *which streets near me are passable*, and *what is the safe
 * way to where I am going*. Everything on it is one of those two answers or the provenance of one.
 *
 * Three rules shape the layout.
 *
 * 1. **The map owns its box.** The pane is `relative` and the map is `absolute inset-0`, so it
 *    fills whatever it is given at 390 x 844, at 1440 x 900 and on a wall - no `vh` band, no fixed
 *    pixel height, and `fitBounds` frames the AOI on first paint.
 * 2. **One rail, two shapes.** At 1024 px and up it is a column beside the map; below that it is
 *    the existing `BottomSheet` (motion M24) over it, which is the shape a thumb can reach.
 * 3. **No number floats free.** The header carries the run and its time, and the three honesty
 *    chips name what each kind of number is, so a depth, a minute and a temperature on this screen
 *    can each be traced to what produced it (CLAUDE.md rules 6 and 7).
 */

import Link from "next/link";
import type { Route } from "next";
import { LocateFixed, Umbrella } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CitizenMap, STOPS_AT_CM, type MapPoint } from "@/components/citizen/citizen-map";
import { DashboardIntro } from "@/components/citizen/dashboard-intro";
import { RouteAnswer } from "@/components/citizen/route-answer";
import { WeatherChip } from "@/components/citizen/weather-chip";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/varuna/bottom-sheet";
import { EmptyState } from "@/components/varuna/empty-state";
import { PublicLegend } from "@/components/varuna/public-legend";
import { Skeleton } from "@/components/varuna/skeleton";
import { VehicleSelector, type PublicProfile } from "@/components/varuna/vehicle-selector";
import { Wordmark } from "@/components/varuna/wordmark";
import { loadPlaces, planRoute, type Place, type RoutePlan } from "@/lib/api/route";
import { formatDate, formatIst, shortenRunId } from "@/lib/format";
import { useMediaQuery } from "@/lib/hooks";
import type { CitizenRun } from "@/lib/maps/citizen-run";
import { cn } from "@/lib/utils";

const REPORT_ROUTE = "/report" as Route;

/** One trip keeps one corridor across reloads, so a reader is not re-spread on every request. */
const TRIP_ID_KEY = "varuna.dashboard.trip-id";

/** How far "near you" reaches. Beyond this a street is not on the way out of the door. */
export const NEARBY_RADIUS_M = 1_500;

/** Rows in the list. More than this on a phone and nobody reaches the bottom. */
const NEARBY_LIMIT = 8;

/** What OSM calls a road with no `name` tag; 52.6 % of Mumbai's segments have none. */
export const UNNAMED_ROAD = "Unnamed road";

/**
 * The tolerance a citizen route is planned at.
 *
 * `services/products` defaults every non-rescue profile to 0.5: a street is refused once it is
 * more likely than not to be over the vehicle's depth. An ambulance's 0.2 is an operator's choice
 * and is not this screen's to make.
 */
const CITIZEN_RISK_TOLERANCE = 0.5;

/** UI_SPEC 3's split: a rail beside the map at 1024 px and up, the bottom sheet below it. */
const RAIL_BREAKPOINT = "(min-width: 1024px)";

/** Metres per degree of latitude; longitude is scaled by the cosine at the reader's latitude. */
const METRES_PER_DEGREE = 111_320;

/** Straight-line distance in metres, flat-earth over a 1.5 km radius, which is exact enough. */
export function distanceM(from: MapPoint, to: readonly [number, number]): number {
  const dy = (to[1] - from.lat) * METRES_PER_DEGREE;
  const dx = (to[0] - from.lon) * METRES_PER_DEGREE * Math.cos((from.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

export interface NearbyStreet {
  id: string;
  name: string;
  peakCm: number;
  /** Last step still passable for this vehicle, as IST; null when it is impassable already. */
  passableUntil: string | null;
}

/**
 * The streets this run wets worst, with the last time each is still passable for this vehicle.
 *
 * With a position, only streets within {@link NEARBY_RADIUS_M} of it; without one - geolocation
 * refused, unavailable, or not yet answered - every street in the AOI, and the caller says so in
 * words rather than calling the city's worst street "near you".
 */
export function nearbyStreets(
  segments: readonly { id: string; path: [number, number][]; depthCm: number[]; name?: string }[],
  validTs: readonly string[],
  stopsAtCm: number,
  at: MapPoint | null,
  limit = NEARBY_LIMIT,
): NearbyStreet[] {
  const rows: NearbyStreet[] = [];
  for (const segment of segments) {
    const peak = segment.depthCm.length ? Math.max(...segment.depthCm) : 0;
    // Only streets this vehicle would have to think about: half its stopping depth or more.
    if (peak < stopsAtCm * 0.5) continue;
    if (at && !segment.path.some((point) => distanceM(at, point) <= NEARBY_RADIUS_M)) continue;

    const firstOver = segment.depthCm.findIndex((cm) => cm >= stopsAtCm);
    rows.push({
      id: segment.id,
      name: segment.name || UNNAMED_ROAD,
      peakCm: peak,
      passableUntil:
        firstOver < 0
          ? formatIst(validTs[validTs.length - 1] ?? "")
          : firstOver === 0
            ? null
            : formatIst(validTs[firstOver - 1] ?? validTs[0] ?? ""),
    });
  }
  rows.sort((a, b) => b.peakCm - a.peakCm);
  return rows.slice(0, limit);
}

/** The header's honesty line: which run drew this map, and for when. */
export function runLine(run: CitizenRun | null, failed: boolean): string {
  if (run?.provenance.cycleTs) {
    return `${formatDate(run.provenance.cycleTs)} · ${formatIst(run.provenance.cycleTs)} IST · run ${shortenRunId(run.provenance.runId)}`;
  }
  if (failed) return "The forecast did not load; check the connection and reload";
  return "Loading the last VARUNA run";
}

/** The three labels UI_SPEC 3 fixes, each naming a kind of number this screen shows. */
export const HONESTY_CHIPS = [
  "Reconstructed replay",
  "Emulator estimate",
  "Live weather - Open-Meteo",
] as const;

/** The reader's own position, once they grant it. Never asked for without a click. */
function useMyLocation(): {
  position: MapPoint | null;
  state: "idle" | "asking" | "granted" | "refused";
  ask: () => void;
} {
  const [position, setPosition] = useState<MapPoint | null>(null);
  const [state, setState] = useState<"idle" | "asking" | "granted" | "refused">("idle");

  const ask = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState("refused");
      return;
    }
    setState("asking");
    navigator.geolocation.getCurrentPosition(
      (fix) => {
        setPosition({ lon: fix.coords.longitude, lat: fix.coords.latitude });
        setState("granted");
      },
      // A refusal is a choice, not an error: the screen falls back to the place the reader named.
      () => setState("refused"),
      { timeout: 8_000, maximumAge: 60_000 },
    );
  }, []);

  return { position, state, ask };
}

/** The id this browser uses for this trip, so the corridor it was given stays its corridor. */
function tripId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.sessionStorage.getItem(TRIP_ID_KEY);
    if (stored) return stored;
    const made =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `trip-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    window.sessionStorage.setItem(TRIP_ID_KEY, made);
    return made;
  } catch {
    // A private window can refuse storage; the API then spreads this request on its own.
    return undefined;
  }
}

const PICKED_ON_MAP = "__picked__";
const MY_LOCATION = "__me__";

function ReportWaterButton({ variant }: { variant: "solid" | "outline" }) {
  return (
    <Button
      size="lg"
      variant={variant === "outline" ? "outline" : undefined}
      // 44 px, the citizen floor (CLAUDE.md 6.5, 7.11).
      className="h-11"
      render={<Link href={REPORT_ROUTE} />}
      nativeButton={false}
    >
      <Umbrella aria-hidden="true" />
      Report water
    </Button>
  );
}

/** A native select: on a phone it opens the OS picker, which beats any listbox we could draw. */
function PlaceField({
  id,
  label,
  value,
  onChange,
  places,
  extra,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  places: readonly Place[];
  extra?: { value: string; label: string };
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="type-micro text-text-2">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-line bg-well text-text type-small rounded-control focus-visible:border-line-strong h-11 w-full border px-3 outline-none focus-visible:ring-2 focus-visible:ring-[var(--tide)]"
      >
        <option value="">Choose a place</option>
        {extra ? <option value={extra.value}>{extra.label}</option> : null}
        {places.map((place) => (
          <option key={place.id} value={place.id}>
            {place.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function DashboardScreen() {
  const city = "mumbai";
  const [profile, setProfile] = useState<PublicProfile>("car");
  const [run, setRun] = useState<CitizenRun | null>(null);
  const [runFailed, setRunFailed] = useState(false);
  const [introDone, setIntroDone] = useState(false);

  const [places, setPlaces] = useState<Place[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [picked, setPicked] = useState<MapPoint | null>(null);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [corridorId, setCorridorId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const { position, state: locationState, ask } = useMyLocation();
  const stageRef = useRef<HTMLDivElement>(null);
  const [sheetHeight, setSheetHeight] = useState(600);

  // **The rail exists once, not twice.** Rendering both shapes and hiding one with `lg:hidden`
  // puts two "From" comboboxes, two "To" comboboxes and two copies of every id in the document,
  // which is a real accessibility defect and not a styling detail. The server assumes the phone
  // shape (UI_SPEC 3's default) and hydration corrects it.
  const wide = useMediaQuery(RAIL_BREAKPOINT);

  const onIntroDone = useCallback(() => setIntroDone(true), []);
  const onRunLoaded = useCallback((loaded: CitizenRun) => {
    setRun(loaded);
    setRunFailed(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadPlaces(city, controller.signal)
      .then(setPlaces)
      // Without the registers the trip form has nothing to offer; the map and the street list
      // still work, and the form says so below rather than throwing the screen away.
      .catch(() => undefined);
    return () => controller.abort();
  }, [city]);

  // The map pane's height, which the sheet's snap points are shares of.
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const update = () => setSheetHeight(node.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Nothing baked, or the API is down: the map says so itself, and the header stops claiming a
  // run is on the way once a reasonable wait has passed without one.
  useEffect(() => {
    if (run) return;
    const timer = window.setTimeout(() => setRunFailed(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [run]);

  const byId = useMemo(() => new Map(places.map((p) => [p.id, p])), [places]);

  /** Where "near you" is centred: the reader's fix, else the place they named as their start. */
  const centre = useMemo<MapPoint | null>(() => {
    if (position) return position;
    const from = byId.get(fromId);
    return from ? { lon: from.lon, lat: from.lat } : null;
  }, [position, byId, fromId]);

  const nearby = useMemo(
    () => (run ? nearbyStreets(run.segments, run.validTs, STOPS_AT_CM[profile], centre) : []),
    [run, profile, centre],
  );

  const origin = fromId === MY_LOCATION ? position : (byId.get(fromId) ?? null);
  const destination = toId === PICKED_ON_MAP ? picked : (byId.get(toId) ?? null);
  const canPlan = Boolean(origin && destination && run && !planning);

  const pickPoint = useCallback((point: MapPoint) => {
    setPicked(point);
    setToId(PICKED_ON_MAP);
  }, []);

  const findRoute = useCallback(() => {
    if (!origin || !destination || !run) return;
    setPlanning(true);
    setPlanError(null);
    // The map is a reconstruction of 2 July 2019, so the trip departs at the cycle the map is
    // drawing. Costing it against the clock on this laptop would price a 2019 storm in 2026.
    const departAt = run.provenance.cycleTs ?? new Date().toISOString();
    planRoute({
      origin: { id: "from", name: "From", kind: "hotspot", lon: origin.lon, lat: origin.lat },
      destination: {
        id: "to",
        name: "To",
        kind: "hotspot",
        lon: destination.lon,
        lat: destination.lat,
      },
      departAt,
      profile,
      riskTolerance: CITIZEN_RISK_TOLERANCE,
      runId: run.provenance.runId || undefined,
      spread: true,
      explain: true,
      tripId: tripId(),
    })
      .then((next) => {
        setPlan(next);
        setCorridorId(next.corridors.find((c) => c.assigned)?.id ?? null);
      })
      .catch((error: unknown) => {
        setPlan(null);
        setPlanError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPlanning(false));
  }, [origin, destination, run, profile]);

  const rail = (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="trip" className="flex flex-col gap-3">
        <h2 id="trip" className="font-display text-h3 text-text">
          Can I get there?
        </h2>
        {places.length === 0 ? (
          <p className="type-small text-text-2">
            The city&apos;s places have not loaded, so a trip cannot be planned yet. Reload once the
            API is reachable.
          </p>
        ) : (
          <>
            <PlaceField
              id="dashboard-from"
              label="From"
              value={fromId}
              onChange={setFromId}
              places={places}
              extra={position ? { value: MY_LOCATION, label: "My location" } : undefined}
            />
            <PlaceField
              id="dashboard-to"
              label="To"
              value={toId}
              onChange={setToId}
              places={places}
              extra={
                picked
                  ? { value: PICKED_ON_MAP, label: "The point I picked on the map" }
                  : undefined
              }
            />
            <div className="flex flex-col gap-1">
              <span className="type-micro text-text-2">Vehicle</span>
              <VehicleSelector value={profile} onValueChange={setProfile} />
            </div>
            <Button className="h-11" onClick={findRoute} disabled={!canPlan}>
              {planning ? "Finding the safe way" : "Find the safe way"}
            </Button>
            {!run ? (
              <p className="type-micro text-text-3">
                A trip can be planned once a VARUNA run has scored the streets.
              </p>
            ) : null}
            {locationState !== "granted" ? (
              <Button variant="outline" className="h-11" onClick={ask}>
                <LocateFixed aria-hidden="true" />
                {locationState === "refused"
                  ? "Location unavailable - choose a place instead"
                  : "Use my location"}
              </Button>
            ) : null}
          </>
        )}
      </section>

      {planError ? (
        <p className="border-line bg-deep rounded-panel text-small text-text-2 border p-3">
          {planError}
        </p>
      ) : plan ? (
        <RouteAnswer
          plan={plan}
          reasons={plan.reasons}
          corridors={plan.corridors}
          selectedCorridorId={corridorId}
          onPickCorridor={setCorridorId}
          profile={profile}
        />
      ) : (
        <EmptyState
          size="sm"
          title="No trip yet"
          description="Choose where you are and where you are going, then find the safe way."
        />
      )}
    </div>
  );

  const nearbyTitle = centre ? "Streets near you" : "The worst streets in the city right now";
  const nearbyEmpty = centre
    ? "No street within 1.5 km of you is near this vehicle's stopping depth in this run."
    : "This run wets no street near this vehicle's stopping depth.";
  const untilLabel = (street: NearbyStreet) =>
    street.passableUntil ? `Passable until ${street.passableUntil}` : "Impassable now";

  /** The sheet's shape: a column, because a phone has height and no width. */
  const streetColumn = (
    <section aria-labelledby="near-you-sheet" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="near-you-sheet" className="type-small text-text font-medium">
          {nearbyTitle}
        </h2>
        <span className="type-micro text-text-3">passable until</span>
      </div>
      {!run ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ) : nearby.length === 0 ? (
        <p className="type-micro text-text-2">{nearbyEmpty}</p>
      ) : (
        <ul className="divide-line rounded-panel border-line divide-y border">
          {nearby.map((street) => (
            <li key={street.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="type-small text-text block truncate">{street.name}</span>
                <span className="num type-micro text-text-2 block">{untilLabel(street)}</span>
              </span>
              <span className="num type-small text-text-2 shrink-0">
                {street.peakCm.toFixed(0)} cm
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  /**
   * The desktop band's shape: one 88 px strip, because the map is the screen and a list eight rows
   * tall underneath it would take half of what the map is for. The strip scrolls sideways and is
   * focusable, so a keyboard reaches the streets past the fold (the defect P10.3 found five times).
   */
  const streetStrip = (
    <section
      aria-labelledby="near-you-band"
      className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden"
    >
      <div className="w-[170px] shrink-0">
        <h2 id="near-you-band" className="type-small text-text font-medium">
          {nearbyTitle}
        </h2>
        <span className="type-micro text-text-3">passable until</span>
      </div>
      {!run ? (
        <div className="flex flex-1 gap-2">
          <Skeleton className="h-11 w-40" />
          <Skeleton className="h-11 w-40" />
        </div>
      ) : nearby.length === 0 ? (
        <p className="type-micro text-text-2">{nearbyEmpty}</p>
      ) : (
        <ul
          tabIndex={0}
          aria-labelledby="near-you-band"
          className="focus-visible:border-line-strong flex min-w-0 flex-1 gap-2 overflow-x-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--tide)]"
        >
          {nearby.map((street) => (
            <li
              key={street.id}
              className="border-line rounded-control min-w-0 shrink-0 border px-3 py-1.5"
            >
              <span className="type-small text-text block max-w-[24ch] truncate">
                {street.name}
              </span>
              <span className="num type-micro text-text-2 block">
                {street.peakCm.toFixed(0)} cm · {untilLabel(street)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-line bg-deep shrink-0 border-b px-4 py-2 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 items-center gap-3">
            <Wordmark size="sm" withMark />
            <span className="type-small text-text-2">Mumbai</span>
          </div>
          <WeatherChip city={city} />
        </div>
        <p className="num type-micro text-text-3 mt-1" data-slot="run-line">
          {runLine(run, runFailed)}
        </p>
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {HONESTY_CHIPS.map((chip) => (
            <li
              key={chip}
              className="border-line text-text-3 type-micro rounded-full border px-2 py-0.5"
            >
              {chip}
            </li>
          ))}
        </ul>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* The pane owns the height; the map is absolute inside it (UI_SPEC 3). */}
        <div ref={stageRef} className="relative min-h-0 flex-1">
          <CitizenMap
            city={city}
            profile={profile}
            route={plan}
            corridors={plan?.corridors ?? null}
            selectedCorridorId={corridorId}
            onPickPoint={pickPoint}
            onRunLoaded={onRunLoaded}
          />

          {/* Above the map's own attribution credit, which runs along the bottom edge. */}
          <PublicLegend
            profile={profile}
            className="border-line bg-ink/80 rounded-control pointer-events-none absolute bottom-8 left-3 z-10 border px-2.5 py-1.5"
          />

          {wide ? null : (
            <>
              <Button
                size="lg"
                // Under the sheet (z-20), so an opened sheet is not read through a button.
                className="absolute right-4 z-10 h-11"
                style={{ bottom: 112 }}
                render={<Link href={REPORT_ROUTE} />}
                nativeButton={false}
              >
                <Umbrella aria-hidden="true" />
                Report water
              </Button>

              <BottomSheet containerHeight={sheetHeight} title="Your way there">
                <div className="flex flex-col gap-5">
                  {/* The floating button sits under an opened sheet, so it carries its own. */}
                  <div className="self-start">
                    <ReportWaterButton variant="outline" />
                  </div>
                  {rail}
                  {streetColumn}
                </div>
              </BottomSheet>
            </>
          )}

          {/* The map is mounted and framed behind the entry, so the cross-fade lands on a framed
              city rather than on an unframed world (UI_SPEC 2). */}
          <div
            aria-hidden={introDone}
            hidden={introDone}
            className={cn("bg-ink absolute inset-0 z-30")}
          >
            <DashboardIntro onDone={onIntroDone} />
          </div>
        </div>

        {wide ? (
          <aside className="border-line bg-deep min-h-0 w-[380px] shrink-0 overflow-y-auto border-l p-4">
            {rail}
          </aside>
        ) : null}
      </div>

      {wide ? (
        <div className="border-line bg-deep flex h-[88px] shrink-0 items-center justify-between gap-6 border-t px-6">
          {streetStrip}
          <ReportWaterButton variant="solid" />
        </div>
      ) : null}
    </main>
  );
}
