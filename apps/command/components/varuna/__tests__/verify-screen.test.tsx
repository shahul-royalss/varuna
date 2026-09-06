import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { VerifyScreen } from "@/app/verify/verify-screen";
import { LIMITATIONS } from "@/components/varuna/limitations-list";
import { HEADLINE_SCORE_TILES } from "@/components/varuna/verification-grid";

vi.mock("next/navigation", () => ({
  usePathname: () => "/verify",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

function renderVerify() {
  return render(
    <TooltipProvider>
      <VerifyScreen />
    </TooltipProvider>,
  );
}

describe("VerifyScreen", () => {
  it("renders every headline score as not scored yet, with its unit", () => {
    renderVerify();
    const grid = screen.getByRole("list", { name: "Verification scores" });
    const tiles = screen.getAllByRole("listitem").filter((li) => grid.contains(li));
    expect(tiles).toHaveLength(HEADLINE_SCORE_TILES.length);

    for (const tile of HEADLINE_SCORE_TILES) {
      expect(screen.getByText(tile.label)).toBeInTheDocument();
      expect(screen.getAllByText(tile.unit).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("Not scored yet")).toHaveLength(HEADLINE_SCORE_TILES.length);
    expect(
      screen.getByText(/Ground-truth pins: none scored yet/),
    ).toBeInTheDocument();
  });

  it("anchors the limitations so the landing footnote can deep-link to them", () => {
    const { container } = renderVerify();
    const section = container.querySelector("#limitations");
    expect(section).not.toBeNull();
    expect(section).toHaveAccessibleName("Limitations we state before anyone asks");
    for (const limitation of LIMITATIONS) {
      expect(screen.getByText(limitation)).toBeInTheDocument();
    }
  });

  it("names the event under verification and the empty charts", () => {
    renderVerify();
    expect(screen.getByLabelText("Event")).toHaveTextContent("MUM-2019-07-02");
    expect(
      screen.getByText("Rain CSI at 20 and 40 mm/h against lead time in minutes, 0 to 180."),
    ).toBeInTheDocument();
    expect(screen.getByText("No missed pins yet")).toBeInTheDocument();
  });
});
