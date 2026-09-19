import type { RouteCorridor, RoutePlan, RouteReason } from "@/lib/api/route";
import { cn } from "@/lib/utils";

export interface RouteAnswerProps {
  plan: RoutePlan;
  /** Structured reasons from the run; an older API sends none and the card stays quiet. */
  reasons?: RouteReason[] | null;
  corridors?: RouteCorridor[] | null;
  selectedCorridorId?: string | null;
  onPickCorridor?: (id: string) => void;
  profile: string;
  className?: string;
}

function minutes(value: number | null | undefined): string | null {
  return value == null || !Number.isFinite(value) ? null : `${Math.round(value)} min`;
}

/**
 * The route answer in words: the two ways compared, then why this one (UI_SPEC 4).
 *
 * This is the seam the citizen screens import. It renders the comparison from the plan alone, so
 * it is honest against today's API; the reasons, the corridor picker and the pumps are added by
 * task D-12 without changing this file's props.
 */
export function RouteAnswer({ plan, profile, className }: RouteAnswerProps) {
  const safe = minutes(plan.varuna?.minutes);
  const quick = minutes(plan.naive?.minutes);
  const cost =
    plan.varuna && plan.naive ? Math.round(plan.varuna.minutes - plan.naive.minutes) : null;

  return (
    <section className={cn("rounded-panel border border-line bg-deep p-4", className)}>
      <h2 className="text-h3 font-display text-text">Your way there</h2>
      {safe === null ? (
        <p className="mt-2 text-small text-text-2">
          This cycle has no safe way through for a {profile}. Try a later departure or another
          vehicle.
        </p>
      ) : (
        <p className="num mt-2 text-body text-text">
          Shortest way: {quick ?? "not found"} · Safe way: {safe}
          {cost != null && cost > 0 ? ` (+${cost} min)` : ""}
        </p>
      )}
    </section>
  );
}
