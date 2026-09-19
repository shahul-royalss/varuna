import type { Metadata } from "next";

import { AuthorityScreen } from "./authority-screen";

export const metadata: Metadata = {
  title: "Ward officer's desk",
  description:
    "Close a street, withhold a pump, dispatch the plan and acknowledge an alert. Every edit is appended to VARUNA's ops log and applied when a route is read.",
  // The desk is not a public page: it takes a shared passphrase and shows an operational log.
  robots: { index: false, follow: false },
};

export default function AuthorityPage() {
  return <AuthorityScreen />;
}
