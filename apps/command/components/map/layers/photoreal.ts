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
 * **Workers, and why the CDN is still refused.** loaders.gl resolves a decoder worker to
 * `https://unpkg.com/@loaders.gl/<module>@<version>/dist/<id>-worker.js` unless the application
 * supplies `workerUrl` per loader (`worker-utils/dist/lib/worker-api/get-worker-url.js`), and
 * this repository has refused a loaders.gl CDN worker once already - `terrain.ts` decodes its
 * heightmap on the main thread for exactly this reason. So `photorealLoadOptions` **never lets
 * the unpkg URL be generated**: by default it decodes on the main thread (`core.worker: false`,
 * which means `getWorkerURL` is never reached), and `workers: "local"` instead points Draco and
 * Basis at bundles this app serves from `/workers/`.
 *
 * Main-thread decoding is the default rather than the local workers because **those bundles are
 * not in this tree yet**: `@loaders.gl/draco/dist/draco-worker.js` (38,094 bytes) and
 * `@loaders.gl/textures/dist/basis-worker.js` (31,469 bytes) are self-contained IIFEs sitting in
 * `node_modules`, but copying them into `apps/command/public/workers/` needs a build step in
 * files this module does not own (see `.wf/TILES-requests.md`). A `workerUrl` pointing at a 404
 * is a worse failure than a slow decode, because nothing falls back from it. Flip the default the
 * moment the copy step lands.
 *
 * **What none of that buys, and it must be said plainly.** Draco's own decoder is fetched from
 * `https://www.gstatic.com/draco/versioned/decoders/1.5.6/` whichever thread does the decoding,
 * unless the application passes a bundled `draco3d` through `options.modules` - read out of
 * `@loaders.gl/draco/dist/lib/draco-module-loader.js`, not assumed. And the tiles themselves come
 * from `tile.googleapis.com`. A photorealistic basemap is therefore **online-only by
 * construction**: CLAUDE.md 17's offline finale is served by the `offline` state in
 * `lib/maps/photoreal.ts` saying so and by VARUNA's own map still being there, not by bundling
 * anything.
 *
 * **Nothing here has been seen drawing a tile.** The Map Tiles API is disabled on this key's
 * Cloud project (measured 2026-09-23; see `lib/maps/photoreal.ts`), so the layer below is written
 * against Google's and deck.gl's documented contract and tested at its seams - what is built,
 * with which options, and what is done with the credits - and not against a rendered frame.
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

/** Where the app serves the loaders.gl worker bundles from, when it serves them. */
export const LOCAL_WORKER_BASE = "/workers";

/** Whether tile geometry and textures are decoded on a worker this app serves, or in place. */
export type PhotorealWorkers = "off" | "local";

/**
 * The loader options the tileset is fetched and decoded with.
 *
 * The key travels as a request header, never as a query parameter: a `?key=` would put it in the
 * browser's history, in the `Referer` of anything the page loads next, and in Google's own access
 * logs against this origin.
 */
export function photorealLoadOptions(key: string, workers: PhotorealWorkers = "off") {
  const fetchOptions = { fetch: { headers: { [PHOTOREAL_KEY_HEADER]: key } } };
  if (workers === "local") {
    return {
      ...fetchOptions,
      // Naming `workerUrl` per loader is what stops `getWorkerURL` reaching its unpkg branch.
      draco: { workerUrl: `${LOCAL_WORKER_BASE}/draco-worker.js` },
      basis: { workerUrl: `${LOCAL_WORKER_BASE}/basis-worker.js` },
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
  /** Decoder placement; see the module docstring. */
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
  workers = "off",
}: PhotorealLayerOptions): unknown[] {
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
