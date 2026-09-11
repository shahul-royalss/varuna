# Judge Q&A, with the prototype's actual numbers

Every figure here is measured from the artifacts in this repository, not estimated. Answers follow
CLAUDE.md 16; the numbers come from `/verify`, `city/mumbai/REPORT.md`, `docs/verification/` and
the run directories. Where a number is bad, it is here anyway — a measured weakness is worth more
in front of this jury than a round number nobody can reproduce (rule 6).

Last measured: 11 September 2026.

---

## "Is the physics real?"

Yes. A local-inertial 2D shallow-water solver (Bates 2010) on a hydro-conditioned 30 m DEM, coupled
to a head-driven 1D drain model with Manning capacity, surcharge and backflow, exchanging through
inlet capture and surcharge at every sync interval.

**Mass balance on the 08:40 cycle: 6.1 × 10⁻⁴** — inside the 0.1 % budget CLAUDE.md 11.3 sets.
Say the whole sentence: the audit only started counting what the drains discharge at their outfalls
after we found the network's main sink missing from it, which is why the error used to grow with
the water (1.5 × 10⁻² before).

One cycle of the seven, at 06:40, sits at **0.18 %** — over budget. It is on screen in the replay
screen's cycle log rather than hidden, and it is the one we would investigate next.

The blueprint's full dynamic-wave 1D and 5 m GPU nests are the pilot upgrade; the interfaces for
both are in place (a PySWMM adapter, and the nest geometry in `configs/mumbai.yaml`).

## "How fast is it?"

A three-hour city run is **74 s**, against an 8 s budget. We missed it, and we know exactly why.

The 2D surface solver is 15 s of that and is already compiled. The other 59 s was NumPy: the drain
solver steps 49,770 edges 10,800 times, and the coupling exchanges over 50,110 nodes 2,160 times.
Both are now Numba kernels (drain 106 s → 29 s, coupling 25 s → 4.6 s, physics bit-for-bit the
same). The remaining factor of seven needs the drain step parallelised, which its scatter-adds
currently forbid; the way in is edge colouring. ADR-0035.

What this costs the demo: nothing. The replay is baked and publishes in under 200 ms. It costs a
*live* cycle, which is why "Compute live" is a moment in the demo and not the default.

## "Is the radar real?"

No, and the bundle says so on its face. The replay radar is a storm-designer reconstruction,
calibrated so the AOI's three-hour accumulation matches the documented public gauge totals for
2 July 2019 — **75 mm over 05:40–09:40 IST, inferred from the IMD Santacruz 24-hour total of
375.2 mm**, because no hyetograph for that window is public.

Why not the real thing: IMD's public Mumbai radar products are latest-image endpoints overwritten
in place, with no archive and no dated path, so no July 2019 frame is publicly retrievable.
Archived volumes go through IMD's data-supply route. The frames we generate are quantised to the
same 5 dBZ classes the public images carry, so `services/sky/decode_imd.py` will read the real ones
the way it reads these.

Everything downstream of the frames is real: the Z–R fit, the gauge merge, pySTEPS optical flow and
the 20-member STEPS ensemble.

## "Where is the drain GIS?"

There isn't one — Mumbai has no public street-level storm-water network, which is the problem we
are solving rather than a gap in our data.

Ours is inferred from roads, terrain and design norms: **49,770 edges, 1,716 km of pipe, 127
outfalls (3 tidal), 100 % of nodes reaching an outfall**. Every element carries
`confidence = "inferred"`, every pipe carries a blockage random variable β, and the drain X-ray
draws them dashed for that reason.

The point is what happens next: Pulse learns β from every flood the city has. Across the seven
baked cycles the worst pipe climbs from 0.394 to 0.683 as observations accumulate. When a surveyed
SWMM model arrives we import it and keep the learning.

## "Sub-second forecast — how?"

A reduced-order emulator (a two-reservoir Nash cascade per surface unit) calibrated to our own Twin
runs. A what-if is **62 ms** and an attribution over fifteen candidates **126 ms**.

Its skill is poor and we publish it: **RMSE 5.7 cm, CSI 0.085 at 30 cm** on held-out storms, fitted
on 8 runs where CLAUDE.md 11.7 asks for 200. More runs would not have rescued it — the limit is
structural. A local-rain cascade cannot reproduce depth that arrives as tide and upstream routing,
and segment S215609077-002 takes 10 mm of rain and ponds 60 cm for exactly that reason (ADR-0025).

