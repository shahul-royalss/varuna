import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AlertsScreen } from "@/app/alerts/alerts-screen";
import { toast } from "sonner";

import { clearPassphrase, writePassphrase } from "@/lib/api/ops";

// `<Toaster />` is mounted by the app layout, not by a test render, so the toast is asserted
// where it is raised. Same shape as `app/pumps/__tests__/pumps-screen.test.tsx`.
vi.mock("sonner", () => ({ toast: vi.fn() }));

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
/** Alert ids the stubbed API has been told about, and the header each act arrived with. */
const acked = new Set<string>();
const actions: { alertId: string; action: string; passphrase: string | null }[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  capRequests.length = 0;
  actions.length = 0;
  acked.clear();
  clearPassphrase();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost:8000");
    const runId = url.searchParams.get("run_id");
    // The gated act. The API refuses one that carries no passphrase, and the overlay it writes is
    // what the *next* read of the queue returns - never something this screen remembers.
    const act = /\/v1\/alerts\/(.+)\/(ack|escalate)$/.exec(url.pathname);
    if (act) {
      const alertId = decodeURIComponent(act[1]!);
      const passphrase = new Headers(init?.headers).get("X-Varuna-Ops");
      actions.push({ alertId, action: act[2]!, passphrase });
      if (!passphrase) {
        return json(
          {
            error: {
              code: "ops_passphrase_required",
              message: "This is an authority edit and it carries no passphrase.",
            },
          },
          401,
        );
      }
      acked.add(alertId);
      return json({
        run_id: runId ?? RUN_0640,
        entry: { id: "e1", kind: `alert_${act[2]}`, ts: "2019-07-02T08:12:00+05:30" },
        alert: { id: alertId, state: "acknowledged", acknowledged_by: "console" },
        notes: ["This changed no forecast."],
      });
    }
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
      // What `apply_alert_state` does on the server: the product, with the log folded in.
      const queue = (QUEUES[run] as { id: string }[]).map((a) =>
        acked.has(a.id) ? { ...a, state: "acknowledged", acknowledged_by: "console" } : a,
      );
      return json({ run_id: run, alerts: queue });
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

/**
 * Acknowledging used to be a boolean this component held: it survived neither a reload nor the
 * change of cycle, and nobody else ever saw it. The state belongs to the API now, and the button
 * is the thing that puts it there (B1).
 */
describe("AlertsScreen acknowledgement", () => {
  function first(): HTMLElement {
    return cards()[0]!;
  }

  it("shows the state the API returns, without anyone clicking", async () => {
    acked.add((QUEUES[RUN_0640] as { id: string }[])[0]!.id);
    render(
      <TooltipProvider>
        <AlertsScreen />
      </TooltipProvider>,
    );

    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(within(first()).getByText("Acknowledged")).toBeInTheDocument();
    expect(actions).toHaveLength(0);
  });

  it("writes the acknowledgement and takes the new state back off the wire", async () => {
    writePassphrase("monsoon desk 2026");
    render(
      <TooltipProvider>
        <AlertsScreen />
      </TooltipProvider>,
    );
    await waitFor(() => expect(cards()).toHaveLength(2));
    const id = (QUEUES[RUN_0640] as { id: string }[])[0]!.id;
    expect(within(first()).queryByText("Acknowledged")).toBeNull();

    fireEvent.click(within(first()).getByRole("button", { name: "Acknowledge" }));

    await waitFor(() => expect(actions).toHaveLength(1));
    expect(actions[0]).toMatchObject({
      alertId: id,
      action: "ack",
      passphrase: "monsoon desk 2026",
    });
    // The card turns only because the queue was read again, not because the click said so.
    await waitFor(() => expect(within(first()).getByText("Acknowledged")).toBeInTheDocument());
  });

  it("sends nothing when the tab holds no passphrase, and says where to enter it", async () => {
    render(
      <TooltipProvider>
        <AlertsScreen />
      </TooltipProvider>,
    );
    await waitFor(() => expect(cards()).toHaveLength(2));

    fireEvent.click(within(first()).getByRole("button", { name: "Acknowledge" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ description: expect.stringMatching(/authority desk/i) }),
      ),
    );
    expect(actions, "a write with no passphrase never leaves the browser").toHaveLength(0);
    expect(within(first()).queryByText("Acknowledged")).toBeNull();
  });
});
