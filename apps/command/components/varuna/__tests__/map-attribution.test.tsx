import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { mergeCredits } from "@/lib/maps/photoreal";
import { attributionLine, GOOGLE_WORDMARK, MapAttribution } from "../map-attribution";

describe("attributionLine", () => {
  it("shows the wordmark alone while the first tiles are still arriving", () => {
    expect(attributionLine()).toBe(GOOGLE_WORDMARK);
    expect(attributionLine("")).toBe(GOOGLE_WORDMARK);
    expect(attributionLine("   ")).toBe(GOOGLE_WORDMARK);
  });

  it("joins the providers to the wordmark the way Google's own sample does", () => {
    expect(attributionLine("Airbus; Maxar Technologies")).toBe(
      "Google Maps; Airbus; Maxar Technologies",
    );
  });

  it("reads a merged credit line end to end", () => {
    const credits = mergeCredits(["Maxar Technologies;Airbus", "Airbus"]);
    expect(attributionLine(credits)).toBe("Google Maps; Airbus; Maxar Technologies");
  });
});

describe("MapAttribution", () => {
  it("names Google whether or not any provider has been harvested yet", () => {
    render(<MapAttribution />);
    expect(screen.getByText(GOOGLE_WORDMARK)).toBeInTheDocument();
  });

  it("keeps every provider in the DOM although the line is clipped to one", () => {
    // The licence is satisfied by the text being displayed and present, not by it fitting: CSS
    // truncation clips pixels, so assistive technology and a page copy still get the whole list.
    const credits = "Airbus; CNES / Airbus; Landsat / Copernicus; Maxar Technologies; Zenrin";
    render(<MapAttribution credits={credits} />);

    const chip = screen.getByText(`${GOOGLE_WORDMARK}; ${credits}`);
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute("title", `${GOOGLE_WORDMARK}; ${credits}`);
    expect(chip.className).toContain("truncate");
  });

  it("never eats a map drag that starts on it", () => {
    render(<MapAttribution credits="Airbus" />);
    expect(screen.getByText("Google Maps; Airbus").className).toContain("pointer-events-none");
  });

  it("uses tokens for every colour, so `pnpm lint:design` has nothing to find", () => {
    render(<MapAttribution credits="Airbus" />);
    const chip = screen.getByText("Google Maps; Airbus");
    expect(chip.className).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(chip.className).toContain("text-text-2");
    expect(chip.className).toContain("bg-ink/80");
    expect(chip.className).toContain("border-line");
  });

  it("takes a class from its host without losing its own", () => {
    render(<MapAttribution credits="Airbus" className="left-2" />);
    const chip = screen.getByText("Google Maps; Airbus");
    expect(chip.className).toContain("left-2");
    expect(chip.className).toContain("type-micro");
  });
});
