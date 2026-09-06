import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUMP_COLUMNS,
  PUMP_ACTIONS_HELPER,
  PumpBoard,
} from "@/components/varuna/pump-board";
import type { Pump } from "@/components/varuna/pump-card";

const PUMP: Pump = {
  id: "P-12",
  capacityM3PerHour: 500,
  depot: "Parel depot",
  status: "available",
  etaMinutes: 25,
};

describe("PumpBoard", () => {
  it("renders the available column and the three hotspot columns", () => {
    render(<PumpBoard pumps={[]} columns={DEFAULT_PUMP_COLUMNS} />);

    expect(screen.getByRole("heading", { name: "Available pumps" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hindmata junction" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "King's Circle" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sion Circle" })).toBeInTheDocument();
    expect(screen.getAllByText("Excess inflow appears with the first run")).toHaveLength(3);
    expect(screen.getAllByText("Minutes above 45 cm: no data")).toHaveLength(3);
  });

  it("shows the empty inventory and empty hotspot columns", () => {
    render(<PumpBoard pumps={[]} columns={DEFAULT_PUMP_COLUMNS} />);

    expect(screen.getByText("No pumps loaded yet")).toBeInTheDocument();
    expect(screen.getByText("The inventory arrives with the city layers.")).toBeInTheDocument();
    expect(screen.getAllByText("No pump assigned")).toHaveLength(3);
  });

  it("labels the inventory synthetic and disables the Phase 8 actions with a reason", () => {
    render(<PumpBoard pumps={[]} columns={DEFAULT_PUMP_COLUMNS} />);

    expect(screen.getByText("Synthetic pump inventory")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Optimise" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dispatch pumps" })).toBeDisabled();
    expect(screen.getByText(PUMP_ACTIONS_HELPER)).toBeInTheDocument();
  });

  it("renders a pump card in the available column when the inventory has pumps", () => {
    render(<PumpBoard pumps={[PUMP]} columns={DEFAULT_PUMP_COLUMNS} />);

    expect(screen.getByRole("article", { name: "Pump P-12" })).toBeInTheDocument();
    expect(screen.getByText("Parel depot")).toBeInTheDocument();
    expect(screen.getByText("ETA 25 min")).toBeInTheDocument();
    expect(screen.queryByText("No pumps loaded yet")).not.toBeInTheDocument();
  });
});
