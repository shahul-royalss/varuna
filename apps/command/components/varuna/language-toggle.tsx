"use client";

import { useId } from "react";

import { PUBLIC_LOCALES, usePublicLocale, usePublicT, type PublicLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type { PublicLocale } from "@/lib/i18n";

const CODE_LABEL: Record<PublicLocale, string> = { en: "EN", hi: "HI", mr: "MR" };

export interface LanguageToggleProps {
  /** Used only where no language provider is mounted; under one, the provider owns the choice. */
  value?: PublicLocale;
  onValueChange?: (locale: PublicLocale) => void;
  className?: string;
}

/**
 * EN / HI / MR for the public map and the report flow (CLAUDE.md 7.11, task P9.9).
 *
 * Under `PublicI18nProvider` every language is live and the choice is remembered in this browser.
 * With no provider there is nothing to switch, so Hindi and Marathi stay present but disabled with
 * the reason - never a dead control (section 17). Each button is named in its own language, so a
 * Marathi reader finds "मराठी" whatever the screen is currently in.
 */
export function LanguageToggle({ value = "en", onValueChange, className }: LanguageToggleProps) {
  const i18n = usePublicLocale();
  const t = usePublicT("language");
  const noteId = useId();
  const current = i18n?.locale ?? value;
  const live = i18n !== null;

  return (
    <div
      role="group"
      aria-label={t("group")}
      aria-describedby={noteId}
      className={cn("inline-flex items-center rounded-control border border-line bg-deep", className)}
    >
      {PUBLIC_LOCALES.map((code) => {
        const active = code === current;
        const available = live || code === "en";
        return (
          <button
            key={code}
            type="button"
            lang={code}
            disabled={!available}
            aria-pressed={active}
            aria-label={`${CODE_LABEL[code]} ${t(code)}`}
            title={available ? undefined : t("coming")}
            onClick={() => {
              if (i18n) void i18n.setLocale(code);
              else onValueChange?.(code);
            }}
            className={cn(
              "h-11 min-w-11 px-3 type-small font-medium first:rounded-l-control last:rounded-r-control",
              "focus-visible:ring-2 focus-visible:ring-tide focus-visible:outline-none",
              active ? "bg-well text-text" : "text-text-2",
              available ? "hover:text-text" : "cursor-not-allowed text-text-3",
            )}
          >
            {CODE_LABEL[code]}
          </button>
        );
      })}
      <span id={noteId} className="sr-only">
        {live ? t("draft") : t("coming")}
      </span>
    </div>
  );
}
