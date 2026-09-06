/**
 * The public map is its own shell: no icon rail, no top bar, no right rail. It is read on a
 * phone at 390 x 844 by a commuter, so the map owns the whole viewport (CLAUDE.md section 7.11).
 */
export default function MapLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex h-dvh min-h-0 flex-col bg-ink">{children}</div>;
}
