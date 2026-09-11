# Captured evidence — not authored work

Every file in this directory was **captured verbatim from a public source**. None of it was written
by the VARUNA team, and none of it is executed, imported or bundled by the build.

It is here because CLAUDE.md § 0 rules 6 and 7 require every number on screen and every
ground-truth pin to carry the source it was read from. Keeping the raw response means a claim in
`docs/research/data_sources.md` can be checked against what the server actually returned, rather
than against a summary of it.

## What is in here

| Kind | Count | Source |
|---|---|---|
| Nominatim geocoding responses | 88 `.json` | OpenStreetMap / Nominatim — ODbL, © OpenStreetMap contributors |
| Overpass queries and responses | 7 `.ql`, several `.json` | OpenStreetMap / Overpass API — ODbL |
| IMD pages and rainfall tables | HTML, PNG | India Meteorological Department |
| IITM Mumbai rainfall, Mumbai Flood platform | HTML | IITM / IIT Bombay |
| ESA WorldCover, Copernicus DEM docs and tile lists | HTML, TXT | ESA, Copernicus |
| MCGM / BMC rainfall pages | HTML | Municipal Corporation of Greater Mumbai |
| Radar imagery | GIF, PNG | IMD |
| OSMnx source files | 2 `.py` | OSMnx 2.1.1 — MIT © Geoff Boeing |

Copyright in each item remains with its publisher. The two OSMnx files each carry a header naming
their origin; see [`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md) at the repository
root for the full list and terms.

## Where the provenance is recorded

`docs/research/data_sources.md` — the URL and access date for every file here, with **NOT FOUND**
written plainly wherever no public source existed.

## If you are packaging a submission

Nothing in this directory is needed to run VARUNA. `make pack` does not include it, and removing
the directory would not change a line of behaviour — it would only cost the ability to check the
research against its evidence.