So what-if **levels on the Twin's own forecast** and uses the emulator only for the *difference* a
scenario makes, a tide offset is refused rather than approximated, and the measured skill is
printed beside every answer. The GNN surrogate is the pilot upgrade.

## "What is your ground truth?"

**29 curated pins for 2 July 2019, 17 inside the scoring window**, each with the URL it was read
from and a stated time uncertainty. Civic logs, news reports with timestamps, and geotagged posts
referenced by news. Nothing synthetic is in that set — the gauges, traffic and citizen reports in
the same bundle all are, and are labelled so.

Not one of the 29 states a depth. They say "waterlogging", "traffic diverted", "water in the
subway". That is why:

## "What are your scores?"

At the 15 cm headline threshold, over the 17 pins in the window:

| | |
|---|---|
| CSI | **0.22** |
| POD | **0.41** |
| FAR | **0.68** (a lower bound — see below) |
| Median lead time | **31 minutes**, over 6 pins found before they were logged |

We sweep 5, 15 and 30 cm rather than picking one, because scoring a civic log against a single
30 cm line treats it as though it had said "over thirty centimetres", which it did not. **The
spread across the three is the finding**: every pin is found at 5 cm, only two of seventeen at
30 cm. The pattern is right and the level is low — a different problem from missing the streets,
and the one we would fix first.

FAR is a lower bound because nobody logged most of the city that morning; we count false alarms
only within 250 m of some pin, or we would be scoring the record-keeping.

Depth MAE, the Brier score and the reliability diagram are returned as **unavailable, with their
reasons**: no pin states a depth, and the baked runs have one member. ADR-0029.

## "Why one member?"

Because the 50-member ensemble products are not built (P7.6). Sky produces 20 members and the fan
chart shows their spread; the Twin runs on the ensemble *mean*, so every street forecast is
deterministic and every exceedance probability is 0 or 1. The probability layer says that on
screen rather than drawing a smooth ramp over a spread that does not exist.

## "How accurate is the DEM?"

Copernicus GLO-30, 30 m, and it is a *surface* model — it carries flyovers and rail embankments
where a bare-earth model would not, and it cannot see a 40 m underpass dip or a kerb-height sag.

So we claim pattern and timing, not absolute level, and the scores above are consistent with that.
Chronic sinks are registered in their own right rather than discovered by the DEM, and
**depressions explain 89.3 % of the chronic register** against a 60 % target. LiDAR and the 5 m
nests are budgeted in the pilot.

## "How is this different from IFLOWS-Mumbai?"

Different layer, and we consume rather than compete. IFLOWS is the strategic layer: ward-level,
6–72 hours, for deciding whether to declare a holiday. VARUNA is the tactical layer: street-level,
0–3 hours, for deciding which junction to send a pump to and which road an ambulance takes.

Four things it does that a ward-level forecast structurally cannot: a drain network with learned
blockage, probabilities per street, sub-second what-if, and routing. We take IMD, NCMRWF and
IFLOWS outputs as inputs.

## "What would you do next?"

In order, and each because of something above:

1. **The 50-member ensemble products** (P7.6) — every probability on screen is currently 0 or 1.
2. **Parallelise the drain step** by edge colouring — 74 s to something that can run live.
3. **The level, not the pattern** — CSI 0.22 at 15 cm and 0.09 at 30 cm says the water arrives in
   the right streets and not deep enough. First suspects: DEM resolution at the sinks, and the
   design intensity the inferred pipes were sized to.
4. **A real IMD feed**, which is a data-supply request rather than an engineering problem.

## "What is synthetic, and what is real?"

Real: the terrain (Copernicus GLO-30), the roads, buildings and land cover (OSM, ESA WorldCover),
the hotspot register, the asset register, the ground-truth pins, and every algorithm.

Synthetic and labelled as such on screen: the radar frames and the rain field, the gauge readings,
the tide series, the traffic speeds, the citizen report stream, and the mobile pump inventory.

Inferred and labelled as such: the entire drain network.

The honesty labels are UI copy, not fine print — "Reconstructed replay", "Inferred drain graph",
"Reduced-order emulator", "Synthetic pump inventory", and `status=Exercise` on every CAP document
a replay raises.
