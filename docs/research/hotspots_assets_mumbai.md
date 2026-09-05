# Mumbai hotspot register and assets — verification notes (DRAFT, in progress)

Research agent output for VARUNA (SIH 2026, PS SIH26085). Accessed 2026-09-04/05 unless stated.
Scope: CLAUDE.md §3.3 (MUM-CENTRAL AOI: lon 72.815–72.905, lat 18.995–19.135), §10.1 steps 8–9, Appendix C.

Rules applied (CLAUDE.md §0 rules 6–7): every coordinate carries a geocode method (Nominatim query + OSM id, or an
Overpass element id); every "chronic spot" claim carries at least one public `source_url`; anything that could not be
sourced is marked *unsourced* and must not be shown as fact in the UI. Mobile-pump depot assignments are **synthetic**.

Status: this file is being written incrementally; sections marked (TODO) are still being filled.

## 0. Method

- Geocoding: Nominatim `https://nominatim.openstreetmap.org/search?q=<query>&format=jsonv2&limit=3` with
  viewbox 72.78,19.20,72.95,18.95 (unbounded), 1 request/s, UA `VARUNA-SIH2026-research/0.1`. Raw responses in
  `_raw/nominatim_*.json`; log in `_raw/nominatim_results.txt`.
- Overpass: `https://overpass-api.de/api/interpreter` queries in `_raw/overpass_*.ql`, responses in `_raw/overpass_*.json`.
- Web sources: fetched 2026-09-04/05; the URL recorded is the exact page read.

(Sections 1–4 follow.)
