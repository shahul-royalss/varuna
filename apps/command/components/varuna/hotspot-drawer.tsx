"use client";

import NumberFlow from "@number-flow/react";
import { ExternalLink, X } from "lucide-react";
import { motion } from "motion/react";

import type { Hotspot } from "@/lib/api/hotspots";
import { Button } from "@/components/ui/button";
import { DepthChip } from "@/components/varuna/depth-chip";
import { EmptyState } from "@/components/varuna/empty-state";
import { FanChart, type FanChartPoint } from "@/components/varuna/fan-chart";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { DUR, EASE_UI } from "@/lib/motion";
import { PROFILE_THRESHOLD_CM, type PassabilityProfile } from "@/lib/ramps";
import { formatIstTime } from "@/lib/stores/time";

export interface HotspotDrawerProps {
  hotspot: Hotspot | null;
  /** Current step on the time bar; the headline number is the depth at this moment. */
  step: number;
  /** Minutes per step, for the lead-time axis. */
  stepMin?: number;
  /** Valid time of each step, so "safe until" is a clock time and not a step number. */
  validTs?: readonly string[];
  onClose?: () => void;
}

/** The order the safe-until table reads in: lightest vehicle first, rescue last. */
const PROFILES: readonly { key: PassabilityProfile; label: string }[] = [
  { key: "two-wheeler", label: "Two-wheeler" },
  { key: "car", label: "Car" },
  { key: "bus", label: "Bus or truck" },
  { key: "ambulance", label: "Ambulance" },
  { key: "pedestrian", label: "Pedestrian" },
];

/**
 * The first step at which a profile's threshold is exceeded, or -1 if it never is.
 *
 * "Safe until" is the honest phrasing of it: not a promise the street is dry, but the last time
 * before this run expects it to stop carrying that vehicle.
 */
function firstUnsafeStep(depthCm: readonly number[], thresholdCm: number): number {
  return depthCm.findIndex((cm) => cm > thresholdCm);
}

