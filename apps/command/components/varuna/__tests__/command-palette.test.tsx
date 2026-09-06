import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "@/components/varuna/command-palette";
import { NAV_ITEMS, PALETTE_ACTIONS } from "@/lib/nav";
import { type RunMeta, useRunStore } from "@/lib/stores/run";
import { useUiStore } from "@/lib/stores/ui";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

// jsdom has no scrollIntoView; cmdk calls it on the selected item.
Element.prototype.scrollIntoView = vi.fn();

const RUN: RunMeta = {
  run_id: "MUM-20190702T1210Z-sky1.0-twin1.0-flash0.3-baked",
  city: "mumbai",
  cycle_ts: "2019-07-02T06:40:00+05:30",
  mode: "replay",
  replay_mode: "baked",
};

function itemFor(label: string): HTMLElement {
  const item = screen.getByText(label).closest("[cmdk-item]");
  if (!(item instanceof HTMLElement)) throw new Error(`No palette item for "${label}"`);
  return item;
}

describe("CommandPalette", () => {
  beforeEach(() => {
    push.mockClear();
    useRunStore.getState().clear();
    useUiStore.setState({ commandPaletteOpen: true });
  });

  it("lists the nine screens with their keyboard hints", () => {
    render(<CommandPalette />);
    expect(NAV_ITEMS).toHaveLength(9);
    for (const item of NAV_ITEMS) {
      expect(itemFor(item.label)).toBeInTheDocument();
      expect(screen.getByText(item.hint)).toBeInTheDocument();
    }
    expect(screen.getByPlaceholderText("Jump to a screen, hotspot or action")).toBeInTheDocument();
  });

  it("disables run-only actions and shows the reason when there is no run", () => {
    render(<CommandPalette />);
    const runOnly = PALETTE_ACTIONS.filter((a) => a.needsRun);
    expect(runOnly.length).toBeGreaterThan(0);
    for (const action of runOnly) {
      expect(itemFor(action.label)).toHaveAttribute("aria-disabled", "true");
      if (action.disabledReason) {
        expect(screen.getAllByText(action.disabledReason).length).toBeGreaterThan(0);
      }
    }
    for (const action of PALETTE_ACTIONS.filter((a) => !a.needsRun)) {
      expect(itemFor(action.label)).not.toHaveAttribute("aria-disabled", "true");
    }
  });

  it("enables run-only actions once a run is loaded", () => {
    useRunStore.getState().setRun(RUN);
    render(<CommandPalette />);
    expect(itemFor("Copy run id")).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText("Available once a run is loaded")).not.toBeInTheDocument();
  });

  it("tells the operator what to do when there are no hotspots, and lists them when there are", () => {
    const { unmount } = render(<CommandPalette />);
    expect(screen.getByText("No hotspots yet — press Play on the replay")).toBeInTheDocument();
    unmount();

    render(<CommandPalette hotspots={[{ id: "hindmata", name: "Hindmata junction", depthCm: 55 }]} />);
    expect(itemFor("Hindmata junction")).toBeInTheDocument();
    expect(screen.getByText("55 cm")).toBeInTheDocument();
    expect(screen.queryByText("No hotspots yet — press Play on the replay")).not.toBeInTheDocument();
  });
});
