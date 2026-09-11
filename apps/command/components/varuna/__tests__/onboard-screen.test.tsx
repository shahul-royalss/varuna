import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { OnboardScreen } from "@/app/onboard/onboard-screen";
import { ONBOARDING_STEP_IDS } from "@/components/varuna/onboarding-steps";

vi.mock("next/navigation", () => ({
  usePathname: () => "/onboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

function renderOnboard() {
  return render(
    <TooltipProvider>
      <OnboardScreen />
    </TooltipProvider>,
  );
}

describe("OnboardScreen", () => {
  it("lists the six wizard steps, all idle", () => {
    renderOnboard();
    const steps = screen.getByRole("list", { name: "Onboarding steps" });
    expect(steps.querySelectorAll("li")).toHaveLength(ONBOARDING_STEP_IDS.length);
    expect(screen.getByText("Choose area")).toBeInTheDocument();
    expect(screen.getByText("First forecast")).toBeInTheDocument();
    expect(screen.getAllByText(/Waiting · 0 s/)).toHaveLength(ONBOARDING_STEP_IDS.length);
  });

  /**
   * This assertion used to be the opposite: the button was disabled and a note beside it read
   * "The wizard runs from city/cache/chennai in Phase 9." P9.6 landed on 2026-09-10 and made the
   * wizard real, but this test kept asserting the placeholder, so it had been failing ever since -
   * the one test guarding this screen was guarding a screen that no longer existed.
   */
  it("offers a live start button, because the wizard runs for real now", () => {
    renderOnboard();
    const start = screen.getByRole("button", { name: "Start onboarding Chennai" });
    expect(start).toBeEnabled();
    expect(start).toHaveAttribute("aria-busy", "false");
  });

  it("shows the honest empty states until a build has run", () => {
    renderOnboard();
    expect(screen.getByText(/No logs yet/)).toBeInTheDocument();
    expect(screen.getByText(/First forecast, uncalibrated/)).toBeInTheDocument();
    // "Open Chennai console" stays on screen and disabled rather than appearing on success:
    // a control that materialises is harder to find on stage than one that lights up.
    expect(screen.getByRole("button", { name: "Open Chennai console" })).toBeDisabled();
  });
});
