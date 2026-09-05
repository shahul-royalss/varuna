import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/varuna/app-shell";
import { useRunStore } from "@/lib/stores/run";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("next/navigation", () => ({
  usePathname: () => "/console",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

function renderShell(extra: { rightRail?: React.ReactNode; bottomBar?: React.ReactNode } = {}) {
  return render(
    <TooltipProvider>
      <AppShell {...extra}>
        <div>Map canvas</div>
      </AppShell>
    </TooltipProvider>,
  );
}

describe("AppShell", () => {
  beforeEach(() => {
    useRunStore.getState().clear();
    useUiStore.getState().closeOverlays();
  });

  it("renders the top bar, the rail and the children", () => {
    renderShell();
    expect(screen.getByText("Map canvas")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Screens" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "VARUNA console" })).toHaveAttribute("href", "/console");
    expect(screen.getByRole("status")).toHaveTextContent("No runs yet");
    expect(screen.getByText("No run")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch city" })).toHaveTextContent("Mumbai");
  });

  it("marks the current screen in the rail", () => {
    renderShell();
    const console = screen.getByRole("link", { name: "Console" });
    expect(console).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Drains" })).not.toHaveAttribute("aria-current");
    expect(screen.getAllByRole("link")).toHaveLength(10);
  });

  it("renders the optional right rail and bottom bar only when given", () => {
    const { unmount } = renderShell();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    unmount();

    renderShell({ rightRail: <div>Hotspots</div>, bottomBar: <div>Time bar</div> });
    expect(screen.getByRole("complementary", { name: "Right rail" })).toHaveTextContent("Hotspots");
    expect(screen.getByText("Time bar")).toBeInTheDocument();
  });

  it("wires the icon buttons to the ui store", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Search and commands" }));
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(useUiStore.getState().shortcutsOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });
});
