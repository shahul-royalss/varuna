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

  it("keeps the start button present but disabled, with the reason next to it", () => {
    renderOnboard();
    expect(screen.getByRole("button", { name: "Start onboarding Chennai" })).toBeDisabled();
    expect(
      screen.getByText("The wizard runs from city/cache/chennai in Phase 9."),
    ).toBeInTheDocument();
    expect(screen.getByText(/No logs yet/)).toBeInTheDocument();
    expect(screen.getByText(/First forecast, uncalibrated/)).toBeInTheDocument();
  });
});
