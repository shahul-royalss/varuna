import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { TimeBar } from "@/components/varuna/time-bar";
import { useReplayStore } from "@/lib/stores/replay";
import { useRunStore } from "@/lib/stores/run";

function renderTimeBar() {
  return render(
    <TooltipProvider>
      <TimeBar />
    </TooltipProvider>,
  );
}

/**
 * Base UI renders the thumb with a visually hidden `input[type=range]` (excluded from role queries);
 * read it directly and prefer aria-valuenow, then the input value.
 */
function sliderValue(): string | null {
  const thumb = document.querySelector('[data-slot="slider-thumb"]');
  const input = thumb?.querySelector<HTMLInputElement>("input") ?? null;
  const el = input ?? thumb ?? document.querySelector('[data-slot="slider"] input');
  if (!el) return null;
  return el.getAttribute("aria-valuenow") ?? (el as HTMLInputElement).value ?? null;
}

describe("TimeBar", () => {
  beforeEach(() => {
    useReplayStore.getState().reset();
    useRunStore.getState().clear();
  });

  it("renders the valid time and lead at the default scrub position", () => {
    renderTimeBar();
    expect(screen.getByText("06:40 (+0 min)")).toBeInTheDocument();
    expect(screen.getByText("Ensemble spread appears with the first run")).toBeInTheDocument();
  });

  it("reflects leadMin on the slider and the label after setLeadMin(45)", () => {
    renderTimeBar();
    act(() => {
      useReplayStore.getState().setLeadMin(45);
    });
    expect(sliderValue()).toBe("45");
    expect(screen.getByText("07:25 (+45 min)")).toBeInTheDocument();
  });

  it("toggles playing from the play button even without a run", () => {
    renderTimeBar();
    const play = screen.getByRole("button", { name: "Play the replay" });
    expect(play).toHaveAttribute("aria-disabled", "true");
    act(() => {
      play.click();
    });
    expect(useReplayStore.getState().playing).toBe(true);
    expect(screen.getByRole("button", { name: "Pause the replay" })).toBeInTheDocument();
  });

  it("keeps Compute live disabled until a bundle is loaded", () => {
    renderTimeBar();
    expect(screen.getByRole("button", { name: "Compute live" })).toBeDisabled();
  });
});
