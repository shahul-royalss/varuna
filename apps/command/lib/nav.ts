import type { Route } from "next";
import type { LucideIcon } from "lucide-react";
import {
  BadgeCheck,
  Bell,
  Droplets,
  FlaskConical,
  LayoutDashboard,
  MapPinned,
  Play,
  Route as RouteIcon,
  Waypoints,
} from "lucide-react";

/** One icon-rail entry (CLAUDE.md section 7.2, in order). */
export interface NavItem {
  id: string;
  href: Route;
  label: string;
  icon: LucideIcon;
  /** Keyboard hint shown in the tooltip and the palette, e.g. "Alt+1". */
  hint: string;
}

/*
 * Routes other than /console and /design are built by other agents; they are typed as Route so
 * the rail and the palette compile before every page exists. Typed routes still guard `Link` in
 * the pages themselves once they land.
 */
const route = (path: string) => path as Route;

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "console", href: route("/console"), label: "Console", icon: LayoutDashboard, hint: "Alt+1" },
  { id: "drains", href: route("/drains"), label: "Drains", icon: Waypoints, hint: "Alt+2" },
  { id: "route", href: route("/route"), label: "Route", icon: RouteIcon, hint: "Alt+3" },
  { id: "alerts", href: route("/alerts"), label: "Alerts", icon: Bell, hint: "Alt+4" },
  { id: "pumps", href: route("/pumps"), label: "Pumps", icon: Droplets, hint: "Alt+5" },
  { id: "whatif", href: route("/whatif"), label: "What-if", icon: FlaskConical, hint: "Alt+6" },
  { id: "replay", href: route("/replay"), label: "Replay", icon: Play, hint: "Alt+7" },
  { id: "verify", href: route("/verify"), label: "Verify", icon: BadgeCheck, hint: "Alt+8" },
  { id: "onboard", href: route("/onboard"), label: "Onboard", icon: MapPinned, hint: "Alt+9" },
];

/** True when `pathname` is on or under a rail item's href. */
export function isNavActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  const base = href.split("?")[0] ?? href;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Rail item for a pathname, or null on pages outside the rail (landing, design). */
export function activeNavItem(pathname: string | null): NavItem | null {
  return NAV_ITEMS.find((item) => isNavActive(pathname, item.href)) ?? null;
}

/** Command palette entries. Navigation is derived from NAV_ITEMS; actions are listed here. */
export type PaletteActionId =
  | "toggle-play"
  | "compute-live"
  | "copy-run-id"
  | "dispatch-pumps"
  | "clean-top-pipes"
  | "open-settings"
  | "show-shortcuts";

export interface PaletteAction {
  id: PaletteActionId;
  label: string;
  /** Keyboard hint, if the action has one. */
  hint?: string;
  /** When true the action only works with a loaded run and is disabled until then. */
  needsRun: boolean;
  /** Plain-language reason shown while disabled. */
  disabledReason?: string;
}

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  { id: "toggle-play", label: "Play or pause the replay", hint: "Space", needsRun: false },
  {
    id: "compute-live",
    label: "Compute live",
    needsRun: true,
    disabledReason: "Available once a run is loaded",
  },
  {
    id: "copy-run-id",
    label: "Copy run id",
    needsRun: true,
    disabledReason: "Available once a run is loaded",
  },
  {
    id: "dispatch-pumps",
    label: "Dispatch pumps at a hotspot",
    needsRun: true,
    disabledReason: "Available once a run has hotspots",
  },
  {
    id: "clean-top-pipes",
    label: "Clean top pipes in what-if",
    needsRun: true,
    disabledReason: "Available once a run has attribution",
  },
  { id: "open-settings", label: "Open settings", needsRun: false },
  { id: "show-shortcuts", label: "Show keyboard shortcuts", hint: "?", needsRun: false },
];

/** A hotspot as the palette lists it; the console passes these once a run is loaded. */
export interface PaletteHotspot {
  id: string;
  name: string;
  /** p50 depth in cm at the selected time, if known. */
  depthCm?: number;
}
