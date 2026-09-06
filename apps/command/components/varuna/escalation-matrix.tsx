import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface EscalationTier {
  id: string;
  /** Who is told. */
  recipient: string;
  /** What raises this tier (CLAUDE.md section 11.10 hysteresis and levels). */
  trigger: string;
  /** Channels used for this tier. */
  channel: string;
}

/**
 * The escalation ladder from `config/escalation.yaml`, ward officer to public. This is static
 * configuration: it does not change with the run, only with the config file.
 */
export const ESCALATION_MATRIX: readonly EscalationTier[] = [
  {
    id: "ward-officer",
    recipient: "Ward officer",
    trigger: "Watch raised in the ward: P(> 15 cm) at or above 0.6 for two cycles",
    channel: "Dashboard, WhatsApp",
  },
  {
    id: "control-room",
    recipient: "Control room",
    trigger: "Moderate raised, or a Watch not acknowledged within 10 min",
    channel: "Dashboard, WhatsApp, phone call",
  },
  {
    id: "police-traffic",
    recipient: "Police and traffic",
    trigger: "Severe raised on an arterial, or a segment predicted impassable for cars",
    channel: "WhatsApp, SMS, road-conditions feed",
  },
  {
    id: "transit",
    recipient: "Transit (buses, suburban rail)",
    trigger: "Severe on a bus corridor or a station approach",
    channel: "GTFS-RT service alert, WhatsApp",
  },
  {
    id: "public",
    recipient: "Public",
    trigger: "Severe persisting two cycles, or escalated by the control room",
    channel: "Public map, SMS broadcast, CAP feed",
  },
];

export interface EscalationMatrixProps {
  tiers?: readonly EscalationTier[];
  className?: string;
}

/** Escalation matrix table (CLAUDE.md section 7.5): recipient, trigger and channel per tier. */
export function EscalationMatrix({ tiers = ESCALATION_MATRIX, className }: EscalationMatrixProps) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[28%]">Recipient</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead className="w-[30%]">Channel</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tiers.map((tier, i) => (
            <TableRow key={tier.id} className="h-10">
              <TableCell className="whitespace-normal type-small font-medium text-text">
                <span className="num mr-2 text-text-3">{i + 1}</span>
                {tier.recipient}
              </TableCell>
              <TableCell className="whitespace-normal type-small text-text-2">{tier.trigger}</TableCell>
              <TableCell className="whitespace-normal type-small text-text-2">{tier.channel}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
