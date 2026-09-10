/**
 * The satellite basemap (CLAUDE.md 6.7's basemap slot, filled at last).
 *
 * **Why this works where MapLibre did not.** The note at the top of `CityMap` records why this map
 * has run without a basemap: MapLibre decodes vector tiles in a web worker, that worker does not
 * load under this bundler, and a permanently blank basemap is worse than none. Raster imagery has
 * no worker and no style pipeline - deck.gl's own `TileLayer` fetches an image per tile and draws
 * it through a `BitmapLayer`, which is the same path the depth raster already takes. So the thing
 * that broke does not exist here.
 *
 * **The imagery is treated, not shown raw.** CLAUDE.md 6.1 is explicit that water is the one
 * memorable thing on this screen and everything else stays quiet, and raw satellite imagery is the
 * opposite of quiet: bright greens and browns at full saturation, competing with the depth ramp's
 * blue-to-red for exactly the attention the depth ramp needs. So the tiles are drawn dim and a
 * `--ink` scrim is laid over them. What survives is the *texture* a judge reads as a real city -
 * the coastline, the creeks, the airport, the density gradient from Colaba to Andheri - under
 * water that is still the brightest thing on the map.
 *
 * **Offline (CLAUDE.md 17).** Tiles come from a network service, and the finale may have none. A
 * failed tile is drawn as nothing rather than as an error, so the map falls back to exactly what
 * it renders today: the city's own building footprints and street network. Nothing is lost that
 * was not there before; the imagery is a gain when there is a network and silent when there is not.
 */

import { BitmapLayer } from "@deck.gl/layers";
import { TileLayer } from "@deck.gl/geo-layers";

/**
 * Esri World Imagery, the standard free-with-attribution aerial basemap.
 *
 * Note the `{z}/{y}/{x}` order - Esri's REST tile endpoint puts the row before the column, which
 * is the opposite of the `{z}/{x}/{y}` almost every other service uses. Getting it the usual way
 * round returns tiles from somewhere else entirely, or a 404, and the map looks broken in a way
 * that does not point at the cause.
 */
export const SATELLITE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

/** Attribution the map must carry while the imagery is drawn. */
export const SATELLITE_ATTRIBUTION =
  "Imagery: Esri, Maxar, Earthstar Geographics and the GIS User Community";

/** The whole map's credit, in one line.
 *
 * Both halves are always true: the imagery is Esri's when it loads, and every line and polygon
 * over it - the streets, the buildings, the drain graph, the terrain the depths were solved on -
 * is VARUNA's own derivation from open data. Splitting them across two lines put one behind the
 * "Reconstructed replay" chip; one line is also easier to read at a glance from across a room. */
export const MAP_ATTRIBUTION =
  "Imagery: Esri, Maxar · Roads: OpenStreetMap · Terrain: Copernicus GLO-30";

/** Tile pyramid limits. Below 8 the AOI is a speck; above 17 Esri has no imagery here. */
const MIN_ZOOM = 8;
const MAX_ZOOM = 17;
const TILE_SIZE = 256;

/**
 * How much of the imagery survives the treatment.
 *
 * Low on purpose. At full strength the imagery reads as the subject and the water reads as an
 * overlay on it; at this strength the city is a ground the water sits on, which is the order
 * CLAUDE.md 6.1 asks for. It is still plainly a photograph of Mumbai.
 */
const IMAGERY_OPACITY = 0.78;

/** Tiles kept in GPU memory. Enough for a scrub across the AOI without refetching. */
const MAX_CACHE_TILES = 220;

export interface SatelliteOptions {
  /** Drawn only when true; the layer is not built at all otherwise. */
  enabled: boolean;
  /** Dimmer still under a depth raster, which is itself a translucent sheet over the city. */
  dimmed?: boolean;
}

/** The basemap layers, bottom of the stack. Empty when the basemap is off. */
export function satelliteLayers({ enabled, dimmed = false }: SatelliteOptions): unknown[] {
  if (!enabled) return [];

  return [
    new TileLayer({
      id: "satellite",
      data: SATELLITE_URL,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      tileSize: TILE_SIZE,
      maxCacheSize: MAX_CACHE_TILES,
      // Show whatever is already decoded while the right zoom loads. Without this the map is
      // empty until every tile at the target level has arrived, which over a venue's network is
      // the first twenty seconds of the demo; with it a single coarse tile fills the AOI almost
      // at once and sharpens underneath the water.
      refinementStrategy: "best-available",
      // Esri answers quickly and the AOI is about thirty tiles at the fitted zoom; letting them
      // go out together costs nothing and removes the staircase of a serialised fetch.
      maxRequests: 16,
      // A tile that fails - no network, a rate limit, a gap in coverage - is simply not drawn.
      // deck logs it once and carries on, and the city's own GIS shows through underneath.
      onTileError: () => undefined,
      pickable: false,
      opacity: dimmed ? IMAGERY_OPACITY * 0.7 : IMAGERY_OPACITY,
      // deck types `tile.boundingBox` as `number[][]`, so the corners are read positionally.
      renderSubLayers: (props) => {
        const box = (props.tile as { boundingBox: number[][] }).boundingBox;
        const [west, south] = box[0] as [number, number];
        const [east, north] = box[1] as [number, number];
        return new BitmapLayer({
          id: props.id,
          image: props.data as never,
          bounds: [west, south, east, north],
          // The imagery is a ground, never a target: picking it would put a tile under every
          // hover instead of the street the operator is pointing at.
          pickable: false,
        });
      },
    }),
  ];
}
