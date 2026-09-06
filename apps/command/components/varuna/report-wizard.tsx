"use client";

import { useCallback, useRef, useState } from "react";
import { Camera, Check, MapPin, Waves } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DepthChips, DEPTH_HINT_OPTIONS, type DepthHint } from "@/components/varuna/depth-chips";
import { MapSlot } from "@/components/varuna/map-slot";
import { Panel } from "@/components/varuna/panel";
import { errorMessage, useSubmitReport } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Hindmata junction, Dadar East: the chronic spot the demo report is filed from. */
export const DEFAULT_LAT = 19.012;
export const DEFAULT_LON = 72.841;

const STEPS = [
  { id: 1, label: "Location" },
  { id: 2, label: "Photo" },
  { id: 3, label: "Depth" },
] as const;

export interface ReportWizardProps {
  className?: string;
}

/**
 * Three steps to a citizen observation (CLAUDE.md section 7.11): where, an optional photo, and
 * how deep. `POST /v1/reports` answers 501 until Pulse lands in Phase 7, so the API's own message
 * is shown verbatim rather than hidden behind a generic failure.
 */
export function ReportWizard({ className }: ReportWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [lat, setLat] = useState(String(DEFAULT_LAT));
  const [lon, setLon] = useState(String(DEFAULT_LON));
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [depthHint, setDepthHint] = useState<DepthHint | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = useSubmitReport();

  const useMyLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocateError("This browser does not share a location. Type the latitude and longitude instead.");
      return;
    }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLat(position.coords.latitude.toFixed(5));
        setLon(position.coords.longitude.toFixed(5));
        setLocating(false);
      },
      (error) => {
        setLocating(false);
        setLocateError(
          `Location unavailable (${error.message}). Type the latitude and longitude instead.`,
        );
      },
      { enableHighAccuracy: true, timeout: 8_000 },
    );
  }, []);

  const onPhotoChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      setPhoto(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPhoto(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  }, []);

  const send = useCallback(() => {
    if (!depthHint) return;
    submit.mutate({
      ts: new Date().toISOString(),
      lat: Number(lat),
      lon: Number(lon),
      depth_hint: depthHint,
      photo_data_url: photo ?? undefined,
      source: "public-report",
    });
  }, [depthHint, lat, lon, photo, submit]);

  if (submit.isSuccess) {
    const streets = submit.data.feedback_streets ?? 0;
    return (
      <Panel className={cn("p-6", className)}>
        <div className="flex flex-col items-start gap-3">
          <Check size={20} strokeWidth={1.75} aria-hidden="true" className="text-tide" />
          <h2 className="font-display text-h2 font-semibold tracking-display text-text">
            Thanks - your report improved the forecast for <span className="num">{streets}</span>{" "}
            {streets === 1 ? "street" : "streets"}
          </h2>
          <p className="max-w-[60ch] type-body text-text-2">
            Pulse assimilates your report in the next five-minute cycle. It appears on the drain
            X-ray as an observation with the blockage change it caused.
          </p>
          <Button
            onClick={() => {
              submit.reset();
              setStep(1);
              setDepthHint(null);
              setPhoto(null);
            }}
          >
            Report another street
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <ol className="flex items-center gap-2" aria-label="Report progress">
        {STEPS.map((s) => {
          const state = s.id === step ? "current" : s.id < step ? "done" : "todo";
          return (
            <li key={s.id} className="flex flex-1 flex-col gap-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  "h-1 rounded-chip",
                  state === "todo" ? "bg-line" : "bg-tide",
                )}
              />
              <span
                className={cn(
                  "type-micro",
                  state === "current" ? "text-text" : "text-text-3",
                )}
                aria-current={state === "current" ? "step" : undefined}
              >
                {s.id}. {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {step === 1 ? (
        <Panel title="Where is the water?" description="Adjust the point if the map is off.">
          <div className="flex flex-col gap-4 p-4">
            <div className="h-56 overflow-hidden rounded-panel border border-line">
              <MapSlot />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={useMyLocation} disabled={locating}>
                <MapPin aria-hidden="true" />
                {locating ? "Finding your location" : "Use my location"}
              </Button>
              <span className="type-micro text-text-3">
                Or type the coordinates below.
              </span>
            </div>
            {locateError ? (
              <p role="alert" className="type-small text-text-2">
                {locateError}
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="report-lat">Latitude</Label>
                <Input
                  id="report-lat"
                  inputMode="decimal"
                  className="num"
                  value={lat}
                  onChange={(event) => setLat(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="report-lon">Longitude</Label>
                <Input
                  id="report-lon"
                  inputMode="decimal"
                  className="num"
                  value={lon}
                  onChange={(event) => setLon(event.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => setStep(2)}>Continue to photo</Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {step === 2 ? (
        <Panel title="Add a photo" description="Optional - a photo helps us read the depth.">
          <div className="flex flex-col gap-4 p-4">
            <input
              ref={fileRef}
              id="report-photo"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onPhotoChange}
              className="block w-full type-small text-text-2 file:mr-3 file:h-11 file:rounded-control file:border file:border-line file:bg-well file:px-3 file:type-small file:text-text"
            />
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local data URL, never optimised
              <img
                src={photo}
                alt="The photo you picked"
                className="max-h-56 w-full rounded-panel border border-line object-cover"
              />
            ) : (
              <p className="flex items-center gap-2 type-small text-text-3">
                <Camera size={16} strokeWidth={1.75} aria-hidden="true" />
                No photo yet.
              </p>
            )}
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back to location
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setPhoto(null);
                    if (fileRef.current) fileRef.current.value = "";
                    setStep(3);
                  }}
                >
                  Skip photo
                </Button>
                <Button onClick={() => setStep(3)}>Continue to depth</Button>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}

      {step === 3 ? (
        <Panel title="How deep is the water?" description="Pick the closest of the three.">
          <div className="flex flex-col gap-4 p-4">
            <DepthChips value={depthHint} onValueChange={setDepthHint} />
            <p className="flex items-center gap-2 type-micro text-text-3">
              <Waves size={16} strokeWidth={1.75} aria-hidden="true" />
              {depthHint
                ? `Filed as ${DEPTH_HINT_OPTIONS.find((o) => o.hint === depthHint)?.hintText}.`
                : "Pick a depth to send the report."}
            </p>
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(2)}>
                Back to photo
              </Button>
              <Button onClick={send} disabled={!depthHint || submit.isPending}>
                {submit.isPending ? "Sending report" : "Send report"}
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {submit.isError ? (
        <Panel title="The report was not accepted">
          <p role="alert" className="p-4 type-small text-text-2">
            {errorMessage(submit.error)}
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
