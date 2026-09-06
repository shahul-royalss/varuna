"use client";

import Link from "next/link";
import type { Route } from "next";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/varuna/page-header";
import { ReportWizard } from "@/components/varuna/report-wizard";
import { Wordmark } from "@/components/varuna/wordmark";

const MAP_ROUTE = "/map" as Route;

/** Mobile-first citizen report flow (CLAUDE.md section 7.11). */
export function ReportScreen() {
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-4 py-5">
      <div className="flex items-center justify-between gap-3">
        <Wordmark size="sm" withMark />
        <Button variant="ghost" size="sm" render={<Link href={MAP_ROUTE} />} nativeButton={false}>
          <ArrowLeft aria-hidden="true" />
          Back to the map
        </Button>
      </div>

      <PageHeader
        title="Report water"
        description="Three steps: where you are, a photo if you have one, and how deep the water is. Your report improves the next forecast for the streets around you."
        honesty="Reports reach Pulse in the next cycle"
      />

      <ReportWizard />
    </main>
  );
}
