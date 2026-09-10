"use client";

/**
 * Reachability clocks for the console's right rail (CLAUDE.md 7.2, 6.6; task P8.6).
 *
 * A ring gauge per band, filled to the share of that facility's *own dry-weather* catchment it
 * can still reach. The comparison is what makes the number mean anything: 8,412 junctions is a
 * figure nobody can weigh, "81 % of what it reaches on a dry morning" is one anybody can.
 *
 * The share is counted in junctions, not in hull area, for the reason `varuna_route.reach`
 * records: water only ever removes junctions, so the count cannot exceed one, and a concave hull
 * can.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { EmptyState } from "@/components/varuna/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { formatIst } from "@/lib/format";
import { loadPlaces, loadReachability, type Place, type ReachabilityResult } from "@/lib/api/route";

/** Facilities offered in the picker: the demo's two hospitals plus every fire station. */
const DEMO_HOSPITALS = ["(KEM)", "(LTMG)"];

/** Ring geometry: one circle, stroked twice. */
const RING_SIZE = 56;
const RING_STROKE = 5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/* The map's `--reach-*` tokens are 45 %, 28 % and 14 % alpha, because there they are three
 * polygons stacked on top of each other and the 15-minute band has the other two painted over it.
 * A gauge in the rail is a single stroke on a panel: at 14 % it would be invisible. So the rings
 * are `--tide` at full strength and the band is named beside each one. */
const RING_CLASS = "text-tide";

export interface ReachabilityPanelProps {
  /** The instant to measure at: the console's scrub time. */
  at: string;
  onIsochrones?: (rings: { minutes: number; rings: [number, number][][] }[]) => void;
}

function Ring({ minutes, share }: { minutes: number; share: number }) {
  const clamped = Math.max(0, Math.min(1, share));
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      role="img"
      aria-label={`${minutes} minute catchment, ${Math.round(clamped * 100)} per cent of dry`}
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke="var(--line)"
        strokeWidth={RING_STROKE}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={`${RING_CIRCUMFERENCE * clamped} ${RING_CIRCUMFERENCE}`}
        transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        className={RING_CLASS}
      />
      <text
        x="50%"
        y="52%"
        textAnchor="middle"
        dominantBaseline="middle"
        className="num fill-[var(--text)] text-[11px]"
      >
        {Math.round(clamped * 100)}%
      </text>
    </svg>
  );
}

export function ReachabilityPanel({ at, onIsochrones }: ReachabilityPanelProps) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState<string>("");
  // The answer carries the question it answers. That is what lets "loading" and "error" be
  // derived below rather than tracked: a result whose key is not the current one is, by
  // definition, still in flight - one state, and nothing to fall out of step with it.
  const [answer, setAnswer] = useState<{
    key: string;
    result: ReachabilityResult | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadPlaces("mumbai", controller.signal)
      .then((loaded) => {
        const usable = loaded.filter(
          (p) =>
            p.kind === "fire_station" || DEMO_HOSPITALS.some((needle) => p.name.includes(needle)),
        );
        setPlaces(usable);
        setSelected((current) => current || usable[0]?.id || "");
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const key = `${selected}|${at}`;

  useEffect(() => {
    if (!selected || !at) return;
    const controller = new AbortController();
    loadReachability(selected, at, "ambulance", controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setAnswer({ key, result: next, error: null });
        onIsochrones?.(next.bands.map((b) => ({ minutes: b.minutes, rings: b.rings })));
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setAnswer({
          key,
          result: null,
          error: failure instanceof Error ? failure.message : String(failure),
        });
      });
    return () => controller.abort();
  }, [selected, at, key, onIsochrones]);

  const current = answer?.key === key ? answer : null;
  const result = current?.result ?? null;
  const error = current?.error ?? null;
  const loading = Boolean(selected && at) && current === null;

  const shares = useMemo(() => {
    if (!result) return [];
    return result.bands.map((band) => ({
      minutes: band.minutes,
      share: band.nJunctionsDry > 0 ? band.nJunctions / band.nJunctionsDry : 1,
      band,
    }));
  }, [result]);

  if (places.length === 0) {
    return (
      <EmptyState
        title="No facilities loaded"
        description="Hospitals and fire stations arrive with the city. Build Mumbai first, then reload."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-2">
        <label htmlFor="reach-facility" className="block type-small font-medium text-text">
          Facility
        </label>
        <select
          id="reach-facility"
          className="h-8 w-full rounded-control border border-line bg-well px-2 type-small text-text outline-none focus-visible:border-line-strong focus-visible:ring-3 focus-visible:ring-tide/50"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {places.map((place) => (
            <option key={place.id} value={place.id}>
              {place.name}
            </option>
          ))}
        </select>
      </div>

      {error ? <p className="type-small text-text-2">{error}</p> : null}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : null}

      {result ? (
        <>
          {result.collapsed ? (
            <p className="flex items-start gap-2 rounded-control border border-line bg-well p-2 type-small text-text-2">
              <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>
                Catchment collapsed: this facility reaches under 40 % of the junctions it reaches on
                a dry morning.
              </span>
            </p>
          ) : null}

          <ul className="flex flex-col gap-2">
            {shares.map(({ minutes, share, band }) => (
              <li
                key={minutes}
                className="flex items-center gap-3 rounded-control border border-line bg-well p-2"
              >
                <Ring minutes={minutes} share={share} />
                <div className="min-w-0">
                  <p className="type-small text-text">{minutes} minutes by ambulance</p>
                  <p className="num type-micro text-text-2">
                    {band.nJunctions.toLocaleString("en-IN")} junctions of{" "}
                    {band.nJunctionsDry.toLocaleString("en-IN")} dry
                  </p>
                  <p className="num type-micro text-text-3">
                    {band.areaKm2.toFixed(1)} km² reached
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <p className="type-micro text-text-3">
            Measured at {formatIst(result.validTs)} IST on the road network VARUNA derived, against
            this facility&rsquo;s own dry-weather catchment.
          </p>
        </>
      ) : null}
    </div>
  );
}
