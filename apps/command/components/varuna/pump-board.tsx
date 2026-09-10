"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { PackageOpen } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/varuna/empty-state";
import { PumpCard, type Pump } from "@/components/varuna/pump-card";
import { formatMinutes } from "@/lib/format";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { cn } from "@/lib/utils";

/**
 * A hotspot column of the board. `pumps` is the assignment for that hotspot, so the shape is
 * already what the Phase 8 dnd-kit droppable will read; nothing here is draggable yet.
 */
export interface PumpColumn {
  /** Stable id, also the droppable id in Phase 8, e.g. "hindmata". */
  id: string;
  /** Hotspot name as the operator reads it, e.g. "Hindmata junction". */
  title: string;
  /** Pumps assigned to this hotspot. */
  pumps: Pump[];
  /** Minutes above 45 cm without and with the plan; null until a run has been loaded. */
  minutesAbove45?: { before: number; after: number } | null;
}

/** The three chronic hotspots the demo dispatches to (CLAUDE.md section 3.3). */
export const DEFAULT_PUMP_COLUMNS: readonly PumpColumn[] = [
  { id: "hindmata", title: "Hindmata junction", pumps: [], minutesAbove45: null },
  { id: "kings-circle", title: "King's Circle", pumps: [], minutesAbove45: null },
  { id: "sion-circle", title: "Sion Circle", pumps: [], minutesAbove45: null },
];

/** The one sentence every disabled control on this board carries. */
export const PUMP_ACTIONS_HELPER =
  "The plan is the greedy optimiser's; it is recomputed when the cycle runs.";

/** Placeholder line where the excess-inflow sparkline will be drawn. */
export const SPARKLINE_PLACEHOLDER = "Excess inflow appears with the first run";

export interface PumpBoardProps {
  /** The available pumps, not yet assigned to a hotspot. */
  pumps: Pump[];
  columns: readonly PumpColumn[];
  /** Runs the greedy optimiser; absent in Phase 0, so the button stays disabled. */
  onOptimise?: () => void;
  /** Sends the current plan; absent in Phase 0, so the button stays disabled. */
  onDispatch?: () => void;
  /** Moves a pump to a hotspot column, or back to the pool when `columnId` is null.
   *
   * Absent leaves the board read-only: a card that can be picked up but not put down is worse
   * than one that never moves. */
  onAssign?: (pumpId: string, columnId: string | null) => void;
  className?: string;
}

/** The droppable id of the "Available pumps" column: dropping here un-assigns a pump. */
const POOL_ID = "__pool__";

/** Motion M17: the card flies to its column and settles. A spring, per CLAUDE.md 8's handles. */
const CARD_SPRING = { type: "spring" as const, stiffness: 400, damping: 32 };

/** One draggable pump card. `layoutId` is what makes the card *fly* between columns rather than
 * disappearing from one and appearing in another - the whole of motion M17. */
function DraggablePump({
  pump,
  disabled,
  reducedMotion,
}: {
  pump: Pump;
  disabled: boolean;
  reducedMotion: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: pump.id,
    disabled,
  });

  return (
    <motion.div
      ref={setNodeRef}
      layoutId={reducedMotion ? undefined : `pump-${pump.id}`}
      transition={reducedMotion ? { duration: 0 } : CARD_SPRING}
      // The original stays in place at low opacity while the overlay follows the cursor, so the
      // column it came from does not reflow underneath the drag.
      style={{ opacity: isDragging ? 0.35 : 1 }}
      className={disabled ? undefined : "cursor-grab active:cursor-grabbing"}
      {...listeners}
      {...attributes}
    >
      <PumpCard pump={pump} />
    </motion.div>
  );
}

/** A column that accepts a dropped pump, lit while one is over it. */
function DropColumn({
  id,
  children,
  className,
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-column-id={id}
      className={cn(
        className,
        // `--line-strong` on hover-over: the only feedback that says "this is where it lands".
        isOver && "border-line-strong bg-well",
      )}
    >
      {children}
    </div>
  );
}

function benefitLine(column: PumpColumn): string {
  const benefit = column.minutesAbove45;
  if (!benefit) return "Minutes above 45 cm: no data";
  return `Minutes above 45 cm: ${formatMinutes(benefit.before)} to ${formatMinutes(benefit.after)}`;
}

