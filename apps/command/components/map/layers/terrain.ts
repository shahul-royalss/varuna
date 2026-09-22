/**
 * 3D mode (CLAUDE.md 6.7, task P6.15): the city's own conditioned 30 m DEM as a deck.gl
 * `TerrainLayer`, with the current step's depth PNG draped on it, exaggerated 2x.
 *
 * **Where the heights come from.** `GET /v1/city/{city}/terrain.png` is the DEM the Twin routed
 * the water over, Terrarium-encoded (`R * 256 + G + B / 256 - 32768` metres) on the same
 * `n_rows x n_cols` grid and the same lon/lat bounds as every run's depth rasters
 * (`varuna_city.terrain_export`). So texel `(i, j)` of a depth frame is vertex `(i, j)` of the
 * ground and the water needs no resampling to sit on its street.
 *
 * **Why the mesh is built here rather than by the layer's loader.** `TerrainLayer` parses its
 * image with loaders.gl's `TerrainWorkerLoader`, which fetches a worker script from a CDN at run
 * time. CLAUDE.md 17 has the finale run with the network off, so that loader would leave 3D mode
 * blank on stage. The layer's `fetch` prop is its documented seam for supplying data another
 * way: this module decodes the PNG on the main thread (one 323 x 522 image, measured below) and
 * hands the layer a finished mesh - one vertex per DEM cell, no simplification, so every 30 m
 * cell the solver saw keeps its height.
 *
 * **The texture is a composite.** A depth frame is transparent where the street is dry, and a
 * textured mesh is transparent wherever its texture is, so draping the frame alone would draw
 * the water floating over nothing. Each frame is laid over a solid `--deep` ground once and
 * cached, so a scrub in 3D swaps one texture exactly as the flat raster swaps one bitmap.
 */

import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { TerrainLayer } from "@deck.gl/geo-layers";
import { useEffect, useState } from "react";

import { apiUrl } from "@/lib/api/client";
import { BUILDING_FILL, RASTER_OPACITY } from "./palette";

/** CLAUDE.md 6.7: "exaggeration 2x, pitch 55 degrees". */
export const TERRAIN_EXAGGERATION = 2;
export const TERRAIN_PITCH = 55;

/** The heightmap metadata `GET /v1/city/{city}/terrain` serves (`terrain.json`). */
export interface TerrainMeta {
  encoding: string;
  decoder: { r_scaler: number; g_scaler: number; b_scaler: number; offset: number };
  /** West, south, east, north: the depth rasters' own bounds. */
  bounds: [number, number, number, number];
  /** Rows, columns. */
  shape: [number, number];
  min_m: number;
  max_m: number;
  png_url?: string;
}

/** A finished mesh in the shape deck's `SimpleMeshLayer` takes. */
export interface TerrainMesh {
  attributes: {
    POSITION: { value: Float32Array; size: 3 };
    TEXCOORD_0: { value: Float32Array; size: 2 };
  };
  indices: { value: Uint32Array; size: 1 };
  /** Deck reads the z range from here to fit the camera's near and far planes. */
  header: {
    vertexCount: number;
    boundingBox: [[number, number, number], [number, number, number]];
  };
  mode: 4;
}

/**
 * One vertex per heightmap pixel, placed at the pixel's centre, in degree offsets from the
 * south-west corner (deck's `LNGLAT_OFFSETS`) so a float32 keeps sub-metre precision over the
 * AOI. Heights are decoded with the served decoder and multiplied by `exaggeration`.
 *
 * Texture coordinates put vertex `(row, col)` on texel `(row, col)` of a depth frame of the same
 * shape: `u = (col + 0.5) / cols`, `v = (row + 0.5) / rows` with row 0 at the north edge, which
 * is how the PNGs are written.
 */
