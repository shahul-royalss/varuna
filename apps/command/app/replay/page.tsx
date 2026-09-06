import type { Metadata } from "next";

import { ReplayScreen } from "./replay-screen";

export const metadata: Metadata = {
  title: "Replay",
  description:
    "Stream a past event through the live pipeline: bundle selection, the replay clock, the cycle log and the storm designer.",
};

export default function ReplayPage() {
  return <ReplayScreen />;
}
