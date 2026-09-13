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
  // The junction's own segments, trimmed to three like the series above.
  segmentIds: ["S100841069-000", "S100841079-000", "S102172139-001"],
  attribution: [],
  attributionLabel: "Not computed on this run: Flash-lite is element-wise per segment — ADR-0042.",
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

  it("sends this junction's own segments to the what-if lab (P7.11)", () => {
    render(<HotspotDrawer hotspot={HINDMATA} step={0} validTs={VALID_TS} />);
    // An anchor carrying `role="button"`: the house pattern for a link styled as a button
    // (`render={<Link/>} nativeButton={false}`), as on the landing hero and the 404.
    const link = screen.getByRole("button", { name: "Clean in what-if" });
    // Road-segment ids, which is the vocabulary `POST /v1/whatif` cleans on, and the junction's
    // name so the lab can say where the chips came from. No run: the console store is empty in
    // this test, and the lab's own default is then the newest run.
    expect(link).toHaveAttribute(
      "href",
      "/whatif?segments=S100841069-000%2CS100841079-000%2CS102172139-001&from=Hindmata+junction+%28Hindmata+Cinema%2C+Dr+B.+Ambedkar+Marg%29",
    );
    expect(screen.getByText(/Opens the lab with/)).toHaveTextContent(
      "Opens the lab with this junction’s 3 road segments picked. Cleaning is element-wise per " +
        "segment, so it moves these streets and no others (ADR-0042).",
    );
  });

  it("says the link carries the first fourteen when the junction has more", () => {
    // Hindmata has 25 in the baked run. The ids are in the register's own order, so a bare "14"
    // would read as the junction's whole set.
    const ids = Array.from({ length: 25 }, (_, i) => `S1008410${String(i).padStart(2, "0")}-000`);
    render(
      <HotspotDrawer hotspot={{ ...HINDMATA, segmentIds: ids }} step={0} validTs={VALID_TS} />,
    );
    expect(screen.getByText(/Opens the lab with/)).toHaveTextContent(
      "Opens the lab with the first 14 of this junction’s 25 road segments picked.",
    );
    expect(screen.getByRole("button", { name: "Clean in what-if" }).getAttribute("href")).toContain(
      `segments=${ids.slice(0, 14).join("%2C")}`,
    );
  });

  it("offers nothing to clean when the junction has no segments recorded", () => {
    render(<HotspotDrawer hotspot={{ ...HINDMATA, segmentIds: [] }} step={0} validTs={VALID_TS} />);
    expect(screen.queryByRole("button", { name: "Clean in what-if" })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "No road segments are recorded for this junction, so there is nothing to send to the what-if lab.",
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
