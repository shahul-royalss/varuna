import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { WhatIfScreen } from "@/app/whatif/whatif-screen";
import { useRunStore } from "@/lib/stores/run";
import { useUiStore } from "@/lib/stores/ui";

/** The query string the lab reads at mount (P7.11). Set it before `renderScreen`. */
const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/whatif",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => nav.params,
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
    nav.params = new URLSearchParams();
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

    // Cleaning itself is a lever now - segments picked on a hotspot are sent and cleaned - but
    // *ranking* pipes by beta is not, because nothing attributes a junction's depth to pipes on
    // an element-wise emulator (ADR-0042); and there is no pump-plan field at all. Both switches
    // say what is missing rather than sitting inert (section 17).
    for (const [name, reason] of [
      ["Clean top 14 by beta", "Ranking pipes by beta needs attribution"],
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
    // the Twin it would re-run measures 58-114 s against section 14's 10 s budget, so an
    // empty state reading "you have not pressed it yet" would blame the operator for a
    // refusal the system owes them a reason for (section 17, ADR-0042).
    expect(screen.getByText("Physics check not available")).toBeInTheDocument();
  });

  it("carries a hotspot's segments in from the deep link, with the measured ceiling beside them", () => {
    // What "Clean in what-if" on Hindmata puts in the address bar: the junction's own road
    // segments, the junction it was pressed on, and the cycle the console was showing.
    nav.params = new URLSearchParams({
      segments: "S100841069-000,S100841079-000,S102172139-001",
      from: "Hindmata junction",
      run: "MUM-20190702T0310Z-sky1.0-twin1.0-flash0.1-baked",
    });
    renderScreen();

    expect(screen.getByText("S100841069-000")).toBeInTheDocument();
    expect(screen.getByText("S102172139-001")).toBeInTheDocument();
    expect(screen.getByText("3 segments")).toBeInTheDocument();
    expect(screen.getByText("From Hindmata junction.")).toBeInTheDocument();
    // The chips are a lever with a ceiling, and the ceiling is measured (ADR-0042). Printing the
    // segments without it would let the operator expect a junction to drain.
    expect(screen.getByText(/Measured ceiling/)).toHaveTextContent(
      "cleaning all 21,296 segments at once moves the deepest street 3.5 cm (ADR-0042)",
    );
    // The scenario line counts what will be sent, so the panel and the request agree.
    expect(screen.getByText(/^Scenario ready to run:/)).toHaveTextContent(
      "Rain 1.0x, tide +0.0 m, 3 segments cleaned.",
    );
  });

  it("says so when the link asks for more segments than the lever carries", () => {
    // The URL is hand-editable, so a longer list is possible; silently running a smaller
    // scenario than the address bar describes is the defect this line exists to prevent.
    const ids = Array.from({ length: 20 }, (_, i) => `S1008410${String(i).padStart(2, "0")}-000`);
    nav.params = new URLSearchParams({ segments: ids.join(",") });
    renderScreen();

    expect(screen.getByText("14 segments")).toBeInTheDocument();
    expect(screen.getByText(/The link asked for/)).toHaveTextContent(
      "The link asked for 20 segments; the first 14 are loaded.",
    );
  });
});
