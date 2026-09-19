/**
 * The Google Maps browser key, and what the citizen map does when it is not usable.
 *
 * Google is a **basemap only** on this product (TECH_SPEC 0): the key is HTTP-referrer restricted,
 * and Directions, Geocoding, Static Maps and Places all answer `REQUEST_DENIED` server-side. Every
 * route, every marker and every depth on the citizen screen comes from VARUNA's own artifacts, so
 * a refused key costs the reader a prettier basemap and nothing else.
 *
 * The reader copies `components/map/basemap.ts`'s rule for a public variable exactly: Next inlines
 * an unset `NEXT_PUBLIC_*` as the literal string "undefined", so that reads as absent, as does
 * "null" and as does whitespace.
 */

/**
 * The key, or `null` when there is none to use.
 *
 * `process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is written out in full because Next replaces that
 * exact expression at build time; a computed lookup would read an empty object in the browser.
 */
export function googleMapsKey(): string | null {
  const raw = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value === "undefined" || value === "null") return null;
  return value;
}

/**
 * How long the citizen map waits for Google's bootstrap before drawing VARUNA's own map instead
 * (TECH_SPEC 2.5).
 *
 * Four seconds, not forty: a reader standing in the rain is owed a map, and the fallback carries
 * the same streets, the same depths and the same route. A slow network is therefore a different
 * basemap, never a blank pane.
 */
export const GOOGLE_BOOTSTRAP_TIMEOUT_MS = 4_000;

/** Why the citizen map is drawing VARUNA's own basemap rather than Google's. */
export type GoogleFallbackReason = "no-key" | "timeout" | "error";

/**
 * The notice shown beside the fallback map, one sentence per cause.
 *
 * Each names what happened and what the reader is looking at instead, per CLAUDE.md 6.8 - never
 * "something went wrong", and never silence, because a reader who cannot tell which basemap they
 * are on cannot tell whether the water is real either.
 */
export function googleFallbackNotice(reason: GoogleFallbackReason): string {
  if (reason === "no-key") {
    return "No Google Maps key is configured; showing VARUNA's own map.";
  }
  if (reason === "timeout") {
    return "Google Maps did not load in time; showing VARUNA's own map.";
  }
  return "Google Maps did not load; showing VARUNA's own map.";
}
