import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HotspotDrawer } from "@/components/varuna/hotspot-drawer";
import type { Hotspot } from "@/lib/api/hotspots";

/**
 * Hindmata as the 08:40 cycle of MUM-2019-07-02 ranked it, trimmed to its first six steps, so the
 * drawer under test is rendering numbers a baked run produced rather than round ones invented here.
 */
const HINDMATA: Hotspot = {
  rank: 2,
  id: "MUM-HS-01",
  name: "Hindmata junction (Hindmata Cinema, Dr B. Ambedkar Marg)",
  slug: "hindmata-junction-hindmata-cinema-dr-b-ambedkar-",
  lon: 72.8421396,
  lat: 19.010099,
  ward: "F/S",
  isSink: false,
  sourceUrl:
    "https://www.freepressjournal.in/mumbai/mumbai-rains-knee-deep-water-accumulates-in-dadar-hindmata-due-to-heavy-downpour-video-surfaces",
  sourced: true,
  peakDepthCm: 10.0,
  peakTs: "2019-07-02T11:40:00+05:30",
  timeToPeakMin: 175,
  depthCm: [0.0, 0.1, 0.3, 0.6, 0.7, 0.9],
  pImpassableAtPeak: 0.0,
  impassableFromTs: null,
  minutesImpassable: 0,
  expectedImpact: 0.0,
  exposure: { weight: 0.783, facilities: ["shelter"] },
};

const VALID_TS = [
  "2019-07-02T08:40:00+05:30",
  "2019-07-02T08:45:00+05:30",
  "2019-07-02T08:50:00+05:30",
  "2019-07-02T08:55:00+05:30",
  "2019-07-02T09:00:00+05:30",
  "2019-07-02T09:05:00+05:30",
];

describe("HotspotDrawer", () => {
  it("keeps 7.2's panel structure", () => {
    render(<HotspotDrawer hotspot={HINDMATA} step={0} validTs={VALID_TS} />);
    expect(screen.getByText("Why this junction floods")).toBeInTheDocument();
    expect(screen.getByText("Safe until")).toBeInTheDocument();
    expect(screen.getByText("Exposure")).toBeInTheDocument();
  });

  it("says attribution is not computed, and why, instead of waiting for it", () => {
    render(<HotspotDrawer hotspot={HINDMATA} step={0} validTs={VALID_TS} />);
    expect(screen.getByText("Attribution is not computed on this run")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Flash-lite is element-wise per segment, so cleaning a pipe that is not under this junction has exactly zero effect — ADR-0042.",
      ),
    ).toBeInTheDocument();
  });

  it("leaves nothing in the drawer marked busy, since nothing in it is loading", () => {
    const { container } = render(<HotspotDrawer hotspot={HINDMATA} step={0} validTs={VALID_TS} />);
    expect(container.querySelectorAll("[aria-busy]")).toHaveLength(0);
    expect(container.querySelectorAll(".skeleton-shimmer")).toHaveLength(0);
  });

  it("renders nothing without a hotspot", () => {
    const { container } = render(<HotspotDrawer hotspot={null} step={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
