"use client";

/**
 * The ward officer's desk (UI_SPEC 6, PRD 3.2, task D-15).
 *
 * **One rule decides the layout.** Does an engine consume it, or is it a note? The left column is
 * everything a route, a feed or the optimiser reads back; the right column is everything that is
 * only ever a record. They are never dressed the same, and every act reports through one
 * component so the two cannot drift into sounding alike.
 *
 * **Nothing here rewrites a product.** Every edit is one appended line in `data/ops/<city>.jsonl`,
 * applied when a route or a feed is read, so a baked run stays byte-identical (CLAUDE.md rule 8)
 * while the next route avoids the street. The API says this in its own words after every write
 * and the desk prints it rather than paraphrasing.
 *
 * **The desk is read-only unless the API holds a passphrase.** The screen asks the log first: it
 * answers `writes_enabled`, which is false on the deployed API on purpose, and then the desk
 * offers the reads - the citizen inbox and the log - and refuses to take a passphrase it has
 * nowhere to send. That is the honest shape of prototype access, and the gate says so in the
 * words UI_SPEC 6 sets.
 *
 * **Which cycle.** Alerts and pumps only mean something beside the forecast that raised them, and
 * the newest baked run is 09:10 IST, after the storm. The officer picks the cycle here as they do
 * on the console and on the pump board. Closures are not per-cycle - a street is shut or it is
 * not - but the street *list* is, because it is the set this cycle says is in trouble.
 */

import { useCallback, useEffect, useState } from "react";

import { AlertPanel } from "@/components/authority/alert-panel";
import { CitizenInbox } from "@/components/authority/citizen-inbox";
import { ClosurePanel } from "@/components/authority/closure-panel";
import { OpsLog } from "@/components/authority/ops-log";
import {
  DEFAULT_OFFICER,
  PassphraseGate,
  type GateStatus,
} from "@/components/authority/passphrase-gate";
import { PumpPanel } from "@/components/authority/pump-panel";
import { SituationNote } from "@/components/authority/situation-note";
import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/varuna/app-shell";
import { CyclePicker } from "@/components/varuna/cycle-picker";
import { PageHeader } from "@/components/varuna/page-header";
import {
  clearPassphrase,
  isGateRefusal,
  loadOpsLog,
  opsRefusal,
  readPassphrase,
  type OpsEntry,
  type OpsRefusal,
} from "@/lib/api/ops";

/** The city this desk acts for until the switcher threads one through (task D-09). */
const DESK_CITY = "mumbai";

export function AuthorityScreen() {
  const [status, setStatus] = useState<GateStatus>("checking");
  const [gateReason, setGateReason] = useState<string | null>(null);
  const [officer, setOfficer] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  // Bumped after every write so the log and the inbox refetch; the panels keep their own state.
  const [refreshKey, setRefreshKey] = useState(0);
  const [entries, setEntries] = useState<OpsEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [logError, setLogError] = useState<string | null>(null);

  // The log is the one read that answers both questions this screen opens with: what has been
  // done, and whether this API accepts writes at all.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLogError(null);
      try {
        const log = await loadOpsLog({ city: DESK_CITY, signal: controller.signal });
        if (controller.signal.aborted) return;
        setEntries(log.entries);
        setTotal(log.nEntries);
        if (!log.writesEnabled) {
          setStatus("disabled");
          setGateReason(log.notes.at(-1) ?? null);
          setOfficer(null);
          clearPassphrase();
          return;
        }
        // A tab that already holds an accepted passphrase stays open across a reload.
        setStatus("locked");
        setGateReason(null);
        if (readPassphrase()) setOfficer((current) => current ?? DEFAULT_OFFICER);
      } catch (failure: unknown) {
        if (controller.signal.aborted) return;
        const refusal = opsRefusal(failure);
        setEntries([]);
        setLogError(refusal.message);
        setStatus(refusal.kind === "unreachable" ? "unreachable" : "disabled");
        setGateReason(refusal.message);
      }
    })();
    return () => controller.abort();
  }, [refreshKey]);

  const wrote = useCallback(() => setRefreshKey((key) => key + 1), []);

  // A rejected passphrase closes the desk rather than leaving a screen of controls that will all
  // fail: the passphrase was changed where the API runs, or this tab is holding a stale one.
  const gateRefused = useCallback((refusal: OpsRefusal) => {
    if (!isGateRefusal(refusal)) return;
    clearPassphrase();
    setOfficer(null);
    setStatus("locked");
  }, []);

  const signOut = useCallback(() => {
    clearPassphrase();
    setOfficer(null);
    setStatus("locked");
  }, []);

  const open = status === "locked" && officer !== null;

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-6 p-6">
          <PageHeader
            title="Ward officer's desk"
            description="Tell VARUNA what it cannot know. A closure, a broken pump and an acknowledgement are read back by the router, the optimiser and the alert queue; a note is read by people."
            honesty="Prototype access"
            actions={
              open ? (
                <Button type="button" variant="ghost" className="h-11 px-4" onClick={signOut}>
                  Sign out
                </Button>
              ) : null
            }
          />

          {open ? (
            <>
              <p className="type-small text-text-2 max-w-[72ch]">
                Acting as {officer}. Every edit is one appended line that the router applies when a
                route is read; no baked product is rewritten.
              </p>

              <CyclePicker currentRunId={runId} onPick={setRunId} />

              <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
                <section className="flex flex-col gap-4" aria-labelledby="changes-heading">
                  <div>
                    <h2 id="changes-heading" className="type-h3 text-text">
                      Changes the forecast
                    </h2>
                    <p className="type-small text-text-2 max-w-[72ch]">
                      An engine reads each of these back: the router, the road-conditions feed, the
                      pump optimiser and the desk&rsquo;s alert queue.
                    </p>
                  </div>
                  <ClosurePanel
                    runId={runId}
                    city={DESK_CITY}
                    officer={officer}
                    onWrote={wrote}
                    onGateRefused={gateRefused}
                  />
                  <PumpPanel
                    runId={runId}
                    city={DESK_CITY}
                    officer={officer}
                    onWrote={wrote}
                    onGateRefused={gateRefused}
                  />
                  <AlertPanel
                    runId={runId}
                    city={DESK_CITY}
                    officer={officer}
                    onWrote={wrote}
                    onGateRefused={gateRefused}
                  />
                </section>

                <section className="flex flex-col gap-4" aria-labelledby="recorded-heading">
                  <div>
                    <h2 id="recorded-heading" className="type-h3 text-text">
                      Recorded only
                    </h2>
                    <p className="type-small text-text-2 max-w-[72ch]">
                      Nothing in this column reaches a forecast, a route or an alert. It is written
                      down so a person can read it.
                    </p>
                  </div>
                  <SituationNote officer={officer} />
                </section>
              </div>
            </>
          ) : (
            <PassphraseGate
              status={status}
              reason={gateReason}
              onOpen={(name) => {
                setOfficer(name);
                setStatus("locked");
              }}
            />
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <CitizenInbox refreshKey={refreshKey} />
            <OpsLog entries={entries} total={total} error={logError} />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