export function HotspotDrawer({
  hotspot,
  step,
  stepMin = 5,
  validTs = [],
  onClose,
}: HotspotDrawerProps) {
  const reducedMotion = usePrefersReducedMotion();
  if (!hotspot) return null;

  const now = hotspot.depthCm[Math.min(step, hotspot.depthCm.length - 1)] ?? 0;

  // One deterministic Twin run, so p10 = p50 = p90. The band is drawn flat rather than invented,
  // and the caption below says why it has no width (rule 6).
  const points: FanChartPoint[] = hotspot.depthCm.map((cm, i) => ({
    validTs: validTs[i] ?? "",
    leadMin: i * stepMin,
    p10: cm,
    p50: cm,
    p90: cm,
  }));

  return (
    <motion.aside
      aria-label={`${hotspot.name} forecast`}
      initial={reducedMotion ? false : { x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={reducedMotion ? { duration: 0 } : { duration: DUR.drawerSlide, ease: EASE_UI }}
      className="flex h-full min-h-0 flex-col overflow-y-auto bg-deep"
    >
      <header className="flex items-start justify-between gap-3 border-b border-line p-4">
        <div className="min-w-0">
          <h2 className="type-h3 font-display text-text">{hotspot.name}</h2>
          <p className="mt-1 type-micro text-text-3">
            Rank {hotspot.rank}
            {hotspot.ward ? ` · ward ${hotspot.ward}` : ""}
            {hotspot.isSink ? " · terrain sink" : ""}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <X size={16} strokeWidth={1.75} />
        </Button>
      </header>

      <section className="border-b border-line p-4">
        <div className="flex items-baseline gap-2">
          {/* Motion M4: the number rolls as the operator scrubs. */}
          <span className="num font-display text-display leading-none text-text">
            {reducedMotion ? (
              Math.round(now)
            ) : (
              <NumberFlow value={Math.round(now)} respectMotionPreference={false} />
            )}
          </span>
          <span className="type-h3 text-text-2">cm</span>
        </div>
        <p className="mt-2 type-small text-text-2">
          p50 at {validTs[step] ? formatIstTime(validTs[step]) : `+${step * stepMin} min`} · peaks
          at {Math.round(hotspot.peakDepthCm)} cm
          {hotspot.peakTs ? ` at ${formatIstTime(hotspot.peakTs)}` : ""} (+{hotspot.timeToPeakMin}{" "}
          min)
        </p>
        {hotspot.minutesImpassable > 0 ? (
          <p className="mt-1 type-small text-text-2">
            Above 30 cm for {hotspot.minutesImpassable} min
            {hotspot.impassableFromTs ? `, from ${formatIstTime(hotspot.impassableFromTs)}` : ""}.
          </p>
        ) : (
          <p className="mt-1 type-small text-text-3">Stays below the 30 cm car threshold.</p>
        )}
      </section>

      <section className="border-b border-line p-4">
        <h3 className="type-small font-medium text-text">Depth over the forecast</h3>
        <div className="mt-2">
          <FanChart
            points={points}
            quantity="Depth"
            unit="cm"
            height={160}
            markerLeadMin={step * stepMin}
            markerLabel="now"
          />
        </div>
        <p className="mt-2 type-micro text-text-3">
          One deterministic Twin run, so the band has no width. The 50-member spread arrives with
          Flash-lite.
        </p>
      </section>

      <section className="border-b border-line p-4">
        <h3 className="type-small font-medium text-text">Safe until</h3>
        <table className="mt-2 w-full">
          <caption className="sr-only">
            The last forecast time before each vehicle can no longer pass {hotspot.name}
          </caption>
          <tbody className="divide-y divide-line">
            {PROFILES.map(({ key, label }) => {
              const threshold = PROFILE_THRESHOLD_CM[key];
              const unsafe = firstUnsafeStep(hotspot.depthCm, threshold);
              return (
                <tr key={key} className="h-8">
                  <th scope="row" className="text-left type-small font-normal text-text-2">
                    {label}
                  </th>
                  <td className="num w-16 text-right type-micro text-text-3">{threshold} cm</td>
                  <td className="num w-28 text-right type-small text-text">
                    {unsafe < 0 ? (
                      <span className="text-text-2">passable</span>
                    ) : unsafe === 0 ? (
                      <span className="text-text">already over</span>
                    ) : validTs[unsafe] ? (
                      formatIstTime(validTs[unsafe])
                    ) : (
                      `+${unsafe * stepMin} min`
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="border-b border-line p-4">
        <h3 className="type-small font-medium text-text">Exposure</h3>
        <dl className="mt-2 space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="type-small text-text-2">Nearest hospital</dt>
            <dd className="num min-w-0 truncate type-small text-text">
              {hotspot.exposure.nearestHospital
                ? `${hotspot.exposure.nearestHospital} · ${hotspot.exposure.nearestHospitalM} m`
                : "none within 300 m"}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="type-small text-text-2">Nearest station</dt>
            <dd className="num min-w-0 truncate type-small text-text">
              {hotspot.exposure.nearestStation
                ? `${hotspot.exposure.nearestStation} · ${hotspot.exposure.nearestStationM} m`
                : "none within 300 m"}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="type-small text-text-2">Road exposure weight</dt>
            <dd className="num type-small text-text">{hotspot.exposure.weight.toFixed(2)}</dd>
          </div>
        </dl>
      </section>

      <section className="border-b border-line p-4">
        <h3 className="type-small font-medium text-text">Why this junction floods</h3>
        {/* This was a busy skeleton captioned "once Pulse has learned this junction's blockage".
            Pulse has: the baked runs move 202 of 6,000 edges off their prior on the 08:40 cycle
            and 270 on 09:10, so the stated precondition was already met and the skeleton could
            never resolve - a region that stays busy forever also fails 6.10. The ranking is
            missing for a structural reason instead (ADR-0042), so the panel states it. */}
        <EmptyState
          size="sm"
          className="mt-1"
          title="Attribution is not computed on this run"
          description="Flash-lite is element-wise per segment, so cleaning a pipe that is not under this junction has exactly zero effect — ADR-0042."
        />
      </section>

      <footer className="p-4">
        <div className="flex items-center justify-between gap-3">
          <DepthChip cm={hotspot.peakDepthCm} size="sm" showBand />
          {hotspot.sourceUrl ? (
            <a
              href={hotspot.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 type-micro text-tide underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tide"
            >
              Chronic-spot source
              <ExternalLink size={12} strokeWidth={1.75} />
            </a>
          ) : (
            <span className="type-micro text-text-3">No public source recorded</span>
          )}
        </div>
      </footer>
    </motion.aside>
  );
}
