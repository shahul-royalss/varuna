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

  it("says of every run-only shortcut that it needs a run, and of none that it is unbuilt", () => {
    render(<ShortcutsOverlay />);
    const runOnly = SHORTCUTS.filter((s) => s.availability === "run").length;
    expect(runOnly).toBeGreaterThan(0);

    // This used to assert that the two notes partitioned the set, because four of these keys -
    // R, I, 3 and W - were listed as shortcuts while nothing handled them, which is section 17's
    // dead control. P6.15 and P6.13 wired all four, so "coming in pilot" describes nothing on
    // this screen any more and a note that survives its own defect is the next lie. Every
    // run-only row now carries the same qualifier, and none carries the old one.
    expect(screen.getAllByText("Available once a run is loaded").length).toBe(runOnly);
    expect(screen.queryByText(/Coming in pilot/)).not.toBeInTheDocument();
  });

  it("renders nothing visible while closed", () => {
    useUiStore.setState({ shortcutsOpen: false });
    render(<ShortcutsOverlay />);
    expect(screen.queryByRole("heading", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });
});
