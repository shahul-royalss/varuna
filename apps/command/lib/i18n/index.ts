/**
 * Minimal i18n for the public map and the report flow. English ships now; Hindi and Marathi are
 * P1 (CLAUDE.md 7.11) and are listed so the language toggle can say so honestly. When their JSON
 * arrives, add it to `dictionaries` and flip `available`.
 */
"use client";

import { useCallback } from "react";
import { create } from "zustand";

import { en, type Dictionary } from "./en";

export type Locale = "en" | "hi" | "mr";

export interface LocaleInfo {
  code: Locale;
  /** Name in English for tooltips. */
  label: string;
  /** Name in the language itself, as the toggle shows it. */
  native: string;
  available: boolean;
  /** One sentence of plan while unavailable (P1 controls say what is coming). */
  plan?: string;
}

export const LOCALES: readonly LocaleInfo[] = [
  { code: "en", label: "English", native: "English", available: true },
  {
    code: "hi",
    label: "Hindi",
    native: "हिन्दी",
    available: false,
    plan: "Hindi lands in the pilot with Noto Sans Devanagari and the translated public map.",
  },
  {
    code: "mr",
    label: "Marathi",
    native: "मराठी",
    available: false,
    plan: "Marathi lands in the pilot with Noto Sans Devanagari and the translated public map.",
  },
];

export const DEFAULT_LOCALE: Locale = "en";

const dictionaries: Partial<Record<Locale, Dictionary>> = { en };

/** Dotted key paths of the dictionary, e.g. "map.reportWater". */
type Paths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Paths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = Paths<Dictionary>;

export type Vars = Record<string, string | number>;

function lookup(dictionary: Dictionary, key: string): string | undefined {
  let node: unknown = dictionary;
  for (const part of key.split(".")) {
    if (node && typeof node === "object" && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Translates `key` for `locale`, falling back to English, then to the key itself. */
export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const primary = dictionaries[locale];
  const text = (primary && lookup(primary, key)) ?? lookup(en, key) ?? key;
  return interpolate(text, vars);
}

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/** Locale lives in memory for now; persistence arrives with the P1 languages. */
export const useLocaleStore = create<LocaleState>()((set) => ({
  locale: DEFAULT_LOCALE,
  setLocale: (locale) =>
    set({ locale: LOCALES.find((l) => l.code === locale && l.available) ? locale : DEFAULT_LOCALE }),
}));

export type Translator = (key: MessageKey, vars?: Vars) => string;

/** `const t = useT(); t("map.reportWater")`. */
export function useT(): Translator {
  const locale = useLocaleStore((s) => s.locale);
  return useCallback<Translator>((key, vars) => translate(locale, key, vars), [locale]);
}

export function useLocale(): [Locale, (locale: Locale) => void] {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  return [locale, setLocale];
}

export { en };
export type { Dictionary };
