import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/varuna/wordmark";

/** A faint street grid drawn from the --line token; no images, no literal colours. */
const gridStyle: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(0deg, var(--line) 0, var(--line) 1px, transparent 1px, transparent 48px), " +
    "repeating-linear-gradient(90deg, var(--line) 0, var(--line) 1px, transparent 1px, transparent 48px)",
  maskImage: "radial-gradient(ellipse at 50% 40%, black 0%, transparent 70%)",
  WebkitMaskImage: "radial-gradient(ellipse at 50% 40%, black 0%, transparent 70%)",
};

export default function NotFound() {
  return (
    <main className="relative flex min-h-dvh flex-1 items-center bg-ink px-6 py-16 text-text sm:px-12">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60" style={gridStyle} />
      <div className="relative z-10 flex max-w-[60ch] flex-col items-start gap-6">
        <Wordmark size="sm" />
        <div className="space-y-3">
          <h1 className="font-display text-display font-semibold tracking-display">
            This street does not exist.
          </h1>
          <p className="max-w-[44ch] text-body text-text-2">The address you typed is not on the map.</p>
        </div>
        <Button render={<Link href="/console" />} nativeButton={false}>
          Open the console
        </Button>
      </div>
    </main>
  );
}
