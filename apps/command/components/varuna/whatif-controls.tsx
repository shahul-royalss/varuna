"use client";

import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** The four levers of a what-if scenario (CLAUDE.md section 7.7). */
export interface WhatIfValues {
  /** Rain multiplier, 0.5 to 2.0. */
  rainScale: number;
  /** Tide offset in metres, -0.5 to +1.0. */
  tideOffsetM: number;
  /** Clean the top 14 pipes by posterior beta (beta to 0.05). */
  cleanTop14: boolean;
  /** Apply the current pump plan as extra outflow at hotspots. */
  pumpPlan: boolean;
}

export const RAIN_SCALE_MIN = 0.5;
export const RAIN_SCALE_MAX = 2.0;
export const TIDE_OFFSET_MIN = -0.5;
export const TIDE_OFFSET_MAX = 1.0;
export const WHATIF_STEP = 0.1;

export const DEFAULT_WHATIF_VALUES: WhatIfValues = {
  rainScale: 1.0,
  tideOffsetM: 0,
  cleanTop14: false,
  pumpPlan: false,
};

/** "1.0x", "1.3x". */
export function formatRainScale(scale: number): string {
  return `${scale.toFixed(1)}x`;
}

/** "+0.0 m", "-0.5 m", "+1.0 m"; always signed so an offset never reads as a stage. */
export function formatTideOffset(metres: number): string {
  const rounded = Math.round(metres * 10) / 10;
  const sign = rounded < 0 ? "-" : "+";
  return `${sign}${Math.abs(rounded).toFixed(1)} m`;
}

function firstValue(value: number | readonly number[]): number {
  return Array.isArray(value) ? Number(value[0]) : Number(value);
}

interface SwitchRowProps {
  label: string;
  /** What the lever does, shown under the label while it works. */
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The lever is not wired to the request; the switch is inert and says why. */
  disabled?: boolean;
  /** What is missing and what would land it. Replaces the description while disabled. */
  disabledReason?: string;
}

/**
 * One switch with its label and sub-copy. A lever the request does not carry is disabled and the
 * sub-copy becomes the reason, so the row never describes work the endpoint is not asked to do
 * (CLAUDE.md 6.8, and section 17: never a dead control).
 */
