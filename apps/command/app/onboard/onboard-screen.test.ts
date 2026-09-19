/**
 * The two decisions the wizard makes that are worth pinning (task D-21): where the finish card
 * lands, and how far the build has got - which is what decides when each map layer is asked for.
 */

import { describe, expect, it } from "vitest";

import type { OnboardJob } from "@/lib/api/onboard";
import { consoleHref, reachedStepIndex } from "./onboard-screen";

const RUN = "CHN-20260701T0120Z-sky1.0-twin1.0-flash0.0-baked";

function job(over: Partial<OnboardJob>): OnboardJob {
  return {
    jobId: "job-1",
    city: "chennai",
    status: "running",
    step: "choose_area",
    progress: 0,
    startedAt: null,
    finishedAt: null,
    elapsedS: 0,
    logTail: [],
    firstRunId: null,
    error: null,
    built: false,
    ...over,
  };
}

describe("consoleHref", () => {
  it("lands on a Chennai console showing this build's own first run", () => {
    expect(consoleHref("chennai", RUN)).toBe(`/console?city=chennai&run=${RUN}`);
  });

  it("still names the city when the build produced no run to name", () => {
    expect(consoleHref("chennai", null)).toBe("/console?city=chennai");
  });
});

describe("reachedStepIndex", () => {
  it("is -1 before a build has started, so no layer is asked for", () => {
    expect(reachedStepIndex(null)).toBe(-1);
    expect(reachedStepIndex(job({ status: "none" }))).toBe(-1);
  });

  it("counts only the steps that have finished, not the one running", () => {
    // Running "Fetch open data" (index 1) means only "Choose area" has written anything.
    expect(reachedStepIndex(job({ step: "fetch_open_data" }))).toBe(1);
    expect(reachedStepIndex(job({ step: "infer_drains" }))).toBe(3);
  });

  it("counts a finished or already-built city as past every step", () => {
    expect(reachedStepIndex(job({ status: "finished", step: "first_forecast" }))).toBe(6);
    // A city built in an earlier session reports no job at all - jobs do not outlive the API
    // process - and its layers are still on disk, so the map must draw them.
    expect(reachedStepIndex(job({ status: "none", built: true, jobId: null }))).toBe(6);
  });
});
