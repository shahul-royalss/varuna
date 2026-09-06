import { ImageResponse } from "next/og";

export const alt = "VARUNA - every street, three hours early";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/* The OG image is rendered by Satori without the stylesheet, so the tokens are literals here.
 * They are the same values as `tokens.json`. */
const INK = "#0A1020"; // lint-design-allow: og image has no stylesheet; equals --ink
const TIDE = "#2DD4BF"; // lint-design-allow: og image has no stylesheet; equals --tide
const TEXT = "#E3EAF6"; // lint-design-allow: og image has no stylesheet; equals --text
const TEXT_2 = "#A7B4CC"; // lint-design-allow: og image has no stylesheet; equals --text-2
const LINE = "#24314F"; // lint-design-allow: og image has no stylesheet; equals --line

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: INK,
          padding: 72,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="56" height="56" viewBox="0 0 64 64" fill="none">
            <g stroke={TIDE} strokeWidth="4.6" strokeLinecap="round">
              <path d="M8 18.7c6-6.4 12-6.4 18 0s12 6.4 18 0 6-6.4 12 0" />
              <path d="M8 32c6-6.4 12-6.4 18 0s12 6.4 18 0 6-6.4 12 0" opacity="0.7" />
              <path d="M8 45.3c6-6.4 12-6.4 18 0s12 6.4 18 0 6-6.4 12 0" opacity="0.4" />
            </g>
          </svg>
          <div style={{ color: TEXT, fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>VARUNA</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              color: TEXT,
              fontSize: 86,
              fontWeight: 700,
              letterSpacing: -2.4,
              lineHeight: 1.05,
              maxWidth: 900,
            }}
          >
            Every street. Three hours early.
          </div>
          <div style={{ color: TEXT_2, fontSize: 30, maxWidth: 940, lineHeight: 1.35 }}>
            Street-level urban flood nowcasting for Mumbai: radar to depth in centimetres, a drain
            map that learns, and routes around what is coming.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `2px solid ${LINE}`,
            paddingTop: 28,
            color: TEXT_2,
            fontSize: 24,
          }}
        >
          <div style={{ display: "flex" }}>SIH 2026 - PS SIH26085 - Ministry of Earth Sciences</div>
          <div style={{ display: "flex", color: TIDE }}>Reconstructed replay, 2 July 2019</div>
        </div>
      </div>
    ),
    size,
  );
}
