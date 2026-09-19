"use client";

/**
 * The citizen inbox (UI_SPEC 6, PRD 3.2, task D-15).
 *
 * `GET /v1/reports` has served this newest-first since P9.4 and nothing in the product read it.
 * A ward officer is the one person for whom "someone is standing in knee-deep water on this
 * street, ten minutes ago" is actionable, so this is where it belongs.
 *
 * **The place is a coordinate, because that is what the report carries.** A reporter picks a
 * point on a map; `POST /v1/reports` stores `lat` and `lon` and no street name, and there is no
 * endpoint that turns one into the other. Four decimal places - about 11 m - is the truthful
 * version; naming the nearest street would be this screen guessing.
 *
 * **A report does not change the forecast by being read here.** It changes it when the next
 * cycle's Pulse assimilates it, which is what the panel says.
 */

import { Camera } from "lucide-react";
import { useEffect, useState } from "react";

import { DepthChip } from "@/components/varuna/depth-chip";
import { EmptyState } from "@/components/varuna/empty-state";
import { Panel } from "@/components/varuna/panel";
import { Skeleton } from "@/components/varuna/skeleton";
import { formatIst } from "@/lib/format";
import { loadReports, opsRefusal, type CitizenReport } from "@/lib/api/ops";

export interface CitizenInboxProps {
  className?: string;
  /** Changing this reloads the inbox; the screen bumps it after a write. */
  refreshKey?: number;
}

export function CitizenInbox({ className, refreshKey = 0 }: CitizenInboxProps) {
  const [reports, setReports] = useState<CitizenReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Announced inside the load rather than in the effect body, the shape `useCitizenRun` uses:
    // a reload shows its own skeleton without a synchronous setState cascading a second render.
    void (async () => {
      setReports(null);
      setError(null);
      try {
        const rows = await loadReports({ signal: controller.signal });
        if (!controller.signal.aborted) setReports(rows);
      } catch (failure: unknown) {
        if (controller.signal.aborted) return;
        setReports([]);
        setError(opsRefusal(failure).message);
      }
    })();
    return () => controller.abort();
  }, [refreshKey]);

  return (
    <Panel
      className={className}
      title="Citizen inbox"
      description="What people have reported, newest first. Pulse assimilates these on the next cycle."
    >
      {reports === null ? (
        <Skeleton lines={4} />
      ) : error ? (
        <p className="type-small text-text-2">{error}</p>
      ) : reports.length === 0 ? (
        <EmptyState
          size="sm"
          title="No reports yet"
          description="A report arrives from the public map's Report water button, or from /report."
        />
      ) : (
        <ul className="max-h-96 space-y-1.5 overflow-y-auto" aria-label="Citizen reports">
          {reports.map((report) => (
            <li
              key={report.id}
              className="rounded-control border-line bg-well/40 flex items-start justify-between gap-3 border p-2.5"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <DepthChip cm={report.depthCm} size="sm" />
                  <span className="type-micro text-text-2">{report.depthHint}-deep</span>
                  {report.hasPhoto ? (
                    <span className="type-micro text-text-3 inline-flex items-center gap-1">
                      <Camera className="size-3.5" aria-hidden="true" />
                      photo attached
                    </span>
                  ) : null}
                  {report.synthetic ? (
                    <span className="type-micro text-text-3">synthetic</span>
                  ) : null}
                </div>
                {report.text ? <p className="type-small text-text">{report.text}</p> : null}
                <p className="num type-micro text-text-3">
                  {formatIst(report.ts)} · {report.lat.toFixed(4)}, {report.lon.toFixed(4)} ·{" "}
                  {report.source}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
