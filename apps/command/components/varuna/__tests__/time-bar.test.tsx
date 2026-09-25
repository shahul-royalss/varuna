import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TimeBar } from "@/components/varuna/time-bar";
import { renderWithProviders, stubFetch } from "@/lib/test-utils";
import { useReplayStore } from "@/lib/stores/replay";
import { useRunStore } from "@/lib/stores/run";

const T0 = "2019-07-02T05:40:00+05:30";
const CLOCK = {
  bundle_id: "MUM-2019-07-02",
  sim_time: "2019-07-02T06:40:00+05:30",
  playing: false,
  speed: 30,
  t0: T0,
  t1: "2019-07-02T09:40:00+05:30",
  cycle_index: 12,
  n_cycles: 49,
  mode: "baked",
  last_run_id: null,
  next_cycle_ts: "2019-07-02T06:45:00+05:30",
  note: null,
  progress: 0.25,
};

/** No API in jsdom by default: every replay request answers 404, as it would with no bundle. */
function renderTimeBar() {
  return renderWithProviders(<TimeBar />);
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
    vi.stubGlobal("fetch", vi.fn(stubFetch({})));
    useReplayStore.getState().reset();
    useRunStore.getState().clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the valid time and lead at the default scrub position", () => {
    renderTimeBar();
    expect(screen.getByText("06:40 (+0 min)")).toBeInTheDocument();
    expect(screen.getByText("Ensemble spread appears with the first run")).toBeInTheDocument();
  });

  it("draws the ensemble's spread under the track once a run carries one (7.2)", () => {
    // Three steps, widest at +10 min: the label names the widest point in the run's own numbers.
    act(() => {
      useRunStore.getState().setRun({
        run_id: "MUM-20190702T0310Z-sky1.0-twin1.0-flash0.1-baked",
        city: "mumbai",
        cycle_ts: "2019-07-02T08:40:00+05:30",
        mode: "replay",
        replay_mode: "baked",
        ensemble_n: 50,
        step_min: 5,
        aoi_depth_band: { p10: [1.0, 1.2, 1.5], p50: [1.2, 1.6, 1.8], p90: [1.4, 2.4, 2.1] },
      });
    });
    renderTimeBar();
    expect(
      screen.getByRole("img", {
        name: "Ensemble spread of mean street depth, p10 to p90: widest 1.2 cm, at +5 min",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Ensemble spread appears/)).not.toBeInTheDocument();
  });

  it("says a loaded run has no spread rather than promising one later", () => {
    act(() => {
      useRunStore.getState().setRun({
        run_id: "MUM-20190702T0310Z-sky1.0-twin1.0-flash0.0-baked",
        city: "mumbai",
        cycle_ts: "2019-07-02T08:40:00+05:30",
        mode: "replay",
        replay_mode: "baked",
        ensemble_n: 1,
      });
    });
    renderTimeBar();
    expect(screen.getByText("This run has no ensemble spread to draw")).toBeInTheDocument();
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

  it("asks the API to play once the clock is available", async () => {
    const fetchMock = vi.fn(
      stubFetch({ "/v1/replay/clock": CLOCK, "/v1/replay/play": { ...CLOCK, playing: true } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderTimeBar();

    // The clock the API reports becomes the store's clock.
    await waitFor(() => expect(useReplayStore.getState().cycleIndex).toBe(12));

    act(() => {
      screen.getByRole("button", { name: "Play the replay" }).click();
    });
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/v1/replay/play"));
      expect(posted).toBeDefined();
      expect(posted?.[1]?.method).toBe("POST");
    });
    expect(useReplayStore.getState().playing).toBe(true);
  });
});
