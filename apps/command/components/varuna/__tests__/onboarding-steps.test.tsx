import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  IDLE_ONBOARDING_STEPS,
  ONBOARDING_STEP_IDS,
  OnboardingSteps,
  STEP_STATUS_LABELS,
  type OnboardingStepState,
} from "@/components/varuna/onboarding-steps";

describe("OnboardingSteps", () => {
  it("prints a waiting step with its elapsed time", () => {
    render(<OnboardingSteps steps={IDLE_ONBOARDING_STEPS} />);
    expect(screen.getAllByText("Waiting · 0 s")).toHaveLength(ONBOARDING_STEP_IDS.length);
  });

  it("prints an already-built step with its own label and no elapsed time", () => {
    const steps: OnboardingStepState[] = ONBOARDING_STEP_IDS.map((id) => ({
      id,
      progress: 100,
      elapsedS: 0,
      status: "cached",
    }));
    render(<OnboardingSteps steps={steps} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(ONBOARDING_STEP_IDS.length);
    for (const row of rows) {
      const status = within(row).getByText(STEP_STATUS_LABELS.cached);
      // Exactly the label: no " · 0 s" for time this session never spent.
      expect(status.textContent).toBe("Already built");
      // Its own icon, not the waiting circle or the done tick. Lucide's `History` is an alias
      // and renders with its canonical name's class.
      expect(row.querySelector("svg.lucide-rotate-ccw-clock")).not.toBeNull();
      expect(row.querySelector("svg.lucide-circle-dashed")).toBeNull();
      expect(row.querySelector("svg.lucide-check")).toBeNull();
      // Not the running step, so no row claims to be the current one.
      expect(row).not.toHaveAttribute("aria-current");
    }
  });

  it("keeps the other statuses' time beside their label", () => {
    render(
      <OnboardingSteps
        steps={[
          { id: "area", progress: 100, elapsedS: 0, status: "done" },
          { id: "fetch", progress: 40, elapsedS: 12, status: "running" },
          { id: "condition", progress: 0, elapsedS: 0, status: "waiting" },
        ]}
      />,
    );
    expect(screen.getByText("Done · 0 s")).toBeInTheDocument();
    expect(screen.getByText("Running · 12 s")).toBeInTheDocument();
    expect(screen.getByText("Waiting · 0 s")).toBeInTheDocument();
  });
});
