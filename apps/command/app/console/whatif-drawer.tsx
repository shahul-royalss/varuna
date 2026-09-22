"use client";

/**
 * The console's what-if drawer (CLAUDE.md 7.7: "also a drawer inside the console"; the W key).
 *
 * The same levers and the same endpoint as `/whatif`, asked about the cycle the console is
 * showing, with the answer drawn on the console's own map as the difference layer (motion M13).
 * It takes the right rail's slot, as the hotspot drawer does, so the map keeps its whole width.
 *
 * What the lab refuses, this refuses with the same words: the top-14 ranking (ADR-0042), the
 * pump-plan lever (no field on the endpoint) and the physics check (P7.8).
 */

import { X } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { DeltaTable, type DeltaRow } from "@/components/varuna/delta-table";
import {
  DEFAULT_WHATIF_VALUES,
  WhatIfControls,
  type WhatIfValues,
} from "@/components/varuna/whatif-controls";
import { runWhatIf, type WhatIfResult } from "@/lib/api/whatif";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { DUR, DUR_MS, EASE_UI } from "@/lib/motion";

/** Motion M13: the difference layer wipes left to right over 500 ms (CLAUDE.md 8). */
const WIPE_MS = DUR_MS.diffWipe;

/** Rows in the drawer's table; the full list is the lab's. */
const MAX_ROWS = 8;

const PHYSICS_DISABLED_REASON =
  "Runs the Twin on the same scenario; a full-AOI Mumbai run measures 58-114 s against a 10 s " +
  "budget, so it is not wired to this button yet";
const CLEAN_DISABLED_REASON =
  "Ranking pipes by beta needs attribution, which Flash-lite cannot compute (ADR-0042). Use a " +
  "hotspot's Clean in what-if instead";
const PUMP_DISABLED_REASON = "The pump plan is not a what-if lever yet (P7.7)";

export interface WhatIfDiff {
  deltaCm: ReadonlyMap<string, number>;
  progress: number;
}

export interface WhatIfDrawerProps {
  /** The cycle the question is about: the run the console is showing. */
  runId: string | null;
  /** The answer, for the map's difference layer; null clears it. */
  onDiff: (diff: WhatIfDiff | null) => void;
  onClose: () => void;
}

export function WhatIfDrawer({ runId, onDiff, onClose }: WhatIfDrawerProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // A different cycle is a different question: the answer is dropped, not re-labelled.
  const [answeredFor, setAnsweredFor] = useState(runId);
  if (answeredFor !== runId) {
    setAnsweredFor(runId);
    setResult(null);
    setError(null);
  }

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
            runId: runId ?? undefined,
          }),
        );
      } catch (failure) {
        // The API's own words (CLAUDE.md 6.8): a refused tide scenario explains itself.
        setError(failure instanceof Error ? failure.message : String(failure));
        setResult(null);
      } finally {
        setRunning(false);
      }
    },
    [runId],
  );

  // Motion M13 on the console's map: the diff wipes in left to right whenever an answer lands.
  useEffect(() => {
    if (!result) {
      onDiff(null);
      return;
    }
    const deltaCm = new Map(result.segments.map((s) => [s.segmentId, s.deltaCm]));
    if (reducedMotion) {
      onDiff({ deltaCm, progress: 1 });
      return;
    }
    let frame = 0;
    const started = performance.now();
    const tick = () => {
      const t = Math.min((performance.now() - started) / WIPE_MS, 1);
      onDiff({ deltaCm, progress: t });
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [result, reducedMotion, onDiff]);

  // Closing the drawer takes its answer off the map with it.
  useEffect(() => () => onDiff(null), [onDiff]);

  const rows: DeltaRow[] = (result?.segments ?? []).slice(0, MAX_ROWS).map((row) => ({
    id: row.segmentId,
    hotspot: row.segmentId,
    beforeCm: row.beforeCm,
    afterCm: row.afterCm,
  }));

  return (
    <motion.aside
      aria-label="What-if"
      initial={reducedMotion ? false : { x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={reducedMotion ? { duration: 0 } : { duration: DUR.drawerSlide, ease: EASE_UI }}
      className="bg-deep flex h-full min-h-0 flex-col overflow-y-auto"
    >
      <header className="border-line flex items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <h2 className="type-h3 font-display text-text">What-if</h2>
          <p className="type-micro text-text-3 mt-1">
            Reduced-order emulator calibrated to VARUNA-Twin
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close the what-if">
          <X size={16} strokeWidth={1.75} />
        </Button>
      </header>

      <section className="border-line border-b p-4">
        <WhatIfControls
          initial={DEFAULT_WHATIF_VALUES}
          onRun={(scenario) => void run(scenario)}
          physicsDisabledReason={PHYSICS_DISABLED_REASON}
          cleanDisabled
          cleanDisabledReason={CLEAN_DISABLED_REASON}
          pumpDisabled
          pumpDisabledReason={PUMP_DISABLED_REASON}
        />
        {running ? <p className="type-small text-text-3 mt-3">Running the scenario</p> : null}
        {error ? <p className="type-small text-text-2 mt-3">{error}</p> : null}
      </section>

      {result ? (
        <section className="border-line border-b p-4">
          <h3 className="type-small text-text font-medium">What-if ready</h3>
          <p className="type-small text-text-2 mt-1">
            <span className="num">{result.nWorse.toLocaleString("en-IN")}</span> segments deeper,{" "}
            <span className="num">{result.nImproved.toLocaleString("en-IN")}</span> shallower, in{" "}
            <span className="num">{Math.round(result.ms)}</span> ms on run{" "}
            <span className="num">{result.runId}</span>.
          </p>
          <p className="type-micro text-text-3 mt-1">
            Level from the Twin&rsquo;s own forecast; the emulator supplies only the difference.
            Emulator skill on held-out storms: RMSE {result.emulator.rmseCm.toFixed(1)} cm, CSI{" "}
            {result.emulator.csi30cm.toFixed(2)} at 30 cm.
          </p>
          <div className="mt-3">
            <DeltaTable rows={rows} />
          </div>
        </section>
      ) : null}
    </motion.aside>
  );
}
