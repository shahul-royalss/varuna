"use client";

import { Layers } from "lucide-react";

import { Switch } from "@/components/ui/switch";

/** The layers the wizard's own map can draw. Deliberately not the console's list: this panel
 * offers what the pipeline has written for this city and nothing else (CLAUDE.md 17 - a switch
 * that does nothing is worse than no switch). */
export type WizardLayerId = "streets" | "buildings" | "drains" | "depth";

export interface WizardLayerState {
  /** Whether the layer is switched on. */
  on: boolean;
  /** How many features the pipeline wrote; undefined until the layer has arrived. */
  count?: number;
  /** One line under the row about what is drawn, e.g. which step of the forecast. */
  detail?: string;
}

export interface OnboardLayersProps {
  value: Record<WizardLayerId, WizardLayerState>;
  onChange: (key: WizardLayerId, next: boolean) => void;
}

const ROWS: readonly { key: WizardLayerId; label: string; step: string }[] = [
  { key: "streets", label: "Streets", step: "written by Fetch open data" },
  { key: "buildings", label: "Buildings", step: "written by Fetch open data" },
  { key: "drains", label: "Drains", step: "written by Infer drains" },
  { key: "depth", label: "First forecast", step: "written by First forecast" },
];

/**
 * The wizard's layer panel, scoped to what this build has produced (task D-21).
 *
 * A row is switchable once its layer exists on disk and says which step writes it until then, so
 * the panel doubles as a legend for the stack forming beside it. Counts are the features the
 * pipeline actually wrote for Chennai, never a target.
 */
export function OnboardLayers({ value, onChange }: OnboardLayersProps) {
  return (
    <div className="rounded-panel border-line w-[236px] border bg-[var(--ink)]/85 backdrop-blur-[12px]">
      <div className="border-line flex h-9 items-center gap-2 border-b px-3">
        <Layers size={16} strokeWidth={1.75} className="text-text-2 shrink-0" aria-hidden="true" />
        <span className="type-small text-text flex-1">Layers</span>
      </div>
      <ul className="p-1">
        {ROWS.map((row) => {
          const state = value[row.key];
          const ready = state.count !== undefined;
          return (
            <li key={row.key} className="px-2 py-1.5">
              <div className="flex items-center gap-2.5">
                <Switch
                  id={`wizard-layer-${row.key}`}
                  checked={state.on}
                  disabled={!ready}
                  onCheckedChange={(next: boolean) => onChange(row.key, next)}
                />
                <label
                  htmlFor={`wizard-layer-${row.key}`}
                  className="type-small text-text min-w-0 flex-1 truncate"
                >
                  {row.label}
                </label>
                {ready ? (
                  <span className="num type-micro text-text-3 shrink-0">
                    {state.count?.toLocaleString("en-IN")}
                  </span>
                ) : null}
              </div>
              {ready ? (
                state.detail ? (
                  <p className="num type-micro text-text-3 pl-[42px]">{state.detail}</p>
                ) : null
              ) : (
                <p className="type-micro text-text-3 pl-[42px]">Not yet — {row.step}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
