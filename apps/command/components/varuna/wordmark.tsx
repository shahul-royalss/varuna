import { cn } from "@/lib/utils";

export interface WordmarkProps {
  /** sm for the top bar, md for panels, lg for the landing hero. */
  size?: "sm" | "md" | "lg";
  /** Show the three-wave mark next to the word. */
  withMark?: boolean;
  className?: string;
}

const sizes = {
  sm: { text: "text-[17px] leading-none", mark: 18 },
  md: { text: "text-h2 leading-none", mark: 24 },
  lg: { text: "text-display leading-none", mark: 40 },
} as const;

/** The three-wave mark: sky, surface and sewer as three water lines. */
export function WordmarkMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0 text-tide", className)}
    >
      <path
        d="M3 7c2.25-2.4 4.5-2.4 6.75 0S14.25 9.4 16.5 7 21 4.6 21 7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M3 12c2.25-2.4 4.5-2.4 6.75 0s4.5 2.4 6.75 0S21 9.6 21 12"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M3 17c2.25-2.4 4.5-2.4 6.75 0s4.5 2.4 6.75 0S21 14.6 21 17"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}

/** "VARUNA" in display type. The brand name is the one word set in capitals. */
export function Wordmark({ size = "sm", withMark = true, className }: WordmarkProps) {
  const s = sizes[size];
  return (
    <span className={cn("inline-flex items-center gap-2 text-text", className)}>
      {withMark ? <WordmarkMark size={s.mark} /> : null}
      <span className={cn("font-display font-semibold tracking-display", s.text)}>VARUNA</span>
    </span>
  );
}
