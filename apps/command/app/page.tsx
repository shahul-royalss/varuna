import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/varuna/wordmark";

export const metadata: Metadata = {
  title: "VARUNA - every street, three hours early",
};

/**
 * Landing shell (Phase 0). Phase 9 replaces this with the full page from CLAUDE.md section 7.1:
 * the live hero map, the gap diagram, the six engines, the proof numbers and the roadmap.
 */
export default function LandingPage() {
  return (
    <main className="flex min-h-dvh flex-1 flex-col bg-ink text-text">
      <section className="flex flex-1 items-center px-6 py-16 sm:px-12 lg:px-24">
        <div className="flex max-w-[72ch] flex-col items-start gap-8">
          <Wordmark size="lg" />
          <h1 className="max-w-[14ch] font-display text-display font-semibold tracking-display sm:text-hero">
            Every street. Three hours early.
          </h1>
          <p className="max-w-[60ch] text-h3 text-text-2">
            VARUNA turns Doppler radar into street-by-street flood depth for the next three hours,
            learns the city&apos;s hidden drains from every flood, and routes emergency services
            around what is coming.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" render={<Link href="/console" />} nativeButton={false}>
              Open the console
            </Button>
            <Button
              size="lg"
              variant="outline"
              render={<Link href="/console?bundle=MUM-2019-07-02&autoplay=1" />}
              nativeButton={false}
            >
              Watch the 2 July 2019 replay
            </Button>
          </div>
          <p className="text-small text-text-3">SIH 2026 - PS SIH26085 - Ministry of Earth Sciences</p>
        </div>
      </section>
    </main>
  );
}
