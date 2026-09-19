import { describe, expect, it, vi } from "vitest";

import { loadAlerts } from "./alerts";

/**
 * The desk's state, as the console reads it.
 *
 * `GET /v1/alerts` serves the cycle's own queue with the ops log folded onto it at read time, so
 * an acknowledgement reaches this screen without the screen remembering anything. It used to
 * remember: a local boolean that vanished on reload and never existed for anyone else. These pin
 * that the state comes off the wire, and that an answer without one is read as `raised` rather
 * than as "somebody has seen this".
 */

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const BASE = {
  id: "VARUNA-MUM-TEST-STREET-1105-SEVERE",
  run_id: "MUM-20190702T0310Z-sky1.0-twin1.0-flash0.1-baked",
  level: "severe",
  area_desc: "V B Worlikar Marg",
  scope: "segment",
  headline: "V B Worlikar Marg: depth likely above 45 cm",
};

async function load(alert: Record<string, unknown>) {
  vi.stubGlobal("fetch", async () => json({ run_id: "r", alerts: [{ ...BASE, ...alert }] }));
  try {
    const set = await loadAlerts();
    return set!.alerts[0]!;
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("loadAlerts: the desk's state", () => {
  it("reads an untouched alert as raised, with nothing claimed about who has seen it", async () => {
    const alert = await load({ state: "raised" });

    expect(alert.state).toBe("raised");
    expect(alert.acknowledgedBy).toBeNull();
    expect(alert.acknowledgedTs).toBeNull();
    expect(alert.history).toEqual([]);
  });

  it("carries who acknowledged it and when", async () => {
    const alert = await load({
      state: "acknowledged",
      acknowledged_by: "ward officer",
      acknowledged_ts: "2019-07-02T08:12:00+05:30",
      history: [
        {
          ts: "2019-07-02T08:12:00+05:30",
          state: "acknowledged",
          user: "ward officer",
          note: "Traffic police informed",
        },
      ],
    });

    expect(alert.state).toBe("acknowledged");
    expect(alert.acknowledgedBy).toBe("ward officer");
    expect(alert.acknowledgedTs).toBe("2019-07-02T08:12:00+05:30");
    expect(alert.history).toEqual([
      {
        ts: "2019-07-02T08:12:00+05:30",
        state: "acknowledged",
        user: "ward officer",
        note: "Traffic police informed",
      },
    ]);
  });

  it("keeps the acknowledgement after an escalation, because the trail is the point", async () => {
    const alert = await load({
      state: "escalated",
      acknowledged_by: "ward officer",
      escalated_to: "police_traffic",
      history: [
        { ts: "1", state: "acknowledged", user: "ward officer" },
        { ts: "2", state: "escalated", user: "ward officer" },
      ],
    });

    expect(alert.state).toBe("escalated");
    expect(alert.escalatedTo).toBe("police_traffic");
    expect(alert.acknowledgedBy).toBe("ward officer");
    expect(alert.history.map((h) => h.state)).toEqual(["acknowledged", "escalated"]);
  });

  it("reads a state it does not know as raised", async () => {
    // Never the other way round: inventing "seen" from a word we do not recognise is the one
    // mistake an alert queue must not make.
    expect((await load({ state: "dismissed-by-someone" })).state).toBe("raised");
    expect((await load({})).state).toBe("raised");
  });

  it("fills a history row that arrives without its user", async () => {
    const alert = await load({ state: "acknowledged", history: [{ ts: "1", state: "acknowledged" }] });

    expect(alert.history[0]!.user).toBe("unknown");
    expect(alert.history[0]!.note).toBeNull();
  });
});