function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  disabledReason,
}: SwitchRowProps) {
  const uid = useId();
  const helpId = `${uid}-help`;
  const help = disabled ? disabledReason : description;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="type-small font-medium text-text">{label}</p>
        {help ? (
          <p id={helpId} className="type-micro text-text-3">
            {help}
          </p>
        ) : null}
      </div>
      <Switch
        aria-label={label}
        aria-describedby={help ? helpId : undefined}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

export interface WhatIfControlsProps {
  /** Starting values; the component owns its state after mount. */
  initial?: Partial<WhatIfValues>;
  /** Called with the full scenario after every change. */
  onChange?: (values: WhatIfValues) => void;
  /** Called when "Run what-if" is pressed; the button is disabled while absent. */
  onRun?: (values: WhatIfValues) => void;
  /** Called when "Physics check" is pressed; the button is disabled while absent. */
  onPhysicsCheck?: (values: WhatIfValues) => void;
  /** Helper text under the disabled run button. */
  runDisabledReason?: string;
  /** Helper text under the disabled physics-check button. */
  physicsDisabledReason?: string;
  /** The cleaning switch is inert; the request carries no pipes. */
  cleanDisabled?: boolean;
  /** Why cleaning is inert, shown in place of the switch's sub-copy. */
  cleanDisabledReason?: string;
  /** The pump-plan switch is inert; the request carries no plan. */
  pumpDisabled?: boolean;
  /** Why the pump plan is inert, shown in place of the switch's sub-copy. */
  pumpDisabledReason?: string;
  className?: string;
}

/**
 * The what-if lab's control column: rain scale and tide offset sliders, the clean-top-14 and
 * pump-plan switches, and the two actions. State is local; the page reads it through `onChange`.
 * Every number carries its unit and the sliders announce their value.
 */
export function WhatIfControls({
  initial,
  onChange,
  onRun,
  onPhysicsCheck,
  runDisabledReason = "The emulator lands in Phase 7",
  physicsDisabledReason = "Runs the Twin on the same scenario once Phase 7 lands",
  cleanDisabled = false,
  cleanDisabledReason,
  pumpDisabled = false,
  pumpDisabledReason,
  className,
}: WhatIfControlsProps) {
  const [values, setValues] = useState<WhatIfValues>({ ...DEFAULT_WHATIF_VALUES, ...initial });
  const uid = useId();
  const rainLabelId = `${uid}-rain`;
  const tideLabelId = `${uid}-tide`;
  const runHelpId = `${uid}-run-help`;
  const physicsHelpId = `${uid}-physics-help`;

  const update = (patch: Partial<WhatIfValues>) => {
    setValues((prev) => {
      const next = { ...prev, ...patch };
      onChange?.(next);
      return next;
    });
  };

  const canRun = Boolean(onRun);
  const canCheck = Boolean(onPhysicsCheck);

  return (
    <div className={cn("space-y-6", className)}>
      <section aria-labelledby={rainLabelId} className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <span id={rainLabelId} className="type-small font-medium text-text">
            Rain scale
          </span>
          <output className="num type-small text-text-2" htmlFor={rainLabelId}>
            {formatRainScale(values.rainScale)}
          </output>
        </div>
        <Slider
          aria-labelledby={rainLabelId}
          min={RAIN_SCALE_MIN}
          max={RAIN_SCALE_MAX}
          step={WHATIF_STEP}
          value={[values.rainScale]}
          onValueChange={(value) => update({ rainScale: firstValue(value) })}
        />
        <p className="type-micro text-text-3">
          Multiplies every Sky member; 1.3x is the demo&apos;s &ldquo;rain plus 30 %&rdquo; moment.
        </p>
      </section>

      <section aria-labelledby={tideLabelId} className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <span id={tideLabelId} className="type-small font-medium text-text">
            Tide offset
          </span>
          <output className="num type-small text-text-2" htmlFor={tideLabelId}>
            {formatTideOffset(values.tideOffsetM)}
          </output>
        </div>
        <Slider
          aria-labelledby={tideLabelId}
          min={TIDE_OFFSET_MIN}
          max={TIDE_OFFSET_MAX}
          step={WHATIF_STEP}
          value={[values.tideOffsetM]}
          onValueChange={(value) => update({ tideOffsetM: firstValue(value) })}
        />
        <p className="type-micro text-text-3">
          Added to the stage at every tidal outfall; above the trunk invert the outfall locks.
        </p>
      </section>

      <section className="space-y-3">
        <SwitchRow
          label="Clean top 14 by beta"
          description="Sets blockage to 0.05 on the 14 worst pipes."
          checked={values.cleanTop14}
          onCheckedChange={(checked) => update({ cleanTop14: checked })}
          disabled={cleanDisabled}
          disabledReason={cleanDisabledReason}
        />
        <SwitchRow
          label="Pump plan"
          description="Applies the current dispatch as extra outflow."
          checked={values.pumpPlan}
          onCheckedChange={(checked) => update({ pumpPlan: checked })}
          disabled={pumpDisabled}
          disabledReason={pumpDisabledReason}
        />
      </section>

      <section className="space-y-3 border-t border-line pt-4">
        <div className="space-y-1">
          <Button
            className="w-full"
            disabled={!canRun}
            aria-describedby={canRun ? undefined : runHelpId}
            onClick={() => onRun?.(values)}
          >
            Run what-if
          </Button>
          {canRun ? null : (
            <p id={runHelpId} className="type-micro text-text-3">
              {runDisabledReason}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Button
            variant="outline"
            className="w-full"
            disabled={!canCheck}
            aria-describedby={canCheck ? undefined : physicsHelpId}
            onClick={() => onPhysicsCheck?.(values)}
          >
            Physics check
          </Button>
          {canCheck ? null : (
            <p id={physicsHelpId} className="type-micro text-text-3">
              {physicsDisabledReason}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
