/**
 * 3D mode: Google's Photorealistic 3D Tiles as the ground every other VARUNA layer is draped on.
 *
 * **What this is for.** The streets, the depth raster, the surcharge markers and the routes are
 * all drawn at z = 0. Deck's terrain extension lets one layer declare itself the ground
 * (`operation: "terrain+draw"`) and lifts the rest onto it, so the same water that sits on a flat
 * map sits on a photographed Mumbai instead - the underpass at Hindmata is a real underpass, the
 * rail embankment at Sion is a real embankment, and 45 cm reads as 45 cm against something a
 * person recognises.
 *
 * **What it replaces.** `terrain.ts` built the ground from the city's own conditioned 30 m DEM
 * (ADR-0065). Three of its exports had nothing to do with that DEM and are carried over here,
 * renamed from "terrain" to "surface" because the ground is no longer ours:
 * `SURFACE_EXTENSION`, `onSurface` and `hiddenLayers`.
 *
 * **One deliberate change on the way across.** The old `onTerrain` *dropped* the `depth-raster`
 * layer, because in that mode the depth frame was literally the terrain mesh's texture and
 * draping it again would have drawn the water twice. Google's tiles carry their own photographic
 * texture and know nothing about our water, so `onSurface` keeps the raster and drapes it: drop
 * it here and 3D mode would show a dry city in a storm.
 *
 * **Workers, and why the CDN is refused.** loaders.gl resolves a decoder worker to
 * `https://unpkg.com/@loaders.gl/<module>@<version>/dist/<id>-worker.js` unless the application
 * supplies `workerUrl` per loader (`worker-utils/dist/lib/worker-api/get-worker-url.js`), and
 * CLAUDE.md 17 wants the finale to run with the venue's network off. So `photorealLoadOptions`
 * **never lets the unpkg URL be generated**: `workers: "local"` points Draco and Basis at bundles
 * this app serves from `/workers/`, copied out of `node_modules` by
 * `scripts/copy-loader-workers.mjs`, and `workers: "off"` decodes in place with
 * `core.worker: false`, which means `getWorkerURL` is never reached at all.
 *
 * **The local workers are checked before they are named, because nothing falls back from a 404.**
 * `@loaders.gl/core`'s `parseWithLoader` calls `parseWithWorker` with no try/catch when
 * `canParseWithWorker` says yes, and a worker script that 404s fires an `error` event that
 * rejects the parse - so the tile never appears, and the console logs an error, which CLAUDE.md
 * 14 makes a failing gate. `verifyLocalWorkers` therefore HEADs both bundles once and
 * `photorealLoadOptions` names them only after that has come back 200; until then, and forever if
 * the copy step was never run, it returns the main-thread options and the tile still decodes.
 * The ordering works out because the probe is a same-origin HEAD and `state` cannot be `ready`
 * until `tile.googleapis.com` has answered a round trip away.
 *
 * Driven with `public/workers/` deleted on 2026-09-23, this is what the fallback costs: two
 * browser-level "Failed to load resource: 404" lines, and every tile drawing anyway - 227 glTF
 * tiles, the same count and the same frame rate as with the workers in place. Chrome logs a
 * failed request whatever issued it, so those two lines cannot be suppressed from script; they
 * are the price of asking, and they are still cheaper than a worker error that loses the tile as
 * well. With the copy step run, which `pnpm dev` and `pnpm build` both do, there are none.
 *
 * **What none of this buys, and it must be said plainly.** Draco's own wasm decoder is fetched
 * from `https://www.gstatic.com/draco/versioned/decoders/<version>` whichever thread does the
 * decoding - the string is inside `draco-worker.js` itself - unless the application passes a
 * bundled `draco3d` through `options.modules`, and `draco3d` is not a dependency here. And the
 * tiles come from `tile.googleapis.com`. A photorealistic basemap is **online-only by
 * construction**: CLAUDE.md 17's offline finale is served by the `offline` state in
 * `lib/maps/photoreal.ts` saying so and by VARUNA's own map still being there, not by bundling
 * anything.
 *
 * **And on today's tiles neither worker is ever spun up.** Measured 2026-09-23 by walking the
 * tileset from the global root down to Hindmata junction and sampling 24 of the 216 glTF tiles on
 * that path, from geometric error 525,957 m to 2.006 m: all 24 declare
 * `extensionsUsed: ["KHR_materials_unlit"]` and nothing else, no mesh primitive carries
 * `KHR_draco_mesh_compression`, and every texture is `image/jpeg` rather than
 * `KHR_texture_basisu`. Google decodes Draco server-side - `asset.generator` reads
 * `"draco_decoder"` on all 24 - so the glTF arrives uncompressed and is parsed on the main thread
 * by `ImageLoader` and `createImageBitmap` whatever this module asks for. The local workers are
 * insurance against a format Google may change under us, not a measured speedup.
 *
 * **The frame rate, measured because nobody had.** Headed Chromium on the Iris Xe (D3D11), a
 * `next dev` build, `/console` at 1440 x 900, 10-second drags with the camera moving the whole
 * time, 12 node and 10 python processes from other work running. Zoomed to street level with 227
 * glTF tiles fetched: **mean 25.2 and 26.1 fps, median 29.9, p95 frame 50 ms, worst 100-117 ms**.
 * At the AOI-fit zoom the whole city is draped at once and it is worse: **mean 11.4-11.9 fps,
 * median 12**. The same harness with 3D off measures **mean 44.9 fps, median 59.2**, which is in
 * line with the numbers already in `docs/QA.md`, so the harness is sound and the cost is 3D's.
 * CLAUDE.md 14 asks for 55 fps: **3D misses it by a factor of two and this is not close.** It is
 * not the decode - with `public/workers/` deleted, so every tile decodes in place, the same run
 * measured mean 25.7 fps and fetched the same 227 tiles, within the spread of the worker runs. The
 * cost is draping every VARUNA layer onto the mesh each frame, and that is where a fix has to look.
 *
 * **This does draw.** The Map Tiles API is enabled and billed on the current Cloud project, the
 * root tileset answers HTTP 200 (with a key in a header, with a `?key=`, with and without a
 * `Referer`), and the integrator drove the console in a browser on 2026-09-23 and watched
 * VARUNA's water, routes and markers drape onto a photographed Mumbai. What is still only tested
 * at its seams here is what is built and with which options; the numbers above came from the
 * service itself.
 */

