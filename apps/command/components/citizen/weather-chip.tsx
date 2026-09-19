"use client";

export interface WeatherChipProps {
  city?: string;
  className?: string;
}

/**
 * The header's live-weather chip (UI_SPEC 5).
 *
 * The seam only, until task D-13 fills it: it renders nothing rather than a placeholder
 * temperature, because a number on this screen that no source supplied would break rule 6.
 */
export function WeatherChip(_props: WeatherChipProps) {
  return null;
}
