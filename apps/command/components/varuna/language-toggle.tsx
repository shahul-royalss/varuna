"use client";

import { cn } from "@/lib/utils";

export type PublicLocale = "en" | "hi" | "mr";

interface LocaleOption {
  code: PublicLocale;
  label: string;
  /** Hindi and Marathi land with the i18n bundles in Phase 9 (CLAUDE.md section 3.2, P1). */
  available: boolean;
}

const LOCALES: readonly LocaleOption[] = [
  { code: "en", label: "EN", available: true },
  { code: "hi", label: "HI", available: false },
  { code: "mr", label: "MR", available: false },
];

const COMING = "Hindi and Marathi are coming in pilot";

export interface LanguageToggleProps {
  value?: PublicLocale;
  onValueChange?: (locale: PublicLocale) => void;
  className?: string;
}

/** EN is live; HI and MR are present but disabled so the control is never dead. */
export function LanguageToggle({ value = "en", onValueChange, className }: LanguageToggleProps) {
  return (
    <div
      role="group"
      aria-label="Language"
      aria-describedby="language-toggle-note"
      className={cn("inline-flex items-center rounded-control border border-line bg-deep", className)}
    >
      {LOCALES.map((locale) => {
        const active = locale.code === value;
        return (
          <button
            key={locale.code}
            type="button"
            disabled={!locale.available}
            aria-pressed={active}
            title={locale.available ? undefined : COMING}
            onClick={() => onValueChange?.(locale.code)}
            className={cn(
              "h-11 min-w-11 px-3 type-small font-medium first:rounded-l-control last:rounded-r-control",
              "focus-visible:ring-2 focus-visible:ring-tide focus-visible:outline-none",
              active ? "bg-well text-text" : "text-text-2",
              locale.available ? "hover:text-text" : "cursor-not-allowed text-text-3",
            )}
          >
            {locale.label}
          </button>
        );
      })}
      <span id="language-toggle-note" className="sr-only">
        {COMING}
      </span>
    </div>
  );
}
