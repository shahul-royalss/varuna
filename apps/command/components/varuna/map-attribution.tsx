"use client";

/**
 * The attribution line for the photorealistic basemap: Google's wordmark and the providers of
 * the tiles currently on screen.
 *
 * **This is a licence term, not decoration.** Google's Map Tiles policy requires both the Google
 * attribution and the data providers of the tiles being displayed. The providers change as the
 * camera moves - flying from Dadar to the coast can swap Airbus for Maxar - so the line is fed
 * from `createCreditStore()` in `lib/maps/photoreal.ts`, which merges each traversal's
 * `asset.copyright` strings and notifies only when the merged line actually changes. A component
 * that re-rendered per traversal would cost the console frames it does not have: section 14's
 * budget is 55 fps and 3D already measures 50.4 (ADR-0065).
 *
 * **Text, not a logo.** Google permits a text-only "Google Maps" attribution where space is
 * tight, and text is what this renders - no bitmap, so there is no third-party image asset in
 * `public/` to license, to keep in `make pack`, or to get wrong at 2x.
 *
 * **Why it cannot be clicked.** The chip sits in the bottom-right corner of the map, over the
 * canvas, and a pointer-reactive element there would swallow drags that start on it. So it is
 * `pointer-events-none` and the visible line truncates to one line. The full list is still
 * *present*: CSS truncation clips pixels, not the DOM, so assistive technology and a page copy
 * both get every provider, and the `title` shows them on hover if a host ever gives this chip
 * pointer events. If a screen needs the list to be readable by a sighted user without hovering,
 * that belongs in a panel, not in a corner chip.
 */

import { cn } from "@/lib/utils";

/** The wordmark. Google's own text attribution, spelled once. */
export const GOOGLE_WORDMARK = "Google Maps";

export interface MapAttributionProps {
  /**
   * The merged provider line from `useMapCredits(store)` - "Airbus; Maxar Technologies". Empty
   * while the first tiles are still arriving, which is a chip reading only the wordmark rather
   * than a chip that pops into existence a second after the city does.
   */
  credits?: string;
  className?: string;
}

/** The whole line as one string: what the DOM carries and what `title` shows. */
export function attributionLine(credits?: string): string {
  const trimmed = credits?.trim();
  return trimmed ? `${GOOGLE_WORDMARK}; ${trimmed}` : GOOGLE_WORDMARK;
}

export function MapAttribution({ credits, className }: MapAttributionProps) {
  const line = attributionLine(credits);
  return (
    <p
      data-slot="map-attribution"
      title={line}
      className={cn(
        "rounded-control border-line bg-ink/80 text-text-2 type-micro pointer-events-none absolute right-2 bottom-2 z-10 max-w-[min(70%,56ch)] truncate border px-2 py-1",
        className,
      )}
    >
      {line}
    </p>
  );
}
