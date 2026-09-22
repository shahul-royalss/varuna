/**
 * The console's layer panel, and in particular that no switch on it is silent.
 *
 * CLAUDE.md 17: "every P1 button reads 'coming in pilot' with one sentence of plan - never a dead
 * control", and the panel's own docstring makes that a rule about layers: where a layer needs
 * something first, the row's detail line says what. Two of those rows are new - the
 * photorealistic city and the drain X-ray - and both are, today, in the state where the detail
 * line is the whole answer: the Map Tiles API is disabled on this key's Cloud project, and a
 * drain layer exported before the invert elevations landed carries none.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LayerPanel, type LayerToggles } from "../layer-panel";

const ALL_OFF: LayerToggles = {
  satellite: false,
  probability: false,
  raster: false,
  segments: false,
  surcharge: false,
  drains: false,
  buildings: false,
  hotspots: false,
  isochrones: false,
  routes: false,
  threeD: false,
  xray: false,
};

describe("LayerPanel", () => {
  it("offers the photorealistic city and the drain X-ray as switches", () => {
    render(<LayerPanel value={ALL_OFF} onChange={() => undefined} />);
    expect(screen.getByRole("switch", { name: /Photorealistic city/ })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Drain X-ray/ })).toBeInTheDocument();
  });

  it("no longer offers the 3D terrain the photorealistic city replaced", () => {
    render(<LayerPanel value={ALL_OFF} onChange={() => undefined} />);
    expect(screen.queryByText("3D terrain")).not.toBeInTheDocument();
  });

  it("reports which layer was switched, and to what", async () => {
    const onChange = vi.fn();
    render(<LayerPanel value={ALL_OFF} onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch", { name: /Drain X-ray/ }));
    expect(onChange).toHaveBeenCalledWith("xray", true);
  });

  it("prints a row's detail whether or not the layer is on", () => {
    // The point of the rule: switching 3D on when the API is disabled must not look like a map
    // that failed. The sentence is on screen with the switch still off.
    render(
      <LayerPanel
        value={ALL_OFF}
        onChange={() => undefined}
        details={{ threeD: "Google's Map Tiles API is not enabled on this key's project." }}
      />,
    );
    expect(screen.getByText(/Map Tiles API is not enabled/)).toBeInTheDocument();
  });

  it("marks each switch's state for a reader who cannot see the toggle", () => {
    render(<LayerPanel value={{ ...ALL_OFF, xray: true }} onChange={() => undefined} />);
    expect(screen.getByRole("switch", { name: /Drain X-ray/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("switch", { name: /Photorealistic city/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
