import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { groupShortcuts, ShortcutsOverlay } from "@/components/varuna/shortcuts-overlay";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/stores/ui";

describe("groupShortcuts", () => {
  it("keeps groups in order of first appearance and loses no shortcut", () => {
    const groups = groupShortcuts();
    expect(groups.map((g) => g.name)).toEqual(["Replay", "Layers", "Panels", "Navigation"]);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(SHORTCUTS.length);
  });
});

describe("ShortcutsOverlay", () => {
  beforeEach(() => {
    useUiStore.setState({ shortcutsOpen: true });
  });

  it("lists every shortcut group with its keys", () => {
    render(<ShortcutsOverlay />);
    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    for (const group of groupShortcuts()) {
      expect(screen.getByRole("heading", { name: group.name })).toBeInTheDocument();
    }
    for (const shortcut of SHORTCUTS) {
      // "Keyboard shortcuts" is both the dialog title and the "?" shortcut's label.
      expect(screen.getAllByText(shortcut.label).length).toBeGreaterThan(0);
      for (const key of shortcut.keys) {
        expect(screen.getAllByText(key).length).toBeGreaterThan(0);
      }
    }
  });

  it("marks run-only shortcuts as available once a run is loaded", () => {
    render(<ShortcutsOverlay />);
    const runOnly = SHORTCUTS.filter((s) => s.availability === "run").length;
    expect(runOnly).toBeGreaterThan(0);
    expect(screen.getAllByText("Available once a run is loaded")).toHaveLength(runOnly);
  });

  it("renders nothing visible while closed", () => {
    useUiStore.setState({ shortcutsOpen: false });
    render(<ShortcutsOverlay />);
    expect(screen.queryByRole("heading", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });
});
