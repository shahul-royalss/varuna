import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AlertsScreen } from "@/app/alerts/alerts-screen";

vi.mock("next/navigation", () => ({
  usePathname: () => "/alerts",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const RUN_0640 = "MUM-20190702T0110Z-sky1.0-twin1.0-flash0.1-baked";
const RUN_0840 = "MUM-20190702T0310Z-sky1.0-twin1.0-flash0.1-baked";

function alert(run: string, street: string, code: string, level: string) {
  return {
    id: `VARUNA-${run.toUpperCase()}-STREET-${code}-${level.toUpperCase()}`,
    run_id: run,
    level,
    threshold_cm: level === "severe" ? 45 : 30,
    headline: `${street}: depth likely above ${level === "severe" ? 45 : 30} cm`,
    instruction: null,
    area_desc: street,
    scope: "segment",
    hotspot_id: null,
    raised_ts: run === RUN_0640 ? "2019-07-02T06:40:00+05:30" : "2019-07-02T08:40:00+05:30",
    persists_cycles: 3,
    persists_unit: "forecast step",
    trigger_p: 0.8,
  };
}

/** Two baked cycles: one street holds severe, one steps up from moderate, one is new. */
const QUEUES: Record<string, unknown[]> = {
  [RUN_0640]: [
    alert(RUN_0640, "V B Worlikar Marg", "1105", "severe"),
    alert(RUN_0640, "Sant Shitolebaba Maharaj Marg", "0926", "moderate"),
  ],
  [RUN_0840]: [
    alert(RUN_0840, "V B Worlikar Marg", "1105", "severe"),
    alert(RUN_0840, "Sant Shitolebaba Maharaj Marg", "0926", "severe"),
    alert(RUN_0840, "Mahatma Gandhi Road", "0560", "severe"),
  ],
};

const capRequests: { alertId: string; runId: string | null }[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  capRequests.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost:8000");
    const runId = url.searchParams.get("run_id");
    if (url.pathname.endsWith("/v1/runs")) {
      return json({
        runs: [
          { run_id: RUN_0640, cycle_ts: "2019-07-02T06:40:00+05:30" },
          { run_id: RUN_0840, cycle_ts: "2019-07-02T08:40:00+05:30" },
        ],
      });
    }
    if (url.pathname.endsWith("/v1/alerts")) {
      const run = runId ?? RUN_0640;
      return json({ run_id: run, alerts: QUEUES[run] });
    }
    const cap = /\/v1\/alerts\/(.+)\.cap$/.exec(url.pathname);
    if (cap) {
      const alertId = decodeURIComponent(cap[1]!);
      capRequests.push({ alertId, runId });
      const known = (QUEUES[runId ?? RUN_0640] as { id: string }[]).some((a) => a.id === alertId);
      return known
        ? new Response("<alert/>", { status: 200 })
        : json({ error: { code: "not_found", message: "No such alert in this run" } }, 404);
    }
    return json({ error: { code: "not_found", message: `No stub for ${url.pathname}` } }, 404);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function cards(): HTMLElement[] {
  return screen.getAllByRole("article");
}

describe("AlertsScreen motion M16", () => {
  it("slides nothing in on the first queue, then only the alerts a new cycle brings", async () => {
    render(
      <TooltipProvider>
        <AlertsScreen />
      </TooltipProvider>,
    );

    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(cards().filter((c) => c.dataset.entering === "true")).toHaveLength(0);
    const phone = screen.getByRole("figure", { name: "Ward officer's phone" });
    expect(phone).toHaveAttribute("data-pop-key", "0");

    fireEvent.click(await screen.findByRole("button", { name: /^Forecast from 08:40 IST/ }));

    await waitFor(() => expect(cards()).toHaveLength(3));
    const entering = cards()
      .filter((c) => c.dataset.entering === "true")
      .map((c) => c.querySelector("button")?.textContent ?? "");
    expect(entering.sort()).toEqual(
      [
        "Mahatma Gandhi Road: depth likely above 45 cm",
        "Sant Shitolebaba Maharaj Marg: depth likely above 45 cm",
      ].sort(),
    );
    expect(phone).toHaveAttribute("data-pop-key", "1");

    // The phone leads with what the batch brought.
    const messages = screen.getAllByRole("listitem").filter((li) => li.dataset.fresh === "true");
    expect(messages).toHaveLength(2);
  });

  it("never asks a cycle for the CAP of an alert another cycle raised", async () => {
    render(
      <TooltipProvider>
        <AlertsScreen />
      </TooltipProvider>,
    );
    await waitFor(() => expect(capRequests.length).toBeGreaterThan(0));

    fireEvent.click(await screen.findByRole("button", { name: /^Forecast from 08:40 IST/ }));
    await waitFor(() => expect(capRequests.some((r) => r.runId === RUN_0840)).toBe(true));

    for (const request of capRequests) {
      const run = request.runId ?? RUN_0640;
      expect((QUEUES[run] as { id: string }[]).map((a) => a.id)).toContain(request.alertId);
    }
  });
});