export function buildTerrainMesh(
  rgba: ArrayLike<number>,
  cols: number,
  rows: number,
  meta: Pick<TerrainMeta, "bounds" | "decoder">,
  exaggeration = TERRAIN_EXAGGERATION,
): TerrainMesh {
  const [west, south, east, north] = meta.bounds;
  const { r_scaler: rs, g_scaler: gs, b_scaler: bs, offset } = meta.decoder;
  const dLon = (east - west) / cols;
  const dLat = (north - south) / rows;
  const n = cols * rows;
  const position = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const k = row * cols + col;
      const p = k * 4;
      const z = (rgba[p] * rs + rgba[p + 1] * gs + rgba[p + 2] * bs + offset) * exaggeration;
      position[k * 3] = (col + 0.5) * dLon;
      position[k * 3 + 1] = north - south - (row + 0.5) * dLat;
      position[k * 3 + 2] = z;
      uv[k * 2] = (col + 0.5) / cols;
      // deck samples textures with v = 0 at the image's first row, the north edge here.
      uv[k * 2 + 1] = (row + 0.5) / rows;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
  }
  const quads = Math.max(cols - 1, 0) * Math.max(rows - 1, 0);
  const indices = new Uint32Array(quads * 6);
  let i = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const a = row * cols + col;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices[i++] = a;
      indices[i++] = c;
      indices[i++] = b;
      indices[i++] = b;
      indices[i++] = c;
      indices[i++] = d;
    }
  }
  if (n === 0) {
    zMin = 0;
    zMax = 0;
  }
  return {
    attributes: {
      POSITION: { value: position, size: 3 },
      TEXCOORD_0: { value: uv, size: 2 },
    },
    indices: { value: indices, size: 1 },
    header: {
      vertexCount: indices.length,
      boundingBox: [
        [0, 0, zMin],
        [east - west, north - south, zMax],
      ],
    },
    mode: 4,
  };
}

export type TerrainState =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "ready"; meta: TerrainMeta; mesh: TerrainMesh; buildMs: number }
  | { kind: "error"; message: string };

/** One mesh per city for the life of the tab: turning 3D off and on again costs nothing. */
const meshes = new Map<
  string,
  Promise<{ meta: TerrainMeta; mesh: TerrainMesh; buildMs: number }>
>();

async function decodePng(url: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The heightmap answered ${response.status}.`);
  // `premultiplyAlpha: none` and no colour conversion: these bytes are heights, not colours, and
  // a colour-managed decode would move every one of them.
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser gave no 2D canvas to decode the heightmap with.");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    w: canvas.width,
    h: canvas.height,
  };
}

async function loadTerrain(city: string) {
  const response = await fetch(apiUrl(`/v1/city/${city}/terrain`));
  if (!response.ok) {
    let message = `The terrain for ${city} answered ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Keep the status line.
    }
    throw new Error(message);
  }
  const meta = (await response.json()) as TerrainMeta;
  if (meta.encoding !== "terrarium") {
    throw new Error(`The heightmap is ${meta.encoding}-encoded; 3D mode reads Terrarium.`);
  }
  const { data, w, h } = await decodePng(apiUrl(`/v1/city/${city}/terrain.png`));
  const started = performance.now();
  const mesh = buildTerrainMesh(data, w, h, meta);
  return { meta, mesh, buildMs: performance.now() - started };
}

