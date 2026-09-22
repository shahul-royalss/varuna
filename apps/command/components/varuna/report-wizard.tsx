"use client";

import { useCallback, useRef, useState } from "react";
import { Camera, Check, CloudOff, MapPin, Waves } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DepthChips, DEPTH_HINT_OPTIONS, type DepthHint } from "@/components/varuna/depth-chips";
import { MapSlot } from "@/components/varuna/map-slot";
import { Panel } from "@/components/varuna/panel";
import { errorMessage, useSubmitReport } from "@/lib/api";
import type { ReportResponse } from "@/lib/api/schemas";
import { usePublicLocale, usePublicT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Hindmata junction, Dadar East: the chronic spot the demo report is filed from. */
export const DEFAULT_LAT = 19.012;
export const DEFAULT_LON = 72.841;

const STEPS = [
  { id: 1, key: "stepLocation" },
  { id: 2, key: "stepPhoto" },
  { id: 3, key: "stepDepth" },
] as const;

/**
 * What a confirmation can honestly say, from the answer `POST /v1/reports` gave.
 *
 * - `offline`: a service worker answered 202 `{"queued": true}` because the phone is offline. The
 *   report is on the phone, not at VARUNA, so nothing may claim it changed a forecast.
 * - `queued`: the API accepted it for the next cycle; no count exists yet (`feedback_streets` is
 *   null until the EnKF has assimilated it, CLAUDE.md 11.6).
 * - `improved` / `assimilated`: a count arrived, positive or zero.
 */
export type ReportOutcome = "offline" | "queued" | "improved" | "assimilated";

export function reportOutcome(data: ReportResponse): ReportOutcome {
  if (data.queued === true) return "offline";
  const streets = data.feedback_streets;
  if (typeof streets !== "number") return "queued";
  return streets > 0 ? "improved" : "assimilated";
}

export interface ReportWizardProps {
  className?: string;
}

/**
 * Three steps to a citizen observation (CLAUDE.md section 7.11): where, an optional photo, and
 * how deep. `POST /v1/reports` accepts the report and queues it for the next cycle, so the API's
 * own message is shown verbatim in English rather than replaced by a claim about what the report
 * changed. In Hindi and Marathi the API's English sentence would be the only English on the
 * screen, so the same state is said in the reader's language instead.
 */
export function ReportWizard({ className }: ReportWizardProps) {
  const t = usePublicT("report");
  const depth = usePublicT("depth");
  const english = (usePublicLocale()?.locale ?? "en") === "en";
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [lat, setLat] = useState(String(DEFAULT_LAT));
  const [lon, setLon] = useState(String(DEFAULT_LON));
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<
    { kind: "none" } | { kind: "failed"; reason: string } | null
  >(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [depthHint, setDepthHint] = useState<DepthHint | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = useSubmitReport();

  const useMyLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocateError({ kind: "none" });
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
        setLocateError({ kind: "failed", reason: error.message });
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
    // CLAUDE.md 11.6 defines the feedback count as the segments whose p50 moved by more than 3 cm
    // once the EnKF has assimilated the report - which happens on the *next* cycle, not inside the
    // request a citizen just pressed Send on. Until that number exists the API sends
    // `feedback_streets: null` with a queued message; printing `?? 0` there headlined an improved
    // forecast for a count of zero streets - a claim of effect over a number nobody computed
    // (rule 6). So the count is shown only when a count arrives.
    const outcome = reportOutcome(submit.data);
    const streets = submit.data.feedback_streets ?? 0;
    // The API's own wording in English, so the screen never invents a state the service did not
    // report; the fallback covers a service that accepted the report without one.
    const queuedMessage =
      english && submit.data.message ? submit.data.message : t("queuedFallback");
    const heading = {
      offline: t("savedOffline"),
      queued: t("sent"),
      improved: t("improved", { count: streets }),
      assimilated: t("assimilated"),
    }[outcome];
    const body = {
      offline: t("savedOfflineBody"),
      queued: queuedMessage,
      improved: t("improvedBody"),
      assimilated: t("assimilatedBody"),
    }[outcome];
    const Icon = outcome === "offline" ? CloudOff : Check;
    return (
      <Panel className={cn("p-6", className)}>
        <div className="flex flex-col items-start gap-3" data-outcome={outcome}>
          <Icon size={20} strokeWidth={1.75} aria-hidden="true" className="text-tide" />
          <h2 className="font-display text-h2 tracking-display text-text num font-semibold">
            {heading}
          </h2>
          <p className="type-body text-text-2 max-w-[60ch]">{body}</p>
          {outcome === "queued" ? (
            <p className="type-small text-text-3 max-w-[60ch]">{t("queuedFollowUp")}</p>
          ) : null}
          <Button
            size="lg"
            className="h-11"
            onClick={() => {
              submit.reset();
              setStep(1);
              setDepthHint(null);
              setPhoto(null);
            }}
          >
            {t("another")}
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <ol className="flex items-center gap-2" aria-label={t("progress")}>
        {STEPS.map((s) => {
          const state = s.id === step ? "current" : s.id < step ? "done" : "todo";
          return (
            <li key={s.id} className="flex flex-1 flex-col gap-1.5">
              <span
                aria-hidden="true"
                className={cn("rounded-chip h-1", state === "todo" ? "bg-line" : "bg-tide")}
              />
              <span
                className={cn("type-micro", state === "current" ? "text-text" : "text-text-3")}
                aria-current={state === "current" ? "step" : undefined}
              >
                <span className="num">{s.id}.</span> {t(s.key)}
              </span>
            </li>
          );
        })}
      </ol>

      {step === 1 ? (
        <Panel title={t("whereTitle")} description={t("whereDescription")}>
          <div className="flex flex-col gap-4 p-4">
            <div className="rounded-panel border-line h-56 overflow-hidden border">
              <MapSlot audience="public" emptyState={null} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* 44 px: every control a citizen touches (CLAUDE.md 7.11). */}
              <Button
                variant="outline"
                size="lg"
                className="h-11"
                onClick={useMyLocation}
                disabled={locating}
              >
                <MapPin aria-hidden="true" />
                {locating ? t("findingLocation") : t("useMyLocation")}
              </Button>
              <span className="type-micro text-text-3">{t("orType")}</span>
            </div>
            {locateError ? (
              <p role="alert" className="type-small text-text-2">
                {locateError.kind === "none"
                  ? t("noGeolocation")
                  : t("locationUnavailable", { reason: locateError.reason })}
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="report-lat">{t("latitude")}</Label>
                <Input
                  id="report-lat"
                  inputMode="decimal"
                  className="num h-11"
                  value={lat}
                  onChange={(event) => setLat(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="report-lon">{t("longitude")}</Label>
                <Input
                  id="report-lon"
                  inputMode="decimal"
                  className="num h-11"
                  value={lon}
                  onChange={(event) => setLon(event.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="lg" className="h-11" onClick={() => setStep(2)}>
                {t("continueToPhoto")}
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {step === 2 ? (
        <Panel title={t("photoTitle")} description={t("photoDescription")}>
          <div className="flex flex-col gap-4 p-4">
            <input
              ref={fileRef}
              id="report-photo"
              type="file"
              accept="image/*"
              capture="environment"
              aria-label={t("photoTitle")}
              onChange={onPhotoChange}
              className="type-small text-text-2 file:rounded-control file:border-line file:bg-well file:type-small file:text-text block w-full file:mr-3 file:h-11 file:border file:px-3"
            />
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local data URL, never optimised
              <img
                src={photo}
                alt={t("photoPicked")}
                className="rounded-panel border-line max-h-56 w-full border object-cover"
              />
            ) : (
              <p className="type-small text-text-3 flex items-center gap-2">
                <Camera size={16} strokeWidth={1.75} aria-hidden="true" />
                {t("noPhoto")}
              </p>
            )}
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="ghost" size="lg" className="h-11" onClick={() => setStep(1)}>
                {t("backToLocation")}
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="lg"
                  className="h-11"
                  onClick={() => {
                    setPhoto(null);
                    if (fileRef.current) fileRef.current.value = "";
                    setStep(3);
                  }}
                >
                  {t("skipPhoto")}
                </Button>
                <Button size="lg" className="h-11" onClick={() => setStep(3)}>
                  {t("continueToDepth")}
                </Button>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}

      {step === 3 ? (
        <Panel title={t("depthTitle")} description={t("depthDescription")}>
          <div className="flex flex-col gap-4 p-4">
            <DepthChips value={depthHint} onValueChange={setDepthHint} />
            <p className="type-micro text-text-3 flex items-center gap-2">
              <Waves size={16} strokeWidth={1.75} aria-hidden="true" />
              {depthHint
                ? t("filedAs", {
                    hint: depth("about", {
                      cm: DEPTH_HINT_OPTIONS.find((o) => o.hint === depthHint)?.cm ?? 0,
                    }),
                  })
                : t("pickDepth")}
            </p>
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="ghost" size="lg" className="h-11" onClick={() => setStep(2)}>
                {t("backToPhoto")}
              </Button>
              <Button
                size="lg"
                className="h-11"
                onClick={send}
                disabled={!depthHint || submit.isPending}
              >
                {submit.isPending ? t("sending") : t("send")}
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {submit.isError ? (
        <Panel title={t("notAccepted")}>
          <p role="alert" className="type-small text-text-2 p-4">
            {errorMessage(submit.error)}
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
