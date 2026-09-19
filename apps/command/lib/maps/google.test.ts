import { afterEach, describe, expect, it, vi } from "vitest";

import { googleFallbackNotice, googleMapsKey } from "./google";

const NAME = "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("googleMapsKey", () => {
  it("returns the key when one is configured", () => {
    vi.stubEnv(NAME, "a-browser-key");
    expect(googleMapsKey()).toBe("a-browser-key");
  });

  it("trims surrounding whitespace, which a copied .env line carries", () => {
    vi.stubEnv(NAME, "  a-browser-key\n");
    expect(googleMapsKey()).toBe("a-browser-key");
  });

  it.each(["", "   ", "undefined", "null"])(
    "reads %o as no key at all, the way basemap.ts reads its own",
    (value) => {
      vi.stubEnv(NAME, value);
      expect(googleMapsKey()).toBeNull();
    },
  );

  it("returns null when the variable is not set", () => {
    vi.stubEnv(NAME, undefined);
    expect(googleMapsKey()).toBeNull();
  });
});

describe("googleFallbackNotice", () => {
  it("names the cause and what the reader is looking at instead", () => {
    expect(googleFallbackNotice("no-key")).toBe(
      "No Google Maps key is configured; showing VARUNA's own map.",
    );
    expect(googleFallbackNotice("timeout")).toContain("did not load in time");
    expect(googleFallbackNotice("error")).toContain("VARUNA's own map");
  });

  it("never says only that something went wrong (CLAUDE.md 6.8)", () => {
    for (const reason of ["no-key", "timeout", "error"] as const) {
      expect(googleFallbackNotice(reason)).not.toMatch(/something went wrong/i);
      expect(googleFallbackNotice(reason)).toMatch(/VARUNA's own map/);
    }
  });
});
