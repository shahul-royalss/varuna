import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { WhatIfScreen } from "@/app/whatif/whatif-screen";
import { useRunStore } from "@/lib/stores/run";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("next/navigation", () => ({
  usePathname: () => "/whatif",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

function renderScreen() {
  return render(
    <TooltipProvider>
      <WhatIfScreen />
    </TooltipProvider>,
  );
}

describe("WhatIfScreen", () => {
  beforeEach(() => {
    useRunStore.getState().clear();
    useUiStore.getState().closeOverlays();
  });

  it("labels the emulator honestly", () => {
    renderScreen();
    expect(screen.getByRole("heading", { level: 1, name: "What-if lab" })).toBeInTheDocument();
    expect(
      screen.getByText("Reduced-order emulator calibrated to VARUNA-Twin"),
    ).toBeInTheDocument();
  });

  it("disables both actions and says when each starts working", () => {
    renderScreen();

    const run = screen.getByRole("button", { name: "Run what-if" });
    expect(run).toBeDisabled();
    const runHelpId = run.getAttribute("aria-describedby");
    expect(runHelpId).toBeTruthy();
    expect(document.getElementById(runHelpId as string)).toHaveTextContent(
      "The emulator lands in Phase 7",
    );

    const physics = screen.getByRole("button", { name: "Physics check" });
    expect(physics).toBeDisabled();
    const physicsHelpId = physics.getAttribute("aria-describedby");
    expect(physicsHelpId).toBeTruthy();
    expect(document.getElementById(physicsHelpId as string)).toHaveTextContent(
      "Runs the Twin on the same scenario once Phase 7 lands",
    );
  });

  it("holds the result panels in their empty states until a what-if has run", () => {
    renderScreen();
    expect(screen.getByText("No what-if yet")).toBeInTheDocument();
    expect(screen.getByText("Set the controls and run one.")).toBeInTheDocument();
    expect(screen.getByText("Physics check not run")).toBeInTheDocument();
  });
});
