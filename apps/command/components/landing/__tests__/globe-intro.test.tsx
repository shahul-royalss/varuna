/**
 * The globe's two sequences (M26 and M27; task D-14).
 *
 * The frame maths is a pure function of elapsed milliseconds, which is the only reason the acts
 * can be checked at all - there is no way to assert a WebGL-free SVG animation from the outside
 * except by asking where the camera is at a given instant.
 *
 * The first `describe` is the one that matters most: **M26 must still be exactly what it was.**
 * The landing hero is the first thing a judge sees, and it was working before this task.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { frameAt, GlobeIntro, sequenceMs } from "@/components/landing/globe-intro";
import { DUR_MS } from "@/lib/motion";

/** The geometry M26 had before the approach act existed, recomputed from its own constants. */
function legacyUnroll(elapsed: number) {
  const SPIN_MS = 1400;
  const UNROLL_MS = 2600;
  const SCALE_GLOBE = 190;
  const SCALE_FLAT = 138;
  const SPIN_DEG_PER_S = 22;
  const MUMBAI_LON = 72.86;
  const MUMBAI_LAT = 19.06;
  const unrollT = Math.max(0, Math.min((elapsed - SPIN_MS) / UNROLL_MS, 1));
  const a = 1 - Math.pow(1 - unrollT, 3);
  const spun = (elapsed / 1000) * SPIN_DEG_PER_S;
  return {
    alpha: a,
    scale: SCALE_GLOBE + (SCALE_FLAT - SCALE_GLOBE) * a,
    // The old code passed `rotate([-MUMBAI_LON - spun * (1 - a), -MUMBAI_LAT * (1 - a), 0])`.
    rotate: [-MUMBAI_LON - spun * (1 - a), -MUMBAI_LAT * (1 - a)] as [number, number],
  };
}

describe("the landing hero's sequence (M26) is unchanged", () => {
  it("runs for the same 4.0 s and puts the camera in the same place at every instant", () => {
    expect(sequenceMs("unroll")).toBe(4000);
    for (const elapsed of [0, 200, 700, 1399, 1400, 1800, 2600, 3400, 3999, 4000]) {
      const now = frameAt("unroll", elapsed);
      const before = legacyUnroll(elapsed);
      expect(now.alpha).toBeCloseTo(before.alpha, 12);
      expect(now.scale).toBeCloseTo(before.scale, 10);
      // The frame carries the centre; the projection is rotated by its negation.
      expect(-now.centre[0]).toBeCloseTo(before.rotate[0], 10);
      expect(-now.centre[1]).toBeCloseTo(before.rotate[1], 10);
    }
  });

  it("asks for neither the highlight nor the AOI box the approach adds", () => {
    for (const elapsed of [0, 1400, 2600, 4000]) {
      const frame = frameAt("unroll", elapsed);
      expect(frame.highlight).toBe(0);
      expect(frame.aoi).toBe(0);
    }
  });

  it("keeps its accessible label, because the hero's globe is the page's only picture", () => {
    const { container } = render(<GlobeIntro still />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-sequence", "unroll");
    expect(svg).toHaveAttribute("role", "img");
    expect(svg?.getAttribute("aria-label")).toContain("Mumbai");
  });

  it("does not fetch the finer topology; only the approach pays for that", () => {
    const asked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response("null", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      render(<GlobeIntro still />);
      expect(asked.some((url) => url.includes("world-110m"))).toBe(true);
      expect(asked.some((url) => url.includes("world-50m"))).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the dashboard's approach (M27)", () => {
  it("is four seconds of three catalogue acts", () => {
    expect(sequenceMs("approach")).toBe(
      DUR_MS.globeTurn + DUR_MS.globeApproach + DUR_MS.globeArrive,
    );
    expect(sequenceMs("approach")).toBe(4000);
  });

  it("turns to India at a fixed scale before it flattens anything", () => {
    const start = frameAt("approach", 0);
    const endOfTurn = frameAt("approach", DUR_MS.globeTurn - 1);
    expect(start.alpha).toBe(0);
    expect(endOfTurn.alpha).toBeLessThan(0.01);
    expect(start.scale).toBeCloseTo(endOfTurn.scale, 6);
    // The camera travels east from the Atlantic to the subcontinent.
    expect(start.centre[0]).toBeLessThan(0);
    expect(endOfTurn.centre[0]).toBeGreaterThan(70);
  });

  it("flattens the sphere and closes on India during the second act", () => {
    const mid = frameAt("approach", DUR_MS.globeTurn + DUR_MS.globeApproach / 2);
    const end = frameAt("approach", DUR_MS.globeTurn + DUR_MS.globeApproach);
    expect(mid.alpha).toBeGreaterThan(0);
    expect(mid.alpha).toBeLessThan(1);
    expect(end.alpha).toBeCloseTo(1, 6);
    expect(end.scale).toBeGreaterThan(frameAt("approach", DUR_MS.globeTurn).scale);
    expect(end.highlight).toBeGreaterThan(0.99);
  });

  it("narrows onto the Mumbai AOI in the third, and ends framed on the city", () => {
    const last = frameAt("approach", sequenceMs("approach"));
    expect(last.centre[0]).toBeCloseTo(72.86, 6);
    expect(last.centre[1]).toBeCloseTo(19.06, 6);
    expect(last.aoi).toBeCloseTo(1, 6);
    // Two orders of magnitude tighter than where the second act left it.
    expect(last.scale).toBeGreaterThan(
      20 * frameAt("approach", DUR_MS.globeTurn + DUR_MS.globeApproach).scale,
    );
  });

  it("never runs the camera backwards: the scale only grows", () => {
    let previous = 0;
    for (let t = 0; t <= sequenceMs("approach"); t += 50) {
      const { scale } = frameAt("approach", t);
      expect(scale).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = scale;
    }
  });

  it("hides its canvas from assistive technology, because the skip button is the control", () => {
    const { container } = render(<GlobeIntro sequence="approach" still />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-sequence", "approach");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("role", "img");
  });

  it("asks for the finer topology, and carries on when that fetch fails", async () => {
    const asked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.includes("world-50m")) throw new TypeError("offline");
      return new Response("null", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const { container } = render(<GlobeIntro sequence="approach" still />);
      await Promise.resolve();
      expect(asked.some((url) => url.includes("world-50m"))).toBe(true);
      // The sequence still renders: a failed fetch is not an error state on screen.
      expect(container.querySelector("svg")).toBeInTheDocument();
    } finally {
      globalThis.fetch = original;
    }
  });
});
