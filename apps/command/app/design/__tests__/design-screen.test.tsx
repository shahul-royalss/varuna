import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useRunStore } from "@/lib/stores/run";

import { DesignScreen } from "../design-screen";
import { DESIGN_SECTIONS } from "../_sections/section";

describe("DesignScreen", () => {
  afterEach(() => {
    useRunStore.getState().clear();
  });

  it("lists every section in the index, linked to its anchor", () => {
    render(<DesignScreen />);
    const index = screen.getByRole("navigation", { name: "Design system sections" });
    for (const section of DESIGN_SECTIONS) {
      const link = within(index).getByRole("link", { name: section.label });
      expect(link).toHaveAttribute("href", `#${section.id}`);
    }
  });

  it("renders a heading for every section the index points at", () => {
    render(<DesignScreen />);
    for (const section of DESIGN_SECTIONS) {
      expect(screen.getByRole("heading", { name: section.label, level: 2 })).toBeInTheDocument();
    }
  });

  it("labels the page as internal rather than part of the demo", () => {
    render(<DesignScreen />);
    expect(screen.getByText(/Internal page/)).toBeInTheDocument();
  });
});
