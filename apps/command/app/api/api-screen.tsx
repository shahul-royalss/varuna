"use client";

import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/varuna/app-shell";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { useCopyToClipboard } from "@/lib/hooks";
import { apiUrl, useHealth } from "@/lib/api";

const DEMO_RUN_ID = "MUM-20190702T1740-sky1.0-twin1.0-flash0.3-baked";

interface Preset {
  id: string;
  title: string;
  description: string;
  curl: string;
}

/** The three requests a judge should be able to run without reading the whole contract. */
function presets(base: string): Preset[] {
  return [
    {
      id: "segments",
      title: "Segments in a bounding box",
      description:
        "Street quantiles, exceedance probabilities and safe-until for the Mumbai central area at 18:20 IST.",
      curl: `curl "${base}/v1/nowcast/segments?run_id=${DEMO_RUN_ID}&bbox=72.815,18.995,72.905,19.135&t=2019-07-02T18:20:00%2B05:30&profile=car"`,
    },
    {
      id: "route",
      title: "Ambulance route, KEM Hospital to Sion Hospital",
      description:
        "Departure 17:40 IST on the replay day, ambulance profile, risk tolerance 0.2.",
      curl: `curl -X POST "${base}/v1/route" \\
  -H "content-type: application/json" \\
  -d '{"origin":[72.8412,19.0032],"destination":[72.8621,19.0412],"depart_at":"2019-07-02T17:40:00+05:30","profile":"ambulance","risk_tolerance":0.2}'`,
    },
    {
      id: "whatif",
      title: "What-if at 1.3x rain",
      description: "The reduced-order emulator answers in under a second with per-hotspot deltas.",
      curl: `curl -X POST "${base}/v1/whatif" \\
  -H "content-type: application/json" \\
  -d '{"run_id":"${DEMO_RUN_ID}","rain_scale":1.3,"tide_offset_m":0,"cleaned_edges":[],"pump_plan":null}'`,
    },
  ];
}

/** API explorer (CLAUDE.md section 7.12): the OpenAPI document plus three copyable requests. */
export function ApiScreen() {
  const base = apiUrl();
  const docsUrl = `${base}/docs`;
  const { copy } = useCopyToClipboard();
  /* A cross-origin iframe never reports a load failure, so the health probe decides whether the
   * API is up before the frame is rendered at all. */
  const health = useHealth();
  const apiDown = health.isError;

  return (
    <AppShell>
      <div className="flex flex-col gap-6 p-6">
        <PageHeader
          title="API explorer"
          description="Every response carries a run id and a valid time. The document below is served by the API itself, so what you read is what is running."
          honesty="Endpoints from later phases answer 501 until they land"
          actions={
            <Button variant="outline" onClick={() => void copy(docsUrl)}>
              <Copy aria-hidden="true" />
              Copy the docs URL
            </Button>
          }
        />

        <Panel title="OpenAPI document" description={docsUrl} className="min-h-[520px]">
          {apiDown ? (
            <div className="p-4">
              <p className="type-body text-text-2">
                The VARUNA API is not running. Start it with <span className="font-mono">make dev</span>.
              </p>
            </div>
          ) : (
            <iframe
              src={docsUrl}
              title="VARUNA OpenAPI explorer"
              className="h-[520px] w-full rounded-b-panel border-0 bg-ink"
            />
          )}
        </Panel>

        <section aria-label="Ready-made requests" className="grid gap-4 lg:grid-cols-3">
          {presets(base).map((preset) => (
            <Panel
              key={preset.id}
              title={preset.title}
              description={preset.description}
              actions={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Copy the ${preset.title.toLowerCase()} request`}
                  onClick={() => void copy(preset.curl)}
                >
                  <Copy aria-hidden="true" />
                </Button>
              }
            >
              <pre className="overflow-x-auto p-4 font-mono text-micro leading-relaxed text-text-2">
                <code>{preset.curl}</code>
              </pre>
            </Panel>
          ))}
        </section>
      </div>
    </AppShell>
  );
}