/** The city's terrain mesh, fetched and built the first time 3D is turned on. */
export function useTerrain(city: string | undefined, enabled: boolean): TerrainState {
  const [state, setState] = useState<{ key: string; value: TerrainState } | null>(null);
  const key = city ?? "";

  useEffect(() => {
    if (!enabled || !city) return;
    let cancelled = false;
    let pending = meshes.get(city);
    if (!pending) {
      pending = loadTerrain(city);
      meshes.set(city, pending);
      // A failed load is not cached: the next toggle tries again.
      pending.catch(() => meshes.delete(city));
    }
    pending.then(
      (loaded) => {
        if (!cancelled) setState({ key, value: { kind: "ready", ...loaded } });
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            key,
            value: {
              kind: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [city, enabled, key]);

  if (!enabled || !city) return { kind: "off" };
  return state?.key === key ? state.value : { kind: "loading" };
}

/** Each depth frame laid over the ground once; a scrub in 3D then swaps a cached texture. */
const drapes = new WeakMap<ImageBitmap, HTMLCanvasElement>();
let groundOnly: HTMLCanvasElement | null = null;

function groundCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // The ground is `--deep`, the panel colour, written as pixels from the palette rather than
    // as a CSS colour string, so the token stays the only place the colour is spelled.
    const fill = ctx.createImageData(width, height);
    const [r, g, b] = BUILDING_FILL;
    for (let p = 0; p < fill.data.length; p += 4) {
      fill.data[p] = r;
      fill.data[p + 1] = g;
      fill.data[p + 2] = b;
      fill.data[p + 3] = 255;
    }
    ctx.putImageData(fill, 0, 0);
  }
  return canvas;
}

/** The texture for one step: the ground with the frame over it at the raster's own opacity. */
export function drapeFor(frame: ImageBitmap | null, shape: [number, number]): HTMLCanvasElement {
  const [rows, cols] = shape;
  if (!frame) {
    if (!groundOnly || groundOnly.width !== cols || groundOnly.height !== rows) {
      groundOnly = groundCanvas(cols, rows);
    }
    return groundOnly;
  }
  const cached = drapes.get(frame);
  if (cached) return cached;
  const canvas = groundCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // Section 6.7's raster opacity, so the water in 3D is the colour it is on the flat map.
    ctx.globalAlpha = RASTER_OPACITY;
    ctx.drawImage(frame, 0, 0);
  }
  drapes.set(frame, canvas);
  return canvas;
}

/**
 * `TerrainLayer` that takes its texture as a canvas.
 *
 * The stock layer's `texture` prop is a URL and deck validates it as one, throwing on anything
 * else. The mesh sub-layer underneath takes any image, so the texture is handed to that sub-layer
 * instead - the layer's geometry, loading and terrain role are the stock ones.
 */
class DrapedTerrainLayer extends TerrainLayer {
  static override layerName = "DrapedTerrainLayer";
  static override defaultProps = {
    ...TerrainLayer.defaultProps,
    drape: { type: "object" as const, value: null, compare: true },
    meshBounds: { type: "array" as const, value: null, compare: true },
  };

  override renderLayers() {
    const rendered = super.renderLayers();
    const { drape, meshBounds } = this.props as unknown as {
      drape?: HTMLCanvasElement | null;
      meshBounds?: TerrainMesh["header"]["boundingBox"] | null;
    };
    if (!rendered || Array.isArray(rendered) || !drape) return rendered;
    const mesh = (
      rendered as unknown as { clone: (p: object) => { getBounds: () => unknown } }
    ).clone({ texture: drape });
    // deck's terrain draping sizes the texture it renders draped layers into from the terrain
    // layer's `getBounds()`, which a single, non-instanced mesh reports as its one instance
    // position - a point, so the streets were draped into a texture of no area and vanished.
    // The mesh's own bounding box, in the layer's degree offsets, gives the drape the city.
    if (meshBounds) mesh.getBounds = () => meshBounds;
    return mesh as unknown as typeof rendered;
  }
}

/** The one extension every other layer gets in 3D, so it lies on the ground instead of under it. */
export const TERRAIN_EXTENSION = new TerrainExtension();

export interface TerrainLayerOptions {
  city: string;
  terrain: TerrainState;
  frame: ImageBitmap | null;
  /** The water raster is on: drape the frame. Off draws bare ground. */
  showRaster: boolean;
}

export function terrainLayers({
  city,
  terrain,
  frame,
  showRaster,
}: TerrainLayerOptions): unknown[] {
  if (terrain.kind !== "ready") return [];
  const { meta, mesh } = terrain;
  const [west, south] = meta.bounds;
  return [
    new DrapedTerrainLayer({
      id: "terrain",
      // A key, not a URL deck fetches: the `fetch` below answers it with the mesh already built.
      elevationData: `varuna-terrain:${city}`,
      fetch: () => Promise.resolve(mesh),
      bounds: meta.bounds,
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS,
      coordinateOrigin: [west, south, 0],
      // The ground is where every draped layer lands (deck's TerrainExtension).
      operation: "terrain+draw",
      drape: drapeFor(showRaster ? frame : null, meta.shape),
      meshBounds: mesh.header.boundingBox,
      pickable: false,
    } as never),
  ];
}

/**
 * Put a layer on the terrain. Streets, rings and markers are drawn at z = 0, which in 3D is
 * under a ground that stands 20 m up on average once exaggerated; the extension drapes lines and
 * polygons onto the mesh and lifts points to its surface.
 */
export function onTerrain(layers: readonly unknown[]): unknown[] {
  return layers.flatMap((layer) => {
    const l = layer as {
      props: { extensions?: unknown[]; id?: string };
      clone: (p: object) => unknown;
    };
    // The depth raster is the terrain's own texture in 3D; draped as well it would be drawn twice.
    if (l.props.id === "depth-raster") return [];
    return l.clone({
      // A new id, so deck builds the layer fresh with the terrain shader module in it. A clone
      // under the flat layer's id keeps the flat layer's compiled shaders, which have no
      // terrain_map binding: luma warns once per layer and the layer draws under the ground.
      id: `${(l.props as { id?: string }).id ?? "layer"}-3d`,
      extensions: [...(l.props.extensions ?? []), TERRAIN_EXTENSION],
    });
  });
}

/** The flat map kept alive but not drawn while 3D is on, so leaving 3D never re-creates it. */
export function hiddenLayers(layers: readonly unknown[]): unknown[] {
  return layers.map((layer) =>
    (layer as { clone: (p: object) => unknown }).clone({ visible: false }),
  );
}
