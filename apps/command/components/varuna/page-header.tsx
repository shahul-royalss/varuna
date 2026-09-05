import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Buttons rendered at the right of the title row. */
  actions?: React.ReactNode;
  /** Honesty label shown as a chip, e.g. "Inferred drain graph" (CLAUDE.md section 6.8). */
  honesty?: string;
  className?: string;
}

/** Title block for full-page screens: display type, one sentence of context, optional honesty chip. */
export function PageHeader({ title, description, actions, honesty, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-h1 font-semibold tracking-display text-text">{title}</h1>
          {honesty ? (
            <span className="inline-flex items-center rounded-chip border border-line px-2.5 py-0.5 text-micro text-text-2">
              {honesty}
            </span>
          ) : null}
        </div>
        {description ? <p className="max-w-[72ch] text-body text-text-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
