"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  Copy,
  Cpu,
  Droplets,
  Keyboard,
  type LucideIcon,
  MapPin,
  Play,
  Settings,
  Wrench,
} from "lucide-react";
import { useState } from "react";
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
import { formatCm } from "@/lib/format";
import { NAV_ITEMS, PALETTE_ACTIONS, type PaletteActionId, type PaletteHotspot } from "@/lib/nav";
import { useReplayStore } from "@/lib/stores/replay";
import { useRunStore } from "@/lib/stores/run";
import { useUiStore } from "@/lib/stores/ui";

export interface CommandPaletteProps {
  /** Hotspots of the loaded run; the console passes them, other screens leave them out. */
  hotspots?: PaletteHotspot[];
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

/** Routes the palette deep-links to; typed here so the palette compiles before every page exists. */
const route = (path: string) => path as Route;

async function copyRunId(runId: string | undefined): Promise<void> {
  if (!runId) return;
  try {
    await navigator.clipboard.writeText(runId);
    toast.success("Run id copied");
  } catch {
    toast.error("Copy failed. Select the run id in the top bar to copy it.");
  }
}

/**
 * Command palette (Ctrl K): jump to a screen, a hotspot or an action.
 * Open state lives in the ui store so the global shortcut and the top-bar button share it.
 */
export function CommandPalette({ hotspots = [], onSelectHotspot }: CommandPaletteProps) {
  const router = useRouter();
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const currentRun = useRunStore((s) => s.currentRun);
  const [search, setSearch] = useState("");

  // Every session of the palette starts with an empty query.
  const handleOpenChange = (next: boolean) => {
    if (!next) setSearch("");
    setOpen(next);
  };

  const close = () => handleOpenChange(false);

  const go = (href: Route) => {
    close();
    router.push(href);
  };

  const pickHotspot = (hotspot: PaletteHotspot) => {
    close();
    if (onSelectHotspot) {
      onSelectHotspot(hotspot);
      return;
    }
    router.push(route(`/console?hotspot=${encodeURIComponent(hotspot.id)}`));
  };

  const runAction = (id: PaletteActionId) => {
    const ui = useUiStore.getState();
    close();
    switch (id) {
      case "toggle-play":
        useReplayStore.getState().togglePlaying();
        return;
      case "open-settings":
        ui.setSettingsOpen(true);
        return;
      case "show-shortcuts":
        ui.setShortcutsOpen(true);
        return;
      case "copy-run-id":
        void copyRunId(currentRun?.run_id);
        return;
      case "compute-live":
        // The button lives in the replay panel on the console; open it there.
        ui.setReplayPanelOpen(true);
        router.push(route("/console"));
        return;
      case "dispatch-pumps":
        router.push(route("/pumps"));
        return;
      case "clean-top-pipes":
        router.push(route("/whatif"));
        return;
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Command palette"
      description="Jump to a screen, hotspot or action"
      className="motion-reduce:animate-none sm:max-w-lg"
    >
      <Command label="Command palette" loop>
        <CommandInput
          placeholder="Jump to a screen, hotspot or action"
          value={search}
          onValueChange={setSearch}
        />
        <CommandList>
          <CommandEmpty className="text-text-3">
            Nothing matches. Try a screen name, a hotspot or an action.
          </CommandEmpty>

          <CommandGroup heading="Screens">
            {NAV_ITEMS.map((item) => (
              <CommandItem
                key={item.id}
                value={`screen ${item.label}`}
                keywords={[item.id]}
                onSelect={() => go(item.href)}
              >
                <item.icon className="size-4 text-text-2" strokeWidth={1.75} />
                <span>{item.label}</span>
                <CommandShortcut className="tracking-normal">
                  <Kbd>{item.hint}</Kbd>
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup heading="Hotspots">
            {hotspots.length === 0 ? (
              <CommandItem value="hotspots empty" disabled>
                <MapPin className="size-4 text-text-3" strokeWidth={1.75} />
                <span className="text-text-3">No hotspots yet — press Play on the replay</span>
              </CommandItem>
            ) : (
              hotspots.map((hotspot) => (
                <CommandItem
                  key={hotspot.id}
                  value={`hotspot ${hotspot.name}`}
                  keywords={[hotspot.id]}
                  onSelect={() => pickHotspot(hotspot)}
                >
                  <MapPin className="size-4 text-text-2" strokeWidth={1.75} />
                  <span>{hotspot.name}</span>
                  {hotspot.depthCm !== undefined ? (
                    <CommandShortcut className="num tracking-normal">
                      {formatCm(hotspot.depthCm)}
                    </CommandShortcut>
                  ) : null}
                </CommandItem>
              ))
            )}
          </CommandGroup>

          <CommandGroup heading="Actions">
            {PALETTE_ACTIONS.map((action) => {
              const disabled = action.needsRun && currentRun === null;
              const Icon = ACTION_ICONS[action.id];
              return (
                <CommandItem
                  key={action.id}
                  value={`action ${action.label}`}
                  keywords={[action.id]}
                  disabled={disabled}
                  onSelect={() => runAction(action.id)}
                >
                  <Icon className="size-4 text-text-2" strokeWidth={1.75} />
                  <span className="flex flex-col">
                    <span>{action.label}</span>
                    {disabled && action.disabledReason ? (
                      <span className="type-micro text-text-3">{action.disabledReason}</span>
                    ) : null}
                  </span>
                  {action.hint ? (
                    <CommandShortcut className="tracking-normal">
                      <Kbd>{action.hint}</Kbd>
                    </CommandShortcut>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
