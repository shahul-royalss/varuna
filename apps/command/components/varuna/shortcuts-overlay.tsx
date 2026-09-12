"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/varuna/kbd";
import { type Shortcut, type ShortcutGroup, SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/stores/ui";

interface GroupedShortcuts {
  name: ShortcutGroup;
  items: Shortcut[];
}

/** Groups in order of first appearance in SHORTCUTS (Replay, Layers, Panels, Navigation). */
export function groupShortcuts(shortcuts: readonly Shortcut[] = SHORTCUTS): GroupedShortcuts[] {
  const groups: GroupedShortcuts[] = [];
  for (const shortcut of shortcuts) {
    let group = groups.find((g) => g.name === shortcut.group);
    if (!group) {
      group = { name: shortcut.group, items: [] };
      groups.push(group);
    }
    group.items.push(shortcut);
  }
  return groups;
}

const RUN_NOTE = "Available once a run is loaded";

/**
 * Layer keys the console has not wired yet, and the task that wires each.
 *
 * CLAUDE.md 17: "Every P1 button reads 'coming in pilot' with one sentence of plan - never a
 * dead control." A key is a control. These four were listed here as working shortcuts while
 * nothing anywhere handled them, which is the same defect as a dead button and harder to
 * notice, because a key that does nothing looks identical to a key you pressed wrong.
 */
const NOT_WIRED: Record<string, string> = {
  routes: "Routes draw on /route; the console layer is P6 work still open",
  isochrones: "Isochrones draw on the reachability tab, not yet as a console layer",
  "3d": "3D terrain is P6.15, a pilot upgrade",
  whatif: "The what-if drawer is P7.10; /whatif has the lab today",
};

/** The "?" overlay: every shortcut from CLAUDE.md section 7.2, grouped, with key caps. */
export function ShortcutsOverlay() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);
  const groups = groupShortcuts();

  return (
    <Dialog open={open} onOpenChange={(next) => setOpen(next)}>
      <DialogContent className="motion-reduce:animate-none sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts work anywhere on the console except inside a text field. Press Esc to close.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {groups.map((group) => {
            const headingId = `shortcuts-${group.name.toLowerCase()}`;
            return (
              <section key={group.name} aria-labelledby={headingId}>
                <h3 id={headingId} className="mb-1 type-small font-medium text-text-2">
                  {group.name}
                </h3>
                <ul className="flex flex-col">
                  {group.items.map((shortcut) => (
                    <li
                      key={shortcut.id}
                      className="flex min-h-10 items-center justify-between gap-4 border-b border-line py-1.5 last:border-b-0"
                    >
                      <span className="flex flex-col">
                        <span
                          className={
                            NOT_WIRED[shortcut.id] ? "type-body text-text-3" : "type-body text-text"
                          }
                        >
                          {shortcut.label}
                        </span>
                        {NOT_WIRED[shortcut.id] ? (
                          <span className="type-micro text-text-3">
                            Coming in pilot. {NOT_WIRED[shortcut.id]}.
                          </span>
                        ) : shortcut.availability === "run" ? (
                          <span className="type-micro text-text-3">{RUN_NOTE}</span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {shortcut.keys.map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