/**
 * The dispatch board (CLAUDE.md section 7.6): an "Available pumps" column beside one column per
 * chronic hotspot, each showing the predicted excess inflow and the minutes above 45 cm the plan
 * would save. The greedy optimiser and the benefit estimate are live (P8.9); drag-to-assign
 * needs a benefit the board can recompute per drop, which is the emulator's job in Phase 7;
 * the column props are already shaped for the dnd-kit droppables.
 */
export function PumpBoard({
  pumps,
  columns,
  onOptimise,
  onDispatch,
  onAssign,
  className,
}: PumpBoardProps) {
  const helperId = "pump-board-actions-helper";
  const reducedMotion = usePrefersReducedMotion();
  const [dragging, setDragging] = useState<Pump | null>(null);

  // A short activation distance, so a click on a card is still a click and only a deliberate
  // pull starts a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const byId = new Map<string, Pump>();
  for (const pump of pumps) byId.set(pump.id, pump);
  for (const column of columns) for (const pump of column.pumps) byId.set(pump.id, pump);

  const onDragStart = (event: DragStartEvent) =>
    setDragging(byId.get(String(event.active.id)) ?? null);

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const over = event.over?.id;
    if (over === undefined || !onAssign) return;
    const target = String(over);
    onAssign(String(event.active.id), target === POOL_ID ? null : target);
  };

  const board = (
    <section
      data-slot="pump-board"
      aria-label="Pump board"
      className={cn("flex flex-col gap-3", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="type-h3 font-medium text-text">Board</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!onOptimise}
            aria-disabled={!onOptimise}
            aria-describedby={onOptimise ? undefined : helperId}
            onClick={onOptimise}
          >
            Optimise
          </Button>
          <Button
            size="sm"
            disabled={!onDispatch}
            aria-disabled={!onDispatch}
            aria-describedby={onDispatch ? undefined : helperId}
            onClick={onDispatch}
          >
            Dispatch pumps
          </Button>
        </div>
      </div>

      {onOptimise && onDispatch ? null : (
        <p id={helperId} className="type-small text-text-3">
          {PUMP_ACTIONS_HELPER}
        </p>
      )}

      <div className="flex gap-4 overflow-x-auto pb-2">
        <DropColumn
          id={POOL_ID}
          className="flex w-[280px] shrink-0 flex-col rounded-panel border border-line bg-deep transition-colors"
        >
          <header className="border-b border-line px-4 py-3">
            <h3 className="type-small font-medium text-text">Available pumps</h3>
            <p className="type-micro text-text-3">Synthetic pump inventory</p>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            {pumps.length === 0 ? (
              <EmptyState
                size="sm"
                icon={PackageOpen}
                title="No pumps loaded yet"
                description="The inventory arrives with the city layers."
              />
            ) : (
              pumps.map((pump) => (
                <DraggablePump
                  key={pump.id}
                  pump={pump}
                  disabled={!onAssign}
                  reducedMotion={reducedMotion}
                />
              ))
            )}
          </div>
        </DropColumn>

        {columns.map((column) => (
          <DropColumn
            key={column.id}
            id={column.id}
            className="flex w-[280px] shrink-0 flex-col rounded-panel border border-line bg-deep transition-colors"
          >
            <header className="border-b border-line px-4 py-3">
              <h3 className="type-small font-medium text-text">{column.title}</h3>
              <p className="type-micro text-text-3">{SPARKLINE_PLACEHOLDER}</p>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              <div
                aria-hidden="true"
                className="h-10 rounded-control border border-dashed border-line bg-ink"
              />
              <p className="num type-micro text-text-2">{benefitLine(column)}</p>
              {column.pumps.length === 0 ? (
                <EmptyState
                  size="sm"
                  title="No pump assigned"
                  description="Assign a pump once the inventory and a run are loaded."
                />
              ) : (
                column.pumps.map((pump) => (
                  <DraggablePump
                    key={pump.id}
                    pump={pump}
                    disabled={!onAssign}
                    reducedMotion={reducedMotion}
                  />
                ))
              )}
            </div>
          </DropColumn>
        ))}
      </div>
    </section>
  );

  if (!onAssign) return board;

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {board}
      {/* The card under the cursor. A `DragOverlay` renders outside the scroll container, so the
          card does not disappear behind a column edge while it is being carried across. */}
      <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
        {dragging ? (
          <div className="w-[256px] rotate-2 opacity-95">
            <PumpCard pump={dragging} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
