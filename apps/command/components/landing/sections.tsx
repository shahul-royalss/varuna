/**
 * The landing page's static sections (CLAUDE.md 7.1, items 2, 3, 5, 7, 8, 9, 10).
 *
 * Server components: none of them needs state, and the landing page's LCP budget (2.5 s) is
 * easier to keep when most of it ships as HTML. The two that do need the client - the hero's
 * scrub loop and the proof counters - live in their own files.
 *
 * Every claim here is one the rest of the repo can back: the engine names match `services/`, the
 * data sources match what `services/city` actually downloads, and the landscape table's rows come
 * from the blueprint's references rather than from memory.
 */

import Link from "next/link";
import type { Route } from "next";

const SECTION = "px-6 py-[72px] sm:px-12 lg:px-24 lg:py-[120px]";
const H2 = "max-w-[24ch] font-display text-h1 font-semibold tracking-display text-text";
const LEAD = "mt-4 max-w-[68ch] text-h3 text-text-2";
const BODY = "max-w-[72ch] text-body text-text-2";

/* ---- 2. The gap ------------------------------------------------------------------------- */

/** An NWP cell over Mumbai beside a 30 m street with a dip under a rail bridge. */
function GapDiagram() {
  return (
    <svg
      viewBox="0 0 520 220"
      className="w-full max-w-[520px]"
      role="img"
      aria-label="A twelve-kilometre forecast cell beside a thirty-metre street section with a forty-centimetre dip under a rail bridge"
    >
      <rect x="8" y="20" width="200" height="180" fill="var(--deep)" stroke="var(--line)" />
      {[1, 2, 3].map((i) => (
        <line
          key={`v${i}`}
          x1={8 + i * 50}
          y1="20"
          x2={8 + i * 50}
          y2="200"
          stroke="var(--line)"
        />
      ))}
      {[1, 2, 3].map((i) => (
        <line
          key={`h${i}`}
          x1="8"
          y1={20 + i * 45}
          x2="208"
          y2={20 + i * 45}
          stroke="var(--line)"
        />
      ))}
      <rect x="58" y="65" width="50" height="45" fill="var(--tide-soft)" />
      <text x="8" y="14" className="fill-[var(--text-3)] text-[11px]">
        12 km forecast cell
      </text>
      <text x="58" y="216" className="fill-[var(--text-3)] text-[11px]">
        one number for all of Dadar
      </text>

      {/* The street */}
      <text x="300" y="14" className="fill-[var(--text-3)] text-[11px]">
        30 m street section
      </text>
      <path
        d="M300 120 L340 120 Q380 120 400 158 Q420 196 460 196 L512 196"
        fill="none"
        stroke="var(--line-strong)"
        strokeWidth="2"
      />
      <path
        d="M340 120 Q380 120 400 158 Q420 196 460 196 L460 200 L340 200 Z"
        fill="var(--depth-4)"
        opacity="0.55"
      />
      <rect x="392" y="60" width="14" height="96" fill="var(--deep)" stroke="var(--line)" />
      <text x="300" y="216" className="fill-[var(--text-3)] text-[11px]">
        45 cm under the rail bridge
      </text>
    </svg>
  );
}

export function TheGap() {
  return (
    <section className={SECTION}>
      <div className="mx-auto grid max-w-[1200px] items-start gap-10 lg:grid-cols-2">
        <div>
          <h2 className={H2}>Forecasts stop at 12 km. Streets flood at 30 m.</h2>
          <p className={LEAD}>
            India&apos;s operational rainfall forecasts resolve a city as a handful of grid cells.
            A cell covering all of Dadar gets one number.
          </p>
          <p className={`${BODY} mt-4`}>
            Water does not arrive at that resolution. It arrives on the road under a rail bridge
            that sits half a metre below its neighbours, through a drain nobody has surveyed, at
            an hour the tide happens to be high. A ward-level warning cannot tell an ambulance
            which underpass to avoid, because it does not know underpasses exist.
          </p>
          <p className={`${BODY} mt-4`}>
            VARUNA models the city at 30 m, couples the surface to a drain network inferred from
            roads and terrain, and answers the question a dispatcher actually asks: which street,
            how deep, and when.
          </p>
        </div>
        <GapDiagram />
      </div>
    </section>
  );
}

