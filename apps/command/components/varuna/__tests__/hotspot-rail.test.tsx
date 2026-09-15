/**
 * The "As it happened" ticker (task P6.12, motion M18): a row the clock adds while the operator
 * watches slides in; rows already there when the ticker first shows do not; reduced motion shows
 * every row at once; a pin from another day than the replay carries its date; and every row keeps
 * the link to the source it was read from.
 */

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  HotspotRail,
  TICKER_ROW_FROM,
  TICKER_ROW_TO,
  TICKER_ROW_TRANSITION,
  type TickerPin,
} from "@/components/varuna/hotspot-rail";
import { DUR_MS, EASE_UI } from "@/lib/motion";

const CLOCK = "2019-07-02T08:50:00+05:30";

function pin(id: string, ts: string, name: string): TickerPin {
  return {
    id,
    ts,
    tsUncertaintyMin: 10,
    name,
    lon: 72.858,
    lat: 19.032,
    depthCm: null,
    depthPhrase: null,
    kind: "log",
    text: null,
    sourceUrl: `https://example.org/${id}`,
    sourceTitle: null,
    insideAoi: true,
    clockTs: CLOCK,
  };
}

const kranti = pin("P-kranti", "2019-07-02T08:07:00+05:30", "Kranti Nagar");
const bhakti = pin("P-bhakti", "2019-07-01T11:52:00+05:30", "Bhakti Park");
const gandhi = pin("P-gandhi", "2019-07-02T08:47:00+05:30", "Gandhi Market");

let reduced = false;
beforeEach(() => {
  reduced = false;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

function ticker() {
  return within(screen.getByRole("region", { name: "As it happened" }));
}

function row(name: string): HTMLElement {
  const item = ticker()
    .getAllByRole("listitem")
    .find((li) => li.textContent?.includes(name));
  if (!item) throw new Error(`no ticker row for ${name}`);
  return item;
}

describe("the As it happened ticker", () => {
  it("slides a row in on the catalogue easing over the micro duration", () => {
    expect(TICKER_ROW_FROM).toEqual({ opacity: 0, y: -8 });
    expect(TICKER_ROW_TO).toEqual({ opacity: 1, y: 0 });
    expect(TICKER_ROW_TRANSITION).toEqual({ duration: DUR_MS.micro / 1000, ease: EASE_UI });
    expect(DUR_MS.micro).toBeGreaterThanOrEqual(150);
    expect(DUR_MS.micro).toBeLessThanOrEqual(220);
  });

  it("does not animate the rows already there, and slides in a row the clock adds", () => {
    const { rerender } = render(
      <HotspotRail hotspots={[]} step={0} truthPins={[kranti, bhakti]} />,
    );
    // Present on first show: already at rest, never at the start of the slide.
    for (const name of ["Kranti Nagar", "Bhakti Park"]) {
      expect(row(name).style.opacity).toBe("1");
      expect(row(name).style.transform).not.toContain("-8px");
    }

    rerender(<HotspotRail hotspots={[]} step={0} truthPins={[gandhi, kranti, bhakti]} />);
    const added = row("Gandhi Market");
    // The new row mounts at the start of the slide: transparent, 8 px above its place.
    expect(added.style.opacity).toBe("0");
    expect(added.style.transform).toContain("translateY(-8px)");
    expect(within(added).getByRole("link", { name: "source" })).toHaveAttribute(
      "href",
      "https://example.org/P-gandhi",
    );
  });

  it("under reduced motion a new row is simply there", () => {
    reduced = true;
    const { rerender } = render(<HotspotRail hotspots={[]} step={0} truthPins={[kranti]} />);
    rerender(<HotspotRail hotspots={[]} step={0} truthPins={[gandhi, kranti]} />);
    const added = row("Gandhi Market");
    expect(added.getAttribute("style")).toBeNull();
    expect(within(added).getByRole("link", { name: "source" })).toBeInTheDocument();
  });

  it("dates the pins from the day before the replay, and keeps every source link", () => {
    render(<HotspotRail hotspots={[]} step={0} truthPins={[gandhi, kranti, bhakti]} />);
    expect(row("Bhakti Park").textContent).toMatch(/^1 Jul 11:52 · Bhakti Park/);
    expect(row("Gandhi Market").textContent).toMatch(/^08:47 · Gandhi Market/);
    expect(ticker().getAllByRole("link", { name: "source" })).toHaveLength(3);
  });

  it("still says what to wait for before the clock reaches a pin", () => {
    render(<HotspotRail hotspots={[]} step={0} truthPins={[]} />);
    expect(
      ticker().getByText("Ground-truth pins appear as the replay clock passes them."),
    ).toBeInTheDocument();
  });
});
