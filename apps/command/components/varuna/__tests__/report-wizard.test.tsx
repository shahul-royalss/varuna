import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReportWizard } from "@/components/varuna/report-wizard";

function renderWizard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ReportWizard />
    </QueryClientProvider>,
  );
}

function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("ReportWizard", () => {
  it("advances through location, photo and depth", () => {
    renderWizard();

    expect(screen.getByRole("heading", { name: "Where is the water?" })).toBeInTheDocument();
    expect(screen.getByLabelText("Latitude")).toHaveValue("19.012");
    expect(screen.getByLabelText("Longitude")).toHaveValue("72.841");

    click("Continue to photo");
    expect(screen.getByRole("heading", { name: "Add a photo" })).toBeInTheDocument();

    click("Skip photo");
    expect(screen.getByRole("heading", { name: "How deep is the water?" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "How deep is the water" })).toBeInTheDocument();
  });

  it("refuses to send without a depth chip", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    renderWizard();

    click("Continue to photo");
    click("Skip photo");

    const send = screen.getByRole("button", { name: "Send report" });
    expect(send).toBeDisabled();
    expect(screen.getByText("Pick a depth to send the report.")).toBeInTheDocument();

    fireEvent.click(send);
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: /Knee/ }));
    expect(screen.getByRole("button", { name: "Send report" })).not.toBeDisabled();

    fetchSpy.mockRestore();
  });
});
