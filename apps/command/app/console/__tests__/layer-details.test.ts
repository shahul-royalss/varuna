/**
 * The two sentences under the console's new layer rows, and the keys that switch them.
 *
 * CLAUDE.md 17 forbids a dead control and P6.13 fixed exactly the defect this guards: four layer
 * shortcuts were advertised by the `?` overlay while nothing handled them. Two more rows and one
 * more key have just been added, so the registry, the overlay's list and the panel's rows are
 * pinned to each other here rather than kept in step by hand.
 *
 * The detail sentences matter as much as the switches. On this build the Map Tiles API is
 * disabled on the key's Cloud project, so `photorealDetail` is what a judge reads when they press
 * 3 - and a sentence that does not name the switch and the page it is thrown on is not a fix
 * (section 6.8).
 */

import { describe, expect, it } from "vitest";

import { photorealDetail, xrayDetail } from "../console-screen";
import { classifyPhotorealProbe, photorealNotice } from "@/lib/maps/photoreal";
import { LAYER_KEYS, SHORTCUTS } from "@/lib/shortcuts";
import type { Drains3dReady } from "@/components/map/layers/drains-3d";

/** A `ready` result with nothing interesting in it, so each test adds only what it is about. */
function ready(over: Partial<Drains3dReady> = {}): Drains3dReady {
  return {
    kind: "ready",
    layers: [],
    pipesDrawn: 1200,
    pipesWithoutElevation: 0,
    adverseDrawn: 0,
    shaftsDrawn: 40,
    outfallsDrawn: 0,
    tidalOutfallsDrawn: 0,
    shaftsGated: false,
    exaggerationApplied: true,
    pipesWithoutGround: 0,
    ...over,
  };
}

describe("photorealDetail", () => {
  it("says nothing while 3D is off - an unasked question needs no answer", () => {
    expect(photorealDetail({ kind: "off" })).toBeUndefined();
  });

  it("says what it is waiting for rather than going quiet", () => {
    expect(photorealDetail({ kind: "loading" })).toMatch(/Asking Google/);
  });

  it("prints the unavailable sentence whole, so the reason keeps its fix", () => {
    const message = photorealNotice("api-disabled");
    expect(photorealDetail({ kind: "unavailable", reason: "api-disabled", message })).toBe(message);
    // It has to name the API and what to do about it, not just that something is off.
    expect(message).toMatch(/Map Tiles API/);
    expect(message).toMatch(/enable/i);
  });

  it("quotes Google verbatim for an answer it has no name for", () => {
    // Not hypothetical. Measured 2026-09-23: the tileset serves this key from the browser, but
    // the same GET from curl on the same machine - no Referer, and the key is referrer
    // restricted - answers HTTP 404 with
    // {"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}.
    // That is what a reader sees the day their origin is not on the key's list, and it is not
    // one of the four reasons VARUNA can name a fix for, so the console prints Google's own
    // sentence rather than inventing a diagnosis for it.
    const state = classifyPhotorealProbe(
      404,
      JSON.stringify({
        error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" },
      }),
    );
    expect(state).toMatchObject({ kind: "unavailable", reason: "error" });
    const line = photorealDetail(state);
    expect(line).toContain("Requested entity was not found.");
    expect(line).toMatch(/Google Cloud console/);
  });

  it("describes what is drawn once the tiles are answering", () => {
    expect(photorealDetail({ kind: "ready" })).toMatch(/photorealistic Mumbai/);
  });
});

describe("xrayDetail", () => {
  it("says nothing while the X-ray is off", () => {
    expect(xrayDetail({ kind: "off" }, false, 1)).toBeUndefined();
  });

  it("passes an unavailable message through untouched", () => {
    const message = "The drain layer carries no invert elevations; run make city CITY=mumbai.";
    expect(xrayDetail({ kind: "unavailable", message }, false, 1)).toBe(message);
  });

  it("points a flat reader at the view the pipes are meant to be read in", () => {
    expect(xrayDetail(ready(), false, 1)).toMatch(/Switch the photorealistic city on/);
  });

  it("admits the vertical datum has not been reconciled once the tiles are the ground", () => {
    // `.wf/DRAINS-requests.md` section 5: nobody measured the geoid separation, the offset is 0,
    // and a screen that stayed quiet about it would present a guess as a placement.
    const line = xrayDetail(ready(), true, 1);
    expect(line).toMatch(/has not been measured/);
    expect(line).not.toMatch(/Switch the photorealistic city on/);
  });

  it("labels a stretched depth every time it is not the real one", () => {
    expect(xrayDetail(ready(), true, 4)).toMatch(/stretched 4x/);
    expect(xrayDetail(ready(), true, 1)).not.toMatch(/stretched/);
  });

  it("carries the X-ray's own counts rather than restating them", () => {
    expect(xrayDetail(ready({ pipesDrawn: 1200 }), true, 1)).toMatch(/1,200 inferred pipes/);
  });
});

describe("the drain X-ray's key", () => {
  it("is registrable: X is in the layer registry the console registers against", () => {
    expect(LAYER_KEYS).toContain("x");
  });

  it("is listed by the `?` overlay", () => {
    const listed = SHORTCUTS.find((s) => s.id === "xray");
    expect(listed).toBeDefined();
    expect(listed?.keys).toEqual(["X"]);
    expect(listed?.group).toBe("Layers");
  });

  it("leaves every advertised layer key one the registry can dispatch (P6.13)", () => {
    const advertised = SHORTCUTS.filter((s) => s.group === "Layers").flatMap((s) => s.keys);
    for (const key of advertised) {
      expect(LAYER_KEYS as readonly string[]).toContain(key.toLowerCase());
    }
  });
});
