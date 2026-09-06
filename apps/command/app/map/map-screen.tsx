"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { BookmarkPlus, Trash2, Umbrella } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/varuna/bottom-sheet";
import { EmptyState } from "@/components/varuna/empty-state";
import { LanguageToggle } from "@/components/varuna/language-toggle";
import { MapSlot } from "@/components/varuna/map-slot";
import { PublicLegend } from "@/components/varuna/public-legend";
import { VehicleSelector, type PublicProfile } from "@/components/varuna/vehicle-selector";
import { Wordmark } from "@/components/varuna/wordmark";
import { useIsClient } from "@/lib/hooks";
import { formatIst } from "@/lib/format";
import { useRunStore } from "@/lib/stores/run";

const REPORT_ROUTE = "/report" as Route;
const SAVED_KEY = "varuna.map.saved-locations";

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
        <MapSlot />

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

        <BottomSheet containerHeight={sheetHeight} title="Streets near you">
          <div className="flex flex-col gap-5">
            <EmptyState
              size="sm"
              title="No streets scored yet"
              description="The public map fills after the first run."
            />

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
