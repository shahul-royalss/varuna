import { describe, expect, it, vi } from "vitest";

import { PHOTOREAL_TILESET_URL, type PhotorealState } from "@/lib/maps/photoreal";
import {
  collectTileCredits,
  hiddenLayers,
  LOCAL_WORKER_BASE,
  onSurface,
  PHOTOREAL_LAYER_ID,
  photorealLayers,
  photorealLoadOptions,
  SURFACE_EXTENSION,
} from "../photoreal";

const READY: PhotorealState = { kind: "ready" };
const DISABLED: PhotorealState = {
  kind: "unavailable",
  reason: "api-disabled",
  message: "anything",
};

/** A stand-in for a deck layer: the two things `onSurface` and `hiddenLayers` touch. */
function fakeLayer(id: string, extensions: unknown[] = []) {
  const layer = {
    props: { id, extensions } as Record<string, unknown>,
    clone(patch: object) {
      return { ...layer, props: { ...layer.props, ...patch } };
    },
  };
  return layer;
}

type BuiltLayer = { props: Record<string, unknown> };

describe("photorealLoadOptions", () => {
  it("carries the key in a header and never in a URL", () => {
    const options = photorealLoadOptions("test-key");
    expect(options.fetch.headers).toEqual({ "X-GOOG-API-KEY": "test-key" });
    expect(JSON.stringify(options)).not.toContain("?key=");
  });

  it("decodes in place by default, which is what keeps unpkg out of the loop", () => {
    // `core.worker: false` means loaders.gl never reaches `getWorkerURL`, so the CDN branch that
    // would produce `https://unpkg.com/@loaders.gl/...` is never evaluated at all.
    expect(photorealLoadOptions("test-key")).toMatchObject({ core: { worker: false } });
    expect(JSON.stringify(photorealLoadOptions("test-key"))).not.toContain("unpkg");
  });

  it("points Draco and Basis at this app's own workers when asked, still never at a CDN", () => {
    const options = photorealLoadOptions("test-key", "local");
    const serialised = JSON.stringify(options);
    expect(serialised).toContain(`${LOCAL_WORKER_BASE}/draco-worker.js`);
    expect(serialised).toContain(`${LOCAL_WORKER_BASE}/basis-worker.js`);
    expect(serialised).not.toContain("unpkg");
    expect(serialised).not.toContain("http");
    // Naming a worker URL is itself what suppresses the generated one, so `worker: false` would
    // be redundant here - and would throw the workers away again.
    expect(options).not.toHaveProperty("core");
  });
});

describe("photorealLayers", () => {
  it("builds nothing without a key", () => {
    expect(photorealLayers({ key: null, state: READY })).toEqual([]);
  });

  it("builds nothing while the Map Tiles API is disabled, rather than requesting refused tiles", () => {
    expect(photorealLayers({ key: "test-key", state: DISABLED })).toEqual([]);
    expect(photorealLayers({ key: "test-key", state: { kind: "loading" } })).toEqual([]);
    expect(photorealLayers({ key: "test-key", state: { kind: "off" } })).toEqual([]);
  });

  it("builds one tileset that declares itself the ground", () => {
    const layers = photorealLayers({ key: "test-key", state: READY }) as BuiltLayer[];
    expect(layers).toHaveLength(1);
    expect(layers[0].props.id).toBe(PHOTOREAL_LAYER_ID);
    expect(layers[0].props.data).toBe(PHOTOREAL_TILESET_URL);
    // Without this, deck's terrain extension has nothing to drape the streets onto.
    expect(layers[0].props.operation).toBe("terrain+draw");
    expect(layers[0].props.pickable).toBe(false);
  });

  it("transitions opacity only when a duration is given (motion row M28)", () => {
    const cut = photorealLayers({ key: "k", state: READY, opacity: 0.2 }) as BuiltLayer[];
    expect(cut[0].props.opacity).toBe(0.2);
    expect(cut[0].props.transitions).toEqual({});

    const faded = photorealLayers({
      key: "k",
      state: READY,
      opacity: 0.2,
      fadeMs: 300,
    }) as BuiltLayer[];
    expect(faded[0].props.transitions).toEqual({ opacity: 300 });
  });

  it("harvests the on-screen tiles' credits every traversal and hands the list back unchanged", () => {
    const onCredits = vi.fn();
    const layers = photorealLayers({ key: "k", state: READY, onCredits }) as BuiltLayer[];

    const tileset = { options: {} as Record<string, unknown> };
    (layers[0].props.onTilesetLoad as (t: unknown) => void)(tileset);

    const traversal = tileset.options.onTraversalComplete as (
      t: readonly unknown[],
    ) => readonly unknown[];
    expect(typeof traversal).toBe("function");

    const selected = [
      { content: { gltf: { asset: { copyright: "Airbus; Maxar Technologies" } } } },
      { content: { gltf: { asset: { copyright: "Airbus" } } } },
    ];
    // The tileset draws what this returns, so returning anything but the same list would change
    // the picture.
    expect(traversal(selected)).toBe(selected);
    expect(onCredits).toHaveBeenCalledWith(["Airbus; Maxar Technologies", "Airbus"]);
  });

  it("does not reach into a tileset that has no options object", () => {
    const layers = photorealLayers({
      key: "k",
      state: READY,
      onCredits: vi.fn(),
    }) as BuiltLayer[];
    expect(() => (layers[0].props.onTilesetLoad as (t: unknown) => void)(null)).not.toThrow();
  });
});

