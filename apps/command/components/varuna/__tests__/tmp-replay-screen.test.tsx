import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ReplayScreen } from "@/app/replay/replay-screen";
import { useReplayStore } from "@/lib/stores/replay";

vi.mock("next/navigation", () => ({
  usePathname: () => "/replay",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

describe("ReplayScreen smoke", () => {
  it("renders three bundles and selects one", () => {
    render(
      <TooltipProvider>
        <ReplayScreen />
      </TooltipProvider>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Replay" })).toBeInTheDocument();
    const chennai = screen.getByRole("button", { name: /CHN-IDF-25yr/ });
    fireEvent.click(chennai);
    expect(useReplayStore.getState().bundleId).toBe("CHN-IDF-25yr");
    expect(screen.getByText("No cycle yet")).toBeInTheDocument();
    expect(screen.getAllByText("No cycles yet").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Editing the storm is coming in pilot; the demo storm is read-only",
      ),
    ).toBeInTheDocument();
    useReplayStore.getState().reset();
  });
});