import { _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { Tile3DLayer } from "@deck.gl/geo-layers";
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";

import {
  PHOTOREAL_KEY_HEADER,
  PHOTOREAL_TILESET_URL,
  type PhotorealState,
} from "@/lib/maps/photoreal";

/** The one id the photorealistic ground is built under. */
export const PHOTOREAL_LAYER_ID = "photoreal";

/**
 * CLAUDE.md 6.7's 3D camera: "pitch 55 degrees".
 *
 * There is no exaggeration constant here, unlike `terrain.ts`'s 2x. That existed because a 30 m
 * DEM of a coastal plain is nearly flat and needed help to read as terrain; Google's tiles carry
 * buildings at their real heights, and stretching those would make the water's depth a lie about
 * a city the reader can recognise.
 */
export const PHOTOREAL_PITCH = 55;

/** Where the app serves the loaders.gl worker bundles from. */
export const LOCAL_WORKER_BASE = "/workers";

/**
 * The bundles `scripts/copy-loader-workers.mjs` publishes, keyed by the loaders.gl worker id that
 * names each one's `workerUrl` option.
 *
 * Exactly two, and the list came from the parser rather than the documentation: the glTF loader
 * reaches `DracoLoader` from `KHR_draco_mesh_compression.js` and parses every image with
 * `[ImageLoader, BasisLoader]`, and nothing else on the 3D Tiles path declares `worker: true`.
 */
export const LOCAL_WORKER_FILES = {
  draco: "draco-worker.js",
  basis: "basis-worker.js",
} as const;

/** Whether tile geometry and textures are decoded on a worker this app serves, or in place. */
export type PhotorealWorkers = "off" | "local";

/**
 * One probe per page, and a synchronous answer for the render path to read.
 *
 * `verified` only ever goes from false to true: a refusal means the copy step did not run, which
 * a reload cannot change, and re-probing on every layer build would put a fetch inside deck's
 * render loop.
 */
let workerProbe: Promise<boolean> | null = null;
let workersVerified = false;

/** Whether this app is actually serving both worker bundles. False until the probe says so. */
export function localWorkersVerified(): boolean {
  return workersVerified;
}

/** Forget the probe. For tests; the application has no reason to call it. */
export function resetLocalWorkerProbe(): void {
  workerProbe = null;
  workersVerified = false;
}

/**
 * Ask this origin, once, whether both worker bundles are really being served.
 *
 * A HEAD rather than a GET, because the question is whether the path resolves and not what is at
 * it - Next answers HEAD on a `public/` file with the same status and content type it answers GET
 * with, and 404s a missing one (measured against the dev server on 2026-09-23). A thrown fetch is
 * treated exactly like a 404: both mean the worker would fail to load, and the honest response to
 * either is to decode in place.
 *
 * `fetchImpl` is the seam the tests drive; production passes nothing and gets the platform's.
 */
export async function verifyLocalWorkers(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  workerProbe ??= (async () => {
    try {
      const answers = await Promise.all(
        Object.values(LOCAL_WORKER_FILES).map((file) =>
          fetchImpl(`${LOCAL_WORKER_BASE}/${file}`, { method: "HEAD" }),
        ),
      );
      return answers.every((answer) => answer.ok);
    } catch {
      // No network stack to this origin at all. Decoding in place still works.
      return false;
    }
  })();
  workersVerified = await workerProbe;
  return workersVerified;
}

/**
 * The loader options the tileset is fetched and decoded with.
 *
 * The key travels as a request header, never as a query parameter: a `?key=` would put it in the
 * browser's history, in the `Referer` of anything the page loads next, and in Google's own access
 * logs against this origin.
 *
 * Asking for `"local"` is a request, not a promise. The workers are named only once
 * `verifyLocalWorkers` has seen both bundles answer, because loaders.gl has no fallback from a
 * worker that fails to load: it would reject the parse, lose the tile and log an error. Until
 * then this returns the same main-thread options as `"off"`, which decode every tile correctly,
 * only on the thread that is also drawing.
 */
export function photorealLoadOptions(key: string, workers: PhotorealWorkers = "local") {
  const fetchOptions = { fetch: { headers: { [PHOTOREAL_KEY_HEADER]: key } } };
  if (workers === "local" && localWorkersVerified()) {
    return {
      ...fetchOptions,
      // Naming `workerUrl` per loader is what stops `getWorkerURL` reaching its unpkg branch.
      draco: { workerUrl: `${LOCAL_WORKER_BASE}/${LOCAL_WORKER_FILES.draco}` },
      basis: { workerUrl: `${LOCAL_WORKER_BASE}/${LOCAL_WORKER_FILES.basis}` },
    };
  }
  // `core.worker: false` means no worker URL is ever generated, so no CDN is ever consulted.
  return { ...fetchOptions, core: { worker: false } };
}

/** A tile as far as the credits are concerned: everything else about it is deck's business. */
interface CreditedTile {
  content?: { gltf?: { asset?: { copyright?: unknown } } } | null;
}

/**
 * Every copyright string among the tiles currently selected for drawing.
 *
 * Google's attribution requirement is about what is *on screen*, which is what a traversal's
 * selected set is - not what has been downloaded, and not what the tileset contains. Tiles whose
 * content has not arrived yet, or which carry no `asset.copyright`, are skipped rather than
 * counted as an empty provider; a tile that is still loading is not yet being shown to anyone.
 */
export function collectTileCredits(tiles: readonly unknown[]): string[] {
  const parts: string[] = [];
  for (const tile of tiles) {
    const copyright = (tile as CreditedTile | null)?.content?.gltf?.asset?.copyright;
    if (typeof copyright === "string" && copyright.trim()) parts.push(copyright);
  }
  return parts;
}

export interface PhotorealLayerOptions {
  /** The browser key, from `googleMapsKey()`. No key, no layer. */
  key: string | null;
  /** The probe's verdict. Anything but `ready` draws nothing. */
  state: PhotorealState;
  /** 0 to 1. The X-ray mode fades the photographed surface down to reveal the drains (M28). */
  opacity?: number;
  /**
   * How long an opacity change takes, in ms. The integrator passes `DUR_MS.crossFade`; this
   * module deliberately does not import `lib/motion.ts`, so the motion catalogue stays one file
   * with one owner and a layer cannot invent a duration that is not in section 8's table.
   */
  fadeMs?: number;
  /** Where the on-screen tiles' copyright strings go, once per traversal. */
  onCredits?: (parts: readonly string[]) => void;
  /**
   * Decoder placement; see the module docstring. Defaults to `"local"`, which is a request for
   * this app's own worker bundles and falls back to decoding in place if they are not served.
   */
  workers?: PhotorealWorkers;
}

/**
 * The photorealistic ground, or nothing at all.
 *
 * Returns `[]` for every state but `ready`, and for a missing key, so a disabled API costs the
 * console one chip of honest copy rather than a layer that requests tiles it will never be given.
 */
export function photorealLayers({
  key,
  state,
  opacity = 1,
  fadeMs = 0,
  onCredits,
  workers = "local",
}: PhotorealLayerOptions): unknown[] {
  // Started before the state check on purpose, and it matters which build gets there first.
  // `city-map.tsx` builds this list from the console's own mount, with `state.kind === "off"`,
  // long before anyone presses 3 - and even on the toggle itself a same-origin HEAD settles well
  // inside the round trip `usePhotorealTileset` is making to tile.googleapis.com. So by the time
  // there is a tileset to build, the verdict is in and its first traversal already names the
  // workers. `verifyLocalWorkers` caches its own promise, so a later build costs one read of a
  // boolean. If the verdict somehow has not landed, that tileset decodes in place for its life,
  // which is slower and correct rather than fast and missing.
  if (workers === "local" && !localWorkersVerified()) void verifyLocalWorkers();
  if (!key || state.kind !== "ready") return [];
  return [
    new Tile3DLayer({
      id: PHOTOREAL_LAYER_ID,
      data: PHOTOREAL_TILESET_URL,
      loader: Tiles3DLoader,
      loadOptions: photorealLoadOptions(key, workers),
      // Deck's terrain extension drapes every layer carrying `SURFACE_EXTENSION` onto this one.
      operation: "terrain+draw",
      opacity,
      // Motion row M28: the surface fades down while the drains fade up. A zero duration is a
      // cut, which is also the reduced-motion fallback the integrator passes.
      transitions: fadeMs > 0 ? { opacity: fadeMs } : {},
      // The photograph is the ground, not a thing to interrogate: a click belongs to the street
      // under the cursor, which is a VARUNA layer with a forecast behind it.
      pickable: false,
      onTilesetLoad: (tileset: unknown) => {
        if (!onCredits) return;
        const target = tileset as { options?: Record<string, unknown> };
        if (!target?.options) return;
        // The tileset asks this on every traversal and expects its list back unchanged; it is a
        // hook, not a filter, and returning anything else would change what gets drawn.
        target.options.onTraversalComplete = (selectedTiles: readonly unknown[]) => {
          onCredits(collectTileCredits(selectedTiles));
          return selectedTiles;
        };
      },
    } as never),
  ];
}

/** The one extension every other layer gets in 3D, so it lies on the ground instead of under it. */
export const SURFACE_EXTENSION = new TerrainExtension();

/**
 * Put a layer on the photorealistic surface.
 *
 * Carried over from `terrain.ts`'s `onTerrain`, including the id-suffix fix, which is a real bug
 * and not a style choice: **a new id, so deck builds the layer fresh with the terrain shader
 * module in it. A clone under the flat layer's id keeps the flat layer's compiled shaders, which
 * have no `terrain_map` binding: luma warns once per layer and the layer draws under the ground.**
 *
 * Unlike `onTerrain` this keeps `depth-raster` and drapes it. There, the depth frame *was* the
 * ground's texture; here the ground is a photograph of Mumbai that has never heard of the storm,
 * so dropping the raster would drape a dry city over a flooded one.
 */
export function onSurface(layers: readonly unknown[]): unknown[] {
  return layers.map((layer) => {
    const l = layer as {
      props: { extensions?: unknown[]; id?: string };
      clone: (p: object) => unknown;
    };
    return l.clone({
      id: `${l.props.id ?? "layer"}-3d`,
      extensions: [...(l.props.extensions ?? []), SURFACE_EXTENSION],
    });
  });
}

/**
 * The flat map kept alive but not drawn while 3D is on, so leaving 3D never re-creates it.
 *
 * Carried over unchanged from `terrain.ts`, where the reason was measured: dropped layers are
 * finalised, and re-creating them on the way out of 3D tore the terrain effect down in the same
 * frame - an assertion per layer and a wave of WebGL errors. Hidden, they are never
 * re-initialised, and the satellite basemap keeps its tile cache.
 */
export function hiddenLayers(layers: readonly unknown[]): unknown[] {
  return layers.map((layer) =>
    (layer as { clone: (p: object) => unknown }).clone({ visible: false }),
  );
}
