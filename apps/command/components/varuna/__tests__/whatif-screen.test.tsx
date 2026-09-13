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

  it("offers the emulator and still says why the physics check is not wired", () => {
    renderScreen();

    // Flash-lite landed in Phase 7, so this one runs: about 60 ms against a baked run.
    expect(screen.getByRole("button", { name: "Run what-if" })).toBeEnabled();

    // The physics check has not: a Twin run on this city is about three minutes, well outside
    // the 10 s CLAUDE.md 14 budgets for it, so the control says so rather than hanging.
    const physics = screen.getByRole("button", { name: "Physics check" });
    expect(physics).toBeDisabled();
    const physicsHelpId = physics.getAttribute("aria-describedby");
    expect(physicsHelpId).toBeTruthy();
    expect(document.getElementById(physicsHelpId as string)).toHaveTextContent(
      "Runs the Twin on the same scenario",
    );
  });

  it("disables the two levers the request does not carry, and leaves them out of the scenario line", () => {
    renderScreen();

    // The request body is rain and tide only: cleaning needs pipe ids the console cannot resolve
    // yet, and there is no pump-plan field. Both switches say what is missing (section 17).
    for (const [name, reason] of [
      ["Clean top 14 by beta", "the pipe-to-street join lands with attribution (P7.7)"],
      ["Pump plan", "The pump plan is not a what-if lever yet (P7.7)"],
    ]) {
      // Base UI renders a disabled switch as a span with aria-disabled rather than a form
      // element, so jest-dom's toBeDisabled does not apply; the announced state is the assertion.
      const lever = screen.getByRole("switch", { name });
      expect(lever).toHaveAttribute("aria-disabled", "true");
      const helpId = lever.getAttribute("aria-describedby");
      expect(helpId).toBeTruthy();
      expect(document.getElementById(helpId as string)).toHaveTextContent(reason);
    }

    // The pre-run line named both switches while sending neither; it now names only the levers.
    expect(screen.getByText(/^Scenario ready to run:/)).toHaveTextContent(
      "Scenario ready to run: Rain 1.0x, tide +0.0 m.",
    );
    expect(screen.queryByText(/pipes cleaned/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pump plan on/)).not.toBeInTheDocument();
  });

  it("holds the result panels in their empty states until a what-if has run", () => {
    renderScreen();
    expect(screen.getByText("No what-if yet")).toBeInTheDocument();
    expect(screen.getByText("Set the controls and run one.")).toBeInTheDocument();
    // Not "not run" - the button cannot work. `POST /v1/whatif/physics-check` answers 501 and
    // the Twin it would re-run measures 137-174 s against section 14's 10 s budget, so an
    // empty state reading "you have not pressed it yet" would blame the operator for a
    // refusal the system owes them a reason for (section 17, ADR-0042).
    expect(screen.getByText("Physics check not available")).toBeInTheDocument();
  });
});
