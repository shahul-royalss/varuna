import type { MetadataRoute } from "next";

/**
 * Installable public map. Colours are literals because the manifest is read by the operating
 * system before any stylesheet loads; they equal --ink and --tide in `tokens.json`.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VARUNA",
    short_name: "VARUNA",
    description:
      "Street-by-street flood depth for the next three hours: which streets are passable, and until when.",
    start_url: "/map",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0A1020", // lint-design-allow: manifest colours must be literals; equals --ink
    theme_color: "#0A1020", // lint-design-allow: manifest colours must be literals; equals --ink
    categories: ["weather", "navigation", "utilities"],
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
