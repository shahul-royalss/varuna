"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  Copy,
  Cpu,
  Droplets,
  FireExtinguisher,
  History,
  Hospital,
  Keyboard,
  type LucideIcon,
  MapPin,
  Play,
  Settings,
  Waypoints,
  Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/varuna/kbd";
import { SkeletonRows } from "@/components/varuna/skeleton";
import { paletteHref, usePaletteData } from "@/lib/api/palette";
import { formatBeta, formatCm, formatDateTime } from "@/lib/format";
import { NAV_ITEMS, PALETTE_ACTIONS, type PaletteActionId, type PaletteHotspot } from "@/lib/nav";
import { useReplayStore } from "@/lib/stores/replay";
import { useRunStore } from "@/lib/stores/run";
import { useUiStore } from "@/lib/stores/ui";

export interface CommandPaletteProps {
  /** Called when a hotspot is picked; defaults to opening the console on that hotspot. */
  onSelectHotspot?: (hotspot: PaletteHotspot) => void;
}

const ACTION_ICONS: Record<PaletteActionId, LucideIcon> = {
  "toggle-play": Play,
  "compute-live": Cpu,
  "copy-run-id": Copy,
  "dispatch-pumps": Droplets,
  "clean-top-pipes": Wrench,
  "open-settings": Settings,
  "show-shortcuts": Keyboard,
};

/**
 * Actions whose control exists but whose engine is not wired, each with its one sentence of plan
 * (CLAUDE.md 17: "coming in pilot", never a dead control). Compute live needs a cycle that runs
 * Sky, Twin and products on demand; the console serves baked runs only, so the palette says so
 * rather than opening a replay panel whose button cannot do it either.
 */
export const PILOT_PLANS: Partial<Record<PaletteActionId, string>> = {
  "compute-live":
    "Compute live will re-run this cycle through Sky, Twin and products and publish the new run to the console.",
};

async function copyRunId(runId: string | undefined): Promise<void> {
  if (!runId) return;
  try {
    await navigator.clipboard.writeText(runId);
    toast.success("Run id copied");
  } catch {
    toast.error("Copy failed. Select the run id in the top bar to copy it.");
  }
}

/** A line inside a group that is not a choice: an empty list or a failure, never selectable. */
function StatusRow({ children }: { children: ReactNode }) {
  return <div className="text-text-3 px-2 py-1.5 text-sm">{children}</div>;
}

/** Shimmer rows while a group loads (motion M22); the label is for screen readers. */
function LoadingRows({ label }: { label: string }) {
  return (
    <div role="status" className="px-2">
      <span className="sr-only">{label}</span>
      <SkeletonRows rows={3} />
    </div>
  );
}

/*
 * Item values, in one place: cmdk matches the search against them and the controlled selection
 * names an item by them, so the two must never drift apart. Each carries the id, so two facilities
 * that share a name ("Bandra Fire Brigade" is in the asset layer twice) stay two items.
 */
const hotspotValue = (h: { id: string; name: string }) => `hotspot ${h.name} ${h.id}`;
const facilityValue = (f: { id: string; name: string }) => `facility ${f.name} ${f.id}`;
const pipeValue = (p: { id: string; street: string | null }) => `pipe ${p.id} ${p.street ?? ""}`;
const screenValue = (item: { label: string }) => `screen ${item.label}`;

function failure(what: string, error: Error | null): string {
  const reason = error?.message ? ` (${error.message.replace(/\.$/, "")})` : "";
  return `${what} did not load${reason}. Screens still open; open the palette again to retry.`;
}

/**
 * Command palette (Ctrl K, CLAUDE.md 7.13): jump to a hotspot, facility, pipe, screen or run, or
 * start an action. Open state lives in the ui store so the global shortcut and the top-bar button
 * share it.
 *
 * It loads its own lists (`usePaletteData`) for the run the operator is looking at - the run store's
 * run, which the console sets from the cycle it draws - or the newest run when there is none. The
 * lists load on first open, not on page load.
 */