/* ---- 3. Four ways a street floods ------------------------------------------------------- */

const WAYS = [
  {
    title: "Pluvial",
    body: "Rain falls faster than the drains can take it. The water never reaches a river; it sits in the road.",
    example: "Hindmata junction, Dadar East, in almost every heavy spell.",
  },
  {
    title: "Fluvial",
    body: "A river or nullah overtops and spills into the streets beside it.",
    example: "The Mithi at Kurla and Kalina, 26 July 2005 and since.",
  },
  {
    title: "Tidal lock",
    body: "A high tide holds the outfall shut. The drains have capacity and nowhere to put it, so the water comes back up through the manholes.",
    example: "Mumbai's coastal outfalls at spring high tide, which is why the tide table is on the console.",
  },
  {
    title: "Invisible drainage",
    body: "The pipe is there and blocked. Nothing on any map says so, and the street floods where the model says it should not.",
    example: "What VARUNA-Pulse learns from traffic anomalies and citizen reports.",
  },
];

export function FourWays() {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-[1200px]">
        <h2 className={H2}>Four ways a street floods</h2>
        <p className={LEAD}>
          They need different physics, and a model that only knows one of them will be confidently
          wrong about the other three.
        </p>
        <dl className="mt-10 flex flex-col divide-y divide-line border-t border-line">
          {WAYS.map((way) => (
            <div key={way.title} className="grid gap-3 py-6 lg:grid-cols-[16ch_1fr_1fr] lg:gap-8">
              <dt className="text-h3 text-text">{way.title}</dt>
              <dd className={BODY}>{way.body}</dd>
              <dd className="text-small text-text-3">{way.example}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* ---- 4. The five-minute cycle ------------------------------------------------------------ */

const STAGES = [
  { n: 1, name: "Ingest", job: "Radar frames, gauges, tide, traffic, reports" },
  { n: 2, name: "Sky", job: "Z–R, gauge merge, optical flow, 20-member STEPS ensemble" },
  { n: 3, name: "Twin", job: "2D shallow water on 30 m terrain, coupled to the 1D drain graph" },
  { n: 4, name: "Flash", job: "Reduced-order emulator for sub-second what-if" },
  { n: 5, name: "Pulse", job: "EnKF over pipe blockage, from traffic and citizen reports" },
  { n: 6, name: "Products", job: "Segment depths, hotspots, alerts, pumps, routes" },
];

export function TheCycle() {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-[1200px]">
        <h2 className={H2}>Every five minutes, the whole city again</h2>
        <p className={LEAD}>
          A cycle is a pipeline with a budget. Each stage&apos;s measured time is on the console&apos;s
          own status bar, because a forecast that arrives late is a forecast nobody used.
        </p>
        <ol className="mt-10 grid gap-px overflow-hidden rounded-panel border border-line bg-line md:grid-cols-2 lg:grid-cols-3">
          {STAGES.map((stage) => (
            <li key={stage.name} className="bg-deep p-5">
              <p className="num text-micro text-text-3">Stage {stage.n}</p>
              <p className="mt-1 text-h3 text-text">{stage.name}</p>
              <p className="mt-2 text-small text-text-2">{stage.job}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ---- 5. Six engines ---------------------------------------------------------------------- */

const ENGINES = [
  {
    name: "Pulse",
    job: "The city reveals its own drains",
    why: "Every flood is an experiment somebody already ran. A traffic feed collapsing on one street and not its neighbour is a measurement of a pipe nobody has surveyed, and an ensemble Kalman filter turns a monsoon's worth of them into a blockage map.",
    span: "lg:col-span-2 lg:row-span-2",
  },
  {
    name: "Twin",
    job: "Surface and sewer, solved together",
    why: "Local-inertial shallow water at 30 m, coupled to a head-driven 1D drain model through inlet capture and surcharge. The manhole that fountains is the same manhole the drain solver pressurised.",
    span: "lg:col-span-2",
  },
  {
    name: "Flash",
    job: "Three hours of city in milliseconds",
    why: "A reservoir cascade calibrated to the Twin's own runs, so a what-if answers while the question is still on screen. Its measured error is printed beside every answer.",
    span: "lg:col-span-2",
  },
  { name: "Sky", job: "Radar into a rain ensemble", why: "pySTEPS on calibrated reflectivity: 20 members, three hours, five-minute steps.", span: "" },
  { name: "Route", job: "Prediction into an ambulance route", why: "Time-dependent Dijkstra, costed at the depth the vehicle will meet when it arrives.", span: "" },
  { name: "Command", job: "One screen at three in the morning", why: "Depth on streets, alerts, pumps, reachability - and a label on every simplification.", span: "" },
];

export function SixEngines() {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-[1200px]">
        <h2 className={H2}>Six engines</h2>
        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {ENGINES.map((engine) => (
            <article
              key={engine.name}
              className={`group flex flex-col rounded-panel border border-line bg-deep p-5 ${engine.span}`}
            >
              <p className="font-display text-h2 font-semibold tracking-display text-text">
                {engine.name}
              </p>
              <p className="mt-1 text-h3 text-text-2">{engine.job}</p>
              <p className="mt-4 text-small text-text-3">{engine.why}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---- 7. Where VARUNA sits ---------------------------------------------------------------- */

const LANDSCAPE = [
  { system: "IFLOWS-Mumbai", scale: "Ward, 6–72 h", drains: "No", learns: "No" },
  { system: "C-FLOWS (Chennai)", scale: "Basin, hours to days", drains: "Partial", learns: "No" },
  { system: "IIT-B Mumbai Flood", scale: "Ward to sub-ward", drains: "Partial", learns: "No" },
  { system: "IMD nowcasts", scale: "Rainfall only, 0–3 h", drains: "No", learns: "No" },
  { system: "Google Flood Hub", scale: "Riverine, global", drains: "No", learns: "No" },
  { system: "VARUNA", scale: "Street, 30 m, 0–3 h", drains: "Inferred and learned", learns: "Yes" },
];

export function Landscape() {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-[1200px]">
        <h2 className={H2}>Where VARUNA sits</h2>
        <blockquote className="mt-6 max-w-[64ch] border-l-2 border-tide pl-4 text-h3 text-text-2">
          The strategic layer tells a city that a ward will flood tomorrow. VARUNA is the tactical
          layer: which street, how deep, and when, for the next three hours.
        </blockquote>
        <div className="mt-10 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="border-b border-line text-left">
                {["System", "Resolution and horizon", "Drainage", "Learns from events"].map((h) => (
                  <th key={h} className="px-3 py-3 text-small font-medium text-text-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {LANDSCAPE.map((row) => (
                <tr key={row.system} className="border-b border-line last:border-b-0">
                  <td className="px-3 py-3 text-body text-text">{row.system}</td>
                  <td className="px-3 py-3 text-body text-text-2">{row.scale}</td>
                  <td className="px-3 py-3 text-body text-text-2">{row.drains}</td>
                  <td className="px-3 py-3 text-body text-text-2">{row.learns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ---- 8. Data we use ---------------------------------------------------------------------- */

const SOURCES = [
  { name: "Copernicus GLO-30 DEM", status: "Public", note: "30 m terrain, downloaded per city" },
  { name: "OpenStreetMap", status: "Public", note: "Roads, buildings, waterways, hospitals, stations" },
  { name: "ESA WorldCover", status: "Public", note: "10 m land cover, for imperviousness and runoff" },
  { name: "BMC and news archives", status: "Public", note: "29 sourced ground-truth pins, each with a URL" },
  { name: "IMD Doppler radar volumes", status: "Requested from MoES", note: "The prototype reconstructs the storm instead" },
  { name: "BMC drain GIS", status: "Requested from MoES", note: "The prototype infers the network and learns it" },
  { name: "Radar reflectivity frames", status: "Synthetic in the prototype", note: "Storm designer calibrated to published gauge totals" },
  { name: "Traffic speeds and citizen reports", status: "Synthetic in the prototype", note: "Labelled everywhere they appear on screen" },
  { name: "Mobile pump inventory", status: "Synthetic in the prototype", note: "Twelve pumps at plausible depots, labelled" },
];

export function DataSources() {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-[1200px]">
        <h2 className={H2}>What the data actually is</h2>
        <p className={LEAD}>
          Three categories, and nothing moves between them quietly. Anything synthetic carries the
          word on screen, next to the number it produced.
        </p>
        <ul className="mt-10 flex flex-col divide-y divide-line border-t border-line">
          {SOURCES.map((source) => (
            <li
              key={source.name}
              className="flex flex-col gap-2 py-4 sm:flex-row sm:items-baseline sm:gap-6"
            >
              <span className="min-w-[26ch] text-body text-text">{source.name}</span>
              <span className="w-fit shrink-0 rounded-chip border border-line bg-well px-2 py-0.5 text-micro text-text-2">
                {source.status}
              </span>
              <span className="text-small text-text-3">{source.note}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---- 9. Roadmap -------------------------------------------------------------------------- */

const ROADMAP = [
  {
    tier: "V1",
    title: "This prototype",
    body: "One AOI of Mumbai, reconstructed radar, inferred drains, a learning blockage map, routes and alerts. Every simplification labelled.",
  },
  {
    tier: "V10",
    title: "A pilot city",
    body: "Real IMD volumes, the ward's own drain GIS, LiDAR at the chronic spots, 5 m nests, a GNN surrogate, and a monsoon of assimilated observations behind the blockage map.",
  },
  {
    tier: "V100",
    title: "Every city that wants one",
    body: "City-in-a-box from open data in an afternoon, a public map in three languages, and a routing feed navigation apps and transit operators consume directly.",
  },
];

export function Roadmap() {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-[1200px]">
        <h2 className={H2}>V1, V10, V100</h2>
        <ol className="mt-10 flex flex-col border-l border-line">
          {ROADMAP.map((stage) => (
            <li key={stage.tier} className="relative pb-10 pl-8 last:pb-0">
              <span
                aria-hidden="true"
                className="absolute left-0 top-1.5 h-2 w-2 -translate-x-1/2 rounded-full bg-tide"
              />
              <p className="num text-micro text-tide">{stage.tier}</p>
              <p className="mt-1 text-h3 text-text">{stage.title}</p>
              <p className={`${BODY} mt-2`}>{stage.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ---- 10. Footer -------------------------------------------------------------------------- */

const LINKS = [
  { href: "/console", label: "Command console" },
  { href: "/drains", label: "Drain X-ray" },
  { href: "/route", label: "Route planner" },
  { href: "/alerts", label: "Alert centre" },
  { href: "/pumps", label: "Pump dispatch" },
  { href: "/verify", label: "Verification" },
  { href: "/map", label: "Public map" },
  { href: "/onboard", label: "City onboarding" },
];

export function Footer() {
  return (
    <footer className="border-t border-line px-6 py-12 sm:px-12 lg:px-24">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-8">
        <nav aria-label="Screens" className="flex flex-wrap gap-x-6 gap-y-2">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              // Next's typed routes want a literal; these come from a list, and every one of them
              // is a route in this app.
              href={link.href as Route}
              className="text-small text-text-2 underline"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <p className="max-w-[72ch] text-small text-text-3">
          VARUNA · Smart India Hackathon 2026 · Problem statement SIH26085, Ministry of Earth
          Sciences · Team VIT. Every number on these screens comes from a run the engines computed;
          every simplification against the blueprint is listed in the repository and labelled where
          it is visible.
        </p>
      </div>
    </footer>
  );
}
