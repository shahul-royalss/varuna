import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("offers both the emulator and the physics check", () => {
    renderScreen();

    // Flash-lite landed in Phase 7, so this one runs: about 60 ms against a baked run.
    expect(screen.getByRole("button", { name: "Run what-if" })).toBeEnabled();
    // And so does the check since P7.8: two Twin runs on a 990 m window, 2.4-4.7 s warm.
    const physics = screen.getByRole("button", { name: "Physics check" });
    expect(physics).toBeEnabled();
    expect(physics).not.toHaveAttribute("aria-describedby");
  });

  it("prints the endpoint's disagreement, the Twin's change beside the emulator's", async () => {
    // The shape `POST /v1/whatif/physics-check` returns, trimmed to what the panel reads, with the
    // 2 July 08:40 figures measured at Bandra Talao on rain +30 %.
    const body = {
      run_id: "MUM-20190702T0310Z-sky1.0-twin1.0-flash0.1-baked",
      summary: "Emulator vs physics: max difference 5.1 cm at Bandra Talao",
      tolerance_cm: 5,
      agrees: false,
      max_diff_cm: 5.07,
      max_diff_hotspot: "Bandra Talao",
      hotspots: [
        {
          hotspot_id: "MUM-HS-20",
          name: "Bandra Talao",
          emulator_delta_cm: 1.2,
          twin_delta_cm: 6.27,
          diff_cm: 5.07,
        },
      ],
      hotspots_outside_window: ["Hindmata junction"],
      window: { size_m: 990, nodes: 631, edges: 620, centre_hotspot: "Bandra Talao" },
      mass_balance: { baseline: 0, scenario: 0, budget: 0.001 },
      ms: 4320,
      budget_ms: 10000,
      notes: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/whatif/physics-check")) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify({ features: [], runs: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      renderScreen();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Physics check" }));
      });
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/v1/whatif/physics-check")),
      ).toBe(true);
      // One decimal beside a 5 cm tolerance: "5 cm" next to "Outside tolerance" would read as
      // a contradiction.
      expect(await screen.findByText("Outside tolerance")).toBeInTheDocument();
      expect(screen.getAllByText("5.1 cm").length).toBeGreaterThan(0);
      expect(screen.getByText("+6.3 cm")).toBeInTheDocument();
      expect(
        screen.getByText(/Not in the window, so not checked: Hindmata junction/),
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("disables the two levers the request does not carry, and leaves them out of the scenario line", () => {
    renderScreen();

    // Cleaning itself is a lever now - segments picked on a hotspot are sent and cleaned - but
    // *ranking* pipes by beta is not, because nothing attributes a junction's depth to pipes on
    // an element-wise emulator (ADR-0042); and there is no pump-plan field at all. Both switches
    // say what is missing rather than sitting inert (section 17).
    for (const [name, reason] of [
      ["Clean top 14 by beta", "Pipes are ranked per junction, in the hotspot's drawer"],
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
    // The physics check answers now (P7.8), so its empty state is the ordinary "not run yet"
    // and the button that runs it is live rather than disabled with a reason.
    expect(screen.getByText("Physics check not run")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Physics check" })).toBeEnabled();
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

  it("tells the lab about a change from the handler, never while the controls render", () => {
    // `WhatIfControls` used to call `onChange` inside its state updater. React runs an updater
    // while it renders the component that owns it, and the lab's `onChange` is its own setter,
    // so the lab was updated mid-render: "Cannot update a component while rendering a different
    // component". The first change of a batch escapes because React computes it eagerly; the
    // second is the one that runs in render, so two removals in one act is the reproduction.
    nav.params = new URLSearchParams({
      segments: "S100841069-000,S100841079-000,S102172139-001",
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      renderScreen();
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Remove segment S100841069-000" }));
        fireEvent.click(screen.getByRole("button", { name: "Remove segment S100841079-000" }));
      });

      expect(errors.mock.calls.flat().map(String).join("\n")).not.toMatch(
        /while rendering a different component/,
      );
      // Both removals land: the second composes on the first rather than restoring its segment
      // from the render both buttons were drawn in. The lab's scenario line agrees with the chips.
      expect(screen.getByText("1 segment")).toBeInTheDocument();
      expect(screen.queryByText("S100841069-000")).not.toBeInTheDocument();
      expect(screen.getByText(/^Scenario ready to run:/)).toHaveTextContent(
        "Rain 1.0x, tide +0.0 m, 1 segment cleaned.",
      );
    } finally {
      errors.mockRestore();
    }
  });
});