export function CommandPalette({ onSelectHotspot }: CommandPaletteProps) {
  const router = useRouter();
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const currentRun = useRunStore((s) => s.currentRun);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const { runs, hotspots, facilities, pipes } = usePaletteData({
    enabled: open,
    runId: currentRun?.run_id,
    city: currentRun?.city,
  });

  const runList = runs.data ?? [];
  const hotspotList = hotspots.data?.hotspots ?? [];
  // The run every deep link carries: the one on screen, else the one the ranking was read from,
  // else the newest in the registry.
  const activeRunId = currentRun?.run_id || hotspots.data?.runId || runList[0]?.run_id || undefined;

  /*
   * The lists arrive in whatever order the API answers, and cmdk selects the first item that
   * registers - the Console screen, or a fire station if facilities come back first - then keeps
   * that selection while the hotspot ranking lands above it, scrolled out of view. With nothing typed
   * the selection follows the first item in list order instead, so Enter on a fresh palette is the
   * top-ranked hotspot. Adjusted during render rather than in an effect (React's "adjusting state
   * when a prop changes").
   */
  const facilityList = facilities.data ?? [];
  const pipeList = pipes.data ?? [];
  const firstValue = hotspotList[0]
    ? hotspotValue(hotspotList[0])
    : facilityList[0]
      ? facilityValue(facilityList[0])
      : pipeList[0]
        ? pipeValue(pipeList[0])
        : screenValue(NAV_ITEMS[0]!);
  const [anchor, setAnchor] = useState(firstValue);
  if (anchor !== firstValue) {
    setAnchor(firstValue);
    if (search === "") setSelected(firstValue);
  }
  useEffect(() => {
    if (open && search === "" && listRef.current) listRef.current.scrollTop = 0;
  }, [open, search, firstValue]);

  // Every session of the palette starts with an empty query on the first item.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSearch("");
      setSelected(firstValue);
    }
    setOpen(next);
  };

  const close = () => handleOpenChange(false);

  const go = (href: Route) => {
    close();
    router.push(href);
  };

  const pickHotspot = (hotspot: PaletteHotspot) => {
    if (onSelectHotspot) {
      close();
      onSelectHotspot(hotspot);
      return;
    }
    go(paletteHref.hotspot(hotspot.id, activeRunId));
  };

  const runAction = (id: PaletteActionId) => {
    const ui = useUiStore.getState();
    switch (id) {
      case "toggle-play":
        close();
        useReplayStore.getState().togglePlaying();
        return;
      case "open-settings":
        close();
        ui.setSettingsOpen(true);
        return;
      case "show-shortcuts":
        close();
        ui.setShortcutsOpen(true);
        return;
      case "copy-run-id":
        close();
        void copyRunId(activeRunId);
        return;
      case "compute-live":
        // Disabled with its plan (PILOT_PLANS); nothing to run.
        return;
      case "dispatch-pumps":
        go(paletteHref.dispatch(undefined, activeRunId));
        return;
      case "clean-top-pipes":
        // Opens the lab on this cycle and nothing more: no pipe is preselected and no effect is
        // named, because nothing ranks a junction's pipes yet (ADR-0042).
        go(paletteHref.whatif(activeRunId));
        return;
    }
  };

  const noRunsYet = runs.isSuccess && runList.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Command palette"
      description="Jump to a hotspot, facility, pipe, screen or run, or start an action"
      className="motion-reduce:animate-none sm:max-w-lg"
    >
      <Command label="Command palette" loop value={selected} onValueChange={setSelected}>
        <CommandInput
          placeholder="Jump to a hotspot, facility, pipe, screen or action"
          value={search}
          onValueChange={setSearch}
        />
        <CommandList ref={listRef} className="max-h-96">
          <CommandEmpty className="text-text-3">
            Nothing matches. Try a hotspot, a hospital, a pipe id or a screen name.
          </CommandEmpty>

          <CommandGroup heading="Hotspots" forceMount={hotspots.isError || undefined}>
            {hotspots.isLoading ? <LoadingRows label="Loading hotspots" /> : null}
            {hotspots.isError ? <StatusRow>{failure("Hotspots", hotspots.error)}</StatusRow> : null}
            {hotspots.isSuccess && hotspotList.length === 0 ? (
              <StatusRow>
                {noRunsYet
                  ? "No hotspots yet — press Play on the replay"
                  : "This run has no hotspot ranking. Pick another run below."}
              </StatusRow>
            ) : null}
            {hotspotList.map((hotspot) => (
              <CommandItem
                key={hotspot.id}
                value={hotspotValue(hotspot)}
                data-href={paletteHref.hotspot(hotspot.id, activeRunId)}
                onSelect={() =>
                  pickHotspot({ id: hotspot.id, name: hotspot.name, depthCm: hotspot.peakDepthCm })
                }
              >
                <MapPin className="text-text-2 size-4" strokeWidth={1.75} />
                <span className="min-w-0 truncate">{hotspot.name}</span>
                <CommandShortcut className="num tracking-normal">
                  Peak {formatCm(hotspot.peakDepthCm)}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup heading="Facilities" forceMount={facilities.isError || undefined}>
            {facilities.isLoading ? <LoadingRows label="Loading facilities" /> : null}
            {facilities.isError ? (
              <StatusRow>{failure("Facilities", facilities.error)}</StatusRow>
            ) : null}
            {facilities.isSuccess && facilityList.length === 0 ? (
              <StatusRow>This city has no hospitals or fire stations in its asset layer.</StatusRow>
            ) : null}
            {facilityList.map((facility) => {
              const Icon = facility.kind === "fire_station" ? FireExtinguisher : Hospital;
              return (
                <CommandItem
                  key={facility.id}
                  value={facilityValue(facility)}
                  keywords={["reachability"]}
                  data-href={paletteHref.facility(facility.id, activeRunId)}
                  onSelect={() => go(paletteHref.facility(facility.id, activeRunId))}
                >
                  <Icon className="text-text-2 size-4" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">{facility.name}</span>
                  <CommandShortcut className="tracking-normal">
                    {facility.kind === "fire_station" ? "Fire station" : "Hospital"}
                  </CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>

          <CommandGroup heading="Pipes by blockage" forceMount={pipes.isError || undefined}>
            {pipes.isLoading ? <LoadingRows label="Loading pipes" /> : null}
            {pipes.isError ? <StatusRow>{failure("Pipes", pipes.error)}</StatusRow> : null}
            {pipes.isSuccess && pipeList.length === 0 ? (
              <StatusRow>This run has no drain-health product, so no pipe is ranked.</StatusRow>
            ) : null}
            {pipeList.map((pipe) => (
              <CommandItem
                key={pipe.id}
                value={pipeValue(pipe)}
                keywords={["drain", "blockage"]}
                data-href={paletteHref.pipe(pipe.id, activeRunId)}
                onSelect={() => go(paletteHref.pipe(pipe.id, activeRunId))}
              >
                <Waypoints className="text-text-2 size-4" strokeWidth={1.75} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{pipe.street ?? `Pipe ${pipe.id}`}</span>
                  {pipe.street ? (
                    <span className="type-micro text-text-3">Pipe {pipe.id}</span>
                  ) : null}
                </span>
                <CommandShortcut className="num tracking-normal">
                  β {formatBeta(pipe.betaMean)}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup heading="Screens">
            {NAV_ITEMS.map((item) => (
              <CommandItem
                key={item.id}
                value={screenValue(item)}
                keywords={[item.id]}
                data-href={item.href}
                onSelect={() => go(item.href)}
              >
                <item.icon className="text-text-2 size-4" strokeWidth={1.75} />
                <span>{item.label}</span>
                <CommandShortcut className="tracking-normal">
                  <Kbd>{item.hint}</Kbd>
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup heading="Runs" forceMount={runs.isError || undefined}>
            {runs.isLoading ? <LoadingRows label="Loading runs" /> : null}
            {runs.isError ? <StatusRow>{failure("Runs", runs.error)}</StatusRow> : null}
            {noRunsYet ? (
              <StatusRow>No runs yet — press Play on the replay, or bake the bundle.</StatusRow>
            ) : null}
            {runList.map((run) => (
              <CommandItem
                key={run.run_id}
                value={`run ${run.run_id} ${formatDateTime(run.cycle_ts)}`}
                data-href={paletteHref.run(run.run_id)}
                onSelect={() => go(paletteHref.run(run.run_id))}
              >
                <History className="text-text-2 size-4" strokeWidth={1.75} />
                <span className="flex min-w-0 flex-col">
                  <span className="num">{formatDateTime(run.cycle_ts)}</span>
                  <span className="type-micro text-text-3 truncate font-mono">{run.run_id}</span>
                </span>
                <CommandShortcut className="tracking-normal">
                  {run.run_id === activeRunId ? "Showing" : run.mode}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup heading="Actions">
            {PALETTE_ACTIONS.flatMap((action) => {
              const Icon = ACTION_ICONS[action.id];

              // One dispatch per ranked hotspot once the ranking is in; the generic entry until then.
              if (action.id === "dispatch-pumps" && hotspotList.length > 0) {
                return hotspotList.map((hotspot) => {
                  const href = paletteHref.dispatch(hotspot.id, activeRunId);
                  return (
                    <CommandItem
                      key={`dispatch-${hotspot.id}`}
                      value={`action dispatch pumps at ${hotspot.name} ${hotspot.id}`}
                      data-href={href}
                      onSelect={() => go(href)}
                    >
                      <Icon className="text-text-2 size-4" strokeWidth={1.75} />
                      <span className="min-w-0 truncate">Dispatch pumps at {hotspot.name}</span>
                    </CommandItem>
                  );
                });
              }

              const plan = PILOT_PLANS[action.id];
              const waitingForRun = action.needsRun && !activeRunId;
              const disabled = Boolean(plan) || waitingForRun;
              return [
                <CommandItem
                  key={action.id}
                  value={`action ${action.label}`}
                  keywords={[action.id]}
                  disabled={disabled}
                  onSelect={() => runAction(action.id)}
                >
                  <Icon className="text-text-2 size-4" strokeWidth={1.75} />
                  <span className="flex flex-col">
                    <span>{action.label}</span>
                    {plan ? (
                      <span className="type-micro text-text-3">Coming in pilot. {plan}</span>
                    ) : waitingForRun && action.disabledReason ? (
                      <span className="type-micro text-text-3">{action.disabledReason}</span>
                    ) : null}
                  </span>
                  {action.hint ? (
                    <CommandShortcut className="tracking-normal">
                      <Kbd>{action.hint}</Kbd>
                    </CommandShortcut>
                  ) : null}
                </CommandItem>,
              ];
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