describe("collectTileCredits", () => {
  it("skips tiles whose content has not arrived, which are not on screen yet", () => {
    expect(
      collectTileCredits([
        { content: null },
        {},
        { content: { gltf: {} } },
        { content: { gltf: { asset: {} } } },
        { content: { gltf: { asset: { copyright: "   " } } } },
        { content: { gltf: { asset: { copyright: "Airbus" } } } },
      ]),
    ).toEqual(["Airbus"]);
  });

  it("survives a null in the selected set", () => {
    expect(collectTileCredits([null, undefined])).toEqual([]);
  });
});

describe("onSurface", () => {
  it("drapes the depth raster rather than dropping it", () => {
    // The change from `terrain.ts`'s `onTerrain`. There the depth frame was the ground's own
    // texture, so draping it again drew the water twice; here the ground is a photograph that has
    // never heard of the storm, and dropping the raster would show a dry city in a cloudburst.
    const draped = onSurface([fakeLayer("depth-raster")]) as BuiltLayer[];
    expect(draped).toHaveLength(1);
    expect(draped[0].props.id).toBe("depth-raster-3d");
    expect(draped[0].props.extensions).toContain(SURFACE_EXTENSION);
  });

  it("keeps every layer it is given, one for one", () => {
    const ids = ["streets", "depth-raster", "surcharge", "routes"];
    const draped = onSurface(ids.map((id) => fakeLayer(id))) as BuiltLayer[];
    expect(draped.map((l) => l.props.id)).toEqual(ids.map((id) => `${id}-3d`));
  });

  it("gives each clone a new id, so deck compiles the terrain shader into it", () => {
    // Not cosmetic: a clone under the flat layer's id keeps the flat layer's compiled shaders,
    // which have no `terrain_map` binding, and the layer then draws under the ground.
    const [draped] = onSurface([fakeLayer("streets")]) as BuiltLayer[];
    expect(draped.props.id).not.toBe("streets");
  });

  it("adds the extension to whatever a layer already carries", () => {
    const existing = { name: "dash" };
    const [draped] = onSurface([fakeLayer("reversed-flow", [existing])]) as BuiltLayer[];
    expect(draped.props.extensions).toEqual([existing, SURFACE_EXTENSION]);
  });
});

describe("hiddenLayers", () => {
  it("hides the flat map without finalising it, so leaving 3D costs nothing", () => {
    const hidden = hiddenLayers([fakeLayer("streets"), fakeLayer("satellite")]) as BuiltLayer[];
    expect(hidden.map((l) => l.props.visible)).toEqual([false, false]);
    // Same ids: these are the flat layers, still alive, not new ones.
    expect(hidden.map((l) => l.props.id)).toEqual(["streets", "satellite"]);
  });
});
