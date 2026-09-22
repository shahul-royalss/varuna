"use client";

import Link from "next/link";
import type { Route } from "next";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LanguageToggle } from "@/components/varuna/language-toggle";
import { PageHeader } from "@/components/varuna/page-header";
import { ReportWizard } from "@/components/varuna/report-wizard";
import { Wordmark } from "@/components/varuna/wordmark";
import { usePublicT } from "@/lib/i18n";

const MAP_ROUTE = "/map" as Route;

/** Mobile-first citizen report flow (CLAUDE.md section 7.11), in English, Hindi or Marathi. */
export function ReportScreen() {
  const t = usePublicT("report");
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-4 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Wordmark size="sm" withMark />
        <LanguageToggle />
      </div>
      <Button
        variant="ghost"
        size="lg"
        className="h-11 self-start"
        render={<Link href={MAP_ROUTE} />}
        nativeButton={false}
      >
        <ArrowLeft aria-hidden="true" />
        {t("backToMap")}
      </Button>

      <PageHeader title={t("title")} description={t("description")} honesty={t("honesty")} />

      <ReportWizard />
    </main>
  );
}
