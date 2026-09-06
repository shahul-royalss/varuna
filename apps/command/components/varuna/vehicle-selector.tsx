"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PROFILE_LABELS, type VehicleProfile } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";

/** The four profiles the public map offers; the rescue profiles live in the console. */
export const PUBLIC_PROFILES = ["two-wheeler", "car", "bus", "pedestrian"] as const;
export type PublicProfile = (typeof PUBLIC_PROFILES)[number];

export function isPublicProfile(value: string): value is PublicProfile {
  return (PUBLIC_PROFILES as readonly string[]).includes(value);
}

export interface VehicleSelectorProps {
  value: PublicProfile;
  onValueChange: (profile: PublicProfile) => void;
  className?: string;
}

/**
 * Vehicle picker for the public map (CLAUDE.md section 7.11). Items are 44 px tall so a thumb
 * hits them on a 390 px phone, and the label is text as well as colour.
 */
export function VehicleSelector({ value, onValueChange, className }: VehicleSelectorProps) {
  return (
    <ToggleGroup
      aria-label="Vehicle"
      variant="outline"
      spacing={0}
      value={[value]}
      onValueChange={(next) => {
        const picked = (next as string[])[0];
        if (picked && isPublicProfile(picked)) onValueChange(picked);
      }}
      className={cn("w-full", className)}
    >
      {PUBLIC_PROFILES.map((profile) => (
        <ToggleGroupItem
          key={profile}
          value={profile}
          aria-label={PROFILE_LABELS[profile as VehicleProfile]}
          className="h-11 flex-1 type-small"
        >
          {PROFILE_LABELS[profile as VehicleProfile]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
