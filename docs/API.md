# VARUNA API

FastAPI service in `services/api` (`uv run uvicorn varuna_api.main:app --port 8000`). OpenAPI 3.1
at `http://localhost:8000/docs`; `pnpm typegen` (`make typegen`) regenerates
`apps/command/lib/api/types.ts` from it, so the console and the service share one contract.

Every response carries `run_id` and `valid_ts`. Tiers follow CLAUDE.md section 3.1: P0 endpoints
exist in the prototype; P1 endpoints have their schema and a "coming in pilot" body.

## Endpoints (CLAUDE.md section 12)

| Method and path | Purpose | Tier |
| --- | --- | --- |
| `GET /healthz` | Liveness, mode (`replay`/`live`/`degraded`), bundle, last run | P0 |
| `GET /v1/runs` · `GET /v1/runs/{run_id}` | Run registry and provenance (versions, `stage_ms`, mass balance) | P0 |
| `GET /v1/nowcast/segments?run_id=&bbox=&t=&profile=` | Segment quantiles, exceedance probabilities, safe-until (GeoJSON; `format=parquet` for the console preload) | P0 |
| `GET /v1/nowcast/raster?run_id=&t=&stat=p50,p90,prob30` | Depth raster PNG + bounds (COG is P1) | P0 |
| `GET /v1/nowcast/hotspots?run_id=&limit=` | Ranked hotspots with attribution | P0 |
| `GET /v1/nowcast/segments/{id}/series?run_id=` | One segment's fan-chart series and safe-until table | P0 |
| `GET /v1/drains/health?run_id=&bbox=` · `GET /v1/drains/health.csv` | Drain-health product; desilting priority CSV | P0 |
| `GET /v1/observations?run_id=` | Assimilated observations with their effect on beta | P0 |
| `POST /v1/reports` | Citizen or field observation ingestion; feedback count arrives after the next cycle over the WebSocket | P0 |
| `POST /v1/route` | `{origin, destination, depart_at, profile, risk_tolerance}` → route, `avoided`, `alternates`, `safe_until`, explanation | P0 |
| `GET /v1/reachability?facility=&profile=&t=` | Isochrone polygons (5/10/15 min) + collapse flag | P0 |
| `GET /v1/feeds/road-conditions` | Provider feed GeoJSON (impassable and degraded segments with validity windows) | P0 |
| `GET /v1/feeds/gtfs-rt/alerts` | GTFS-Realtime service alerts | P1 |
| `GET /v1/alerts?since=` · `GET /v1/alerts/{id}.cap` · `POST /v1/alerts/{id}/ack` · `POST /v1/alerts/{id}/escalate` | Alert feed, CAP 1.2 documents, state changes | P0 |
| `GET /v1/pumps` · `POST /v1/pumps/optimise` · `POST /v1/pumps/dispatch` | Inventory (synthetic, labelled), plan with expected benefit, dispatch order | P0 |
| `POST /v1/whatif` | `{rain_scale, tide_offset_m, cleaned_edges[], pump_plan}` → deltas (< 1 s) | P0 |
| `POST /v1/whatif/physics-check` | Twin re-run on the scenario → agreement report | P0 |
| `GET /v1/replay/bundles` · `POST /v1/replay/{play,pause,seek,speed}` · `GET /v1/replay/clock` | Replay control (the same clock the console uses) | P0 |
| `POST /v1/cycle/compute` · `GET /v1/cycle/status` | Live cycle and per-stage timings | P0 |
| `POST /v1/onboard` · `GET /v1/onboard/{job}` | City-in-a-box job with progress | P0 |
| `GET /v1/verification?event=` | Scores and chart data computed by `services/verify` | P0 |
| `GET /v1/city/{city}/layers/{name}` | Static layers (segments, drains, assets, hotspots, buildings) simplified for the map | P0 |
| `WS /v1/live` | Events: `runs.published`, `cycle.stage`, `alert.*`, `obs.assimilated`, `replay.clock`, `onboard.progress` | P0 |

## Error envelope

Every error response, whatever the status code, has this shape:

```json
{
  "error": {
    "code": "run_not_found",
    "message": "Run MUM-20190702T1210-sky1.0-twin1.0-flash0.3-baked is not in data/runs. Bake the bundle or pick a run from GET /v1/runs.",
    "run_id": "MUM-20190702T1210-sky1.0-twin1.0-flash0.3-baked"
  }
}
```

- `code` is a stable snake_case identifier the console can switch on.
- `message` says what happened and what to do; it is shown to operators verbatim, so it follows
  the copy rules in CLAUDE.md section 6.8 (never "Something went wrong").
- `run_id` is the run the request referred to, or `null` when none applies.

Status codes: 400 for malformed input, 404 for unknown run, segment, alert or bundle, 409 when a
replay control conflicts with the current clock state, 422 for schema violations (FastAPI's
validation errors are wrapped into the same envelope), 503 when the mode is degraded and the
requested product is unavailable.

## Time formats

- All timestamps are ISO 8601 with an explicit offset: `2019-07-02T17:40:00+05:30`. The API never
  emits naive datetimes or `Z` for Indian data.
- Query parameters `t`, `depart_at` and `since` accept the same format; `t` may also be a lead
  offset in minutes relative to the run's `cycle_ts` (`t=+40`).
- `valid_ts` is the forecast valid time of the returned product; `cycle_ts` is when the cycle was
  issued; `radar_frame_ts` is the newest radar frame the run consumed.
- Run identifiers embed the cycle time in compact UTC:
  `<CITY>-<cycle_ts UTC compact>-sky<v>-twin<v>-flash<v>[-live|-baked]`.
- The UI renders IST 24-hour times with the lead in brackets: "18:20 (+40 min)".

## Conventions

- Depth is centimetres, probability is a fraction in JSON (`0.82`) and a percentage on screen.
- Vehicle profiles: `two_wheeler`, `car`, `bus`, `ambulance`, `fire_tender`, `pedestrian`.
- CAP alerts on replay use `status=Exercise`; live runs use `Actual`.
- GeoJSON is WGS84 (EPSG:4326); computation happens in the city CRS (EPSG:32643 for Mumbai,
  EPSG:32644 for Chennai).
