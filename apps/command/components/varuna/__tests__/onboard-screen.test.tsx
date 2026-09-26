import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { OnboardScreen, toSteps } from "@/app/onboard/onboard-screen";
import { ONBOARDING_STEP_IDS } from "@/components/varuna/onboarding-steps";
import type { OnboardJob } from "@/lib/api/onboard";

vi.mock("next/navigation", () => ({
  usePathname: () => "/onboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

/** A run id in the shape CLAUDE.md 10.3 gives, for a Chennai design-storm cycle. */
const CHENNAI_RUN = "CHN-SOUTH-20260910T0120Z-sky1.0-twin1.0-flash0.3-baked";

/** Chennai with no job in the API's memory. `built` is the only thing the tests vary. */
function job(overrides: Partial<OnboardJob> = {}): OnboardJob {
  return {
    jobId: null,
    city: "chennai",
    status: "none",
    step: "choose_area",
    progress: 0,
    startedAt: null,
    finishedAt: null,
    elapsedS: 0,
    logTail: [],
    firstRunId: null,
    error: null,
    built: false,
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Answers the onboard job endpoints with `current`, and - when `runId` is given - the two run
 * endpoints `loadRunDepth` reads, with an empty run (no steps, no wet streets) so the map stays on
 * its empty slot and never asks jsdom for WebGL. Everything else, the city layers included, 404s.
 *
 * Stubbing every test, the idle ones too, is deliberate: without it these tests dialled
 * `localhost:8000`, and on a machine where the API was up with Chennai built they were reading
 * that machine's Chennai rather than the case they name.
 */
function stubApi(current: OnboardJob, runId: string | null = null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost:8000");
    if (url.pathname.startsWith("/v1/onboard/")) {
      return json({
        job_id: current.jobId,
        city: current.city,
        status: current.status,
        step: current.step,
        progress: current.progress,
        started_at: current.startedAt,
        finished_at: current.finishedAt,
        elapsed_s: current.elapsedS,
        log_tail: current.logTail,
        first_run_id: current.firstRunId,
        error: current.error,
        built: current.built,
      });
    }
    if (runId && url.pathname === "/v1/nowcast/raster/bounds") {
      return json({
        // A named run is served as asked; `?city=` answers with that city's newest.
        run_id: url.searchParams.get("run_id") ?? runId,
        cycle_ts: "2026-09-10T01:20:00+00:00",
        mode: "baked",
        bundle: "CHN-IDF-25yr",
        n_steps: 0,
        step_min: 5,
        ensemble_n: 1,
        mass_balance_err: null,
        stage_ms: {},
        notes: [],
        bounds: { wgs84: [80.2, 12.96, 80.28, 13.05] },
      });
    }
    if (runId && url.pathname === "/v1/nowcast/segments") {
      return json({ valid_ts: [], n_segments_total: 0, depth_cm: {} });
    }
    return json({ error: { code: "not_found", message: "Not built." } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * How long to wait for anything behind the run lookup. The screen asks for the job, then for the
 * run, then parses it, and testing-library's default of one second lost that race in the full
 * suite with pytest running beside it, while the same file alone passed in 15 s (2026-09-26).
 */
const LOADED = { timeout: 5_000 };

/** Let the job request, its JSON parse and the state update after it all land. */
async function settle(fetchMock: ReturnType<typeof stubApi>) {
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/v1/onboard/city/chennai")),
    ).toBe(true),
  );
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function renderOnboard() {
  return render(
    <TooltipProvider>
      <OnboardScreen />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  stubApi(job());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("keeps an unbuilt city waiting once the API has answered", async () => {
    const fetchMock = stubApi(job({ built: false }));
    renderOnboard();
    await settle(fetchMock);

    expect(screen.getAllByText(/Waiting · 0 s/)).toHaveLength(ONBOARDING_STEP_IDS.length);
    expect(screen.queryByText("Already built")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Chennai console" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Open Chennai console" })).not.toBeInTheDocument();
  });
});

describe("toSteps", () => {
  it("reads no job at all as six idle steps", () => {
    expect(toSteps(null).map((step) => step.status)).toEqual(
      ONBOARDING_STEP_IDS.map(() => "waiting"),
    );
  });

  it("reads an unbuilt city with no job as waiting", () => {
    expect(toSteps(job({ built: false })).map((step) => step.status)).toEqual(
      ONBOARDING_STEP_IDS.map(() => "waiting"),
    );
  });

  it("reads a built city with a run as built, with no time it did not spend", () => {
    const steps = toSteps(job({ built: true }), true);
    expect(steps.map((step) => step.id)).toEqual([...ONBOARDING_STEP_IDS]);
    expect(steps.every((step) => step.status === "cached")).toBe(true);
    expect(steps.every((step) => step.progress === 100 && step.elapsedS === 0)).toBe(true);
  });

  /**
   * `built` is only `city/<city>/segments.parquet` existing (services/api onboard router), which
   * says nothing about a forecast. The deployed API answered `{status: none, built: true}` for
   * Chennai with 404 `no_baked_runs` on every run endpoint, so the forecast row must not claim one.
   */
  it("keeps the first forecast waiting for a built city with no run", () => {
    for (const steps of [toSteps(job({ built: true })), toSteps(job({ built: true }), false)]) {
      expect(steps.map((step) => step.status)).toEqual([
        "cached",
        "cached",
        "cached",
        "cached",
        "cached",
        "waiting",
      ]);
      expect(steps[5]).toEqual({ id: "forecast", progress: 0, elapsedS: 0, status: "waiting" });
    }
  });

  it("follows a rebuild of a built city rather than calling it cached", () => {
    const steps = toSteps(
      job({
        built: true,
        jobId: "job-1",
        status: "running",
        step: "infer_drains",
        progress: 0.5,
        elapsedS: 21,
      }),
    );
    expect(steps.map((step) => step.status)).toEqual([
      "done",
      "done",
      "done",
      "running",
      "waiting",
      "waiting",
    ]);
    expect(steps[3].elapsedS).toBe(21);
  });
});

describe("OnboardScreen, on a laptop where Chennai is already built (D-21)", () => {
  it("reads every step as already built once a run for it is read, with no elapsed time", async () => {
    stubApi(job({ built: true }), CHENNAI_RUN);
    renderOnboard();

    // The first five rows read "Already built" as soon as the job answers; the sixth only once
    // the run has loaded, so wait for all six rather than the first match.
    await waitFor(
      () => expect(screen.getAllByText("Already built")).toHaveLength(ONBOARDING_STEP_IDS.length),
      LOADED,
    );
    expect(screen.queryByText(/Waiting/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Already built ·/)).not.toBeInTheDocument();
    expect(screen.getByText(/These six steps ran before this session/)).toBeInTheDocument();
    // The city is on the server when deployed, not the visitor's machine.
    expect(screen.queryByText(/on this machine/)).not.toBeInTheDocument();
  });

  it("names and links the newest Chennai run the map has loaded", async () => {
    stubApi(job({ built: true }), CHENNAI_RUN);
    renderOnboard();

    const link = await screen.findByRole("link", { name: "Open Chennai console" }, LOADED);
    await waitFor(
      () =>
        expect(link).toHaveAttribute(
          "href",
          `/console?city=chennai&run=${encodeURIComponent(CHENNAI_RUN)}`,
        ),
      LOADED,
    );
    expect(screen.getByText(CHENNAI_RUN)).toBeInTheDocument();
    expect(screen.getByText(/Newest Chennai run/)).toHaveTextContent(
      `Newest Chennai run ${CHENNAI_RUN}, built before this session.`,
    );
    // No build time is printed for a build this session did not run.
    expect(screen.queryByText(/built in/)).not.toBeInTheDocument();
  });

  /**
   * The deployed API's state on 2026-09-26: Chennai's layers built, no run served. This test used
   * to assert the opposite - an enabled link to a console with no Chennai run in it, and six rows
   * of "Already built" for a forecast that did not exist.
   */
  it("keeps the forecast waiting and the console dim when a built city has no run", async () => {
    const fetchMock = stubApi(job({ built: true }));
    renderOnboard();

    // Wait for the run lookup to be answered, not just for the job: until the 404 lands the
    // screen does not yet know there is no run.
    expect(
      await screen.findByText(/serves no forecast for it yet/, {}, LOADED),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/v1/nowcast/raster/bounds?city=chennai"),
      ),
    ).toBe(true);

    const rows = within(screen.getByRole("list", { name: "Onboarding steps" })).getAllByRole(
      "listitem",
    );
    expect(rows).toHaveLength(ONBOARDING_STEP_IDS.length);
    for (const row of rows.slice(0, 5)) expect(row).toHaveTextContent("Already built");
    expect(rows[5]).toHaveTextContent("First forecast");
    expect(rows[5]).toHaveTextContent("Waiting · 0 s");
    expect(rows[5]).not.toHaveTextContent("Already built");

    expect(screen.getByRole("button", { name: "Open Chennai console" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Open Chennai console" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Newest Chennai run/)).not.toBeInTheDocument();
    expect(screen.queryByText(/These six steps ran/)).not.toBeInTheDocument();
    expect(screen.queryByText(/on this machine/)).not.toBeInTheDocument();
  });

  it("keeps a finished build's own first run and its build time", async () => {
    stubApi(
      job({
        built: true,
        status: "finished",
        jobId: "job-9",
        firstRunId: CHENNAI_RUN,
        elapsedS: 65.4,
      }),
      CHENNAI_RUN,
    );
    renderOnboard();

    const link = await screen.findByRole("link", { name: "Open Chennai console" }, LOADED);
    expect(link).toHaveAttribute(
      "href",
      `/console?city=chennai&run=${encodeURIComponent(CHENNAI_RUN)}`,
    );
    expect(screen.getByText(/First run/)).toHaveTextContent(
      `First run ${CHENNAI_RUN}, built in 65 s.`,
    );
    // Built in front of the operator, so the rows are done, not "already built".
    expect(screen.queryByText("Already built")).not.toBeInTheDocument();
    expect(screen.queryByText(/Newest Chennai run/)).not.toBeInTheDocument();
  });

  it("keeps the console button dim while a built city is being rebuilt", async () => {
    const fetchMock = stubApi(
      job({ built: true, jobId: "job-2", status: "running", step: "condition_terrain" }),
    );
    renderOnboard();
    await settle(fetchMock);

    expect(await screen.findByText(/Running ·/, {}, LOADED)).toBeInTheDocument();
    expect(screen.queryByText("Already built")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Chennai console" })).toBeDisabled();
  });
});
