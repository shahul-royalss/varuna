import type { Metadata } from "next";

import { OnboardScreen } from "./onboard-screen";

export const metadata: Metadata = {
  title: "City in a box",
  description:
    "Onboard a new city from open data: terrain, roads, inferred drains and a first uncalibrated forecast. Chennai in minutes.",
};

export default function OnboardPage() {
  return <OnboardScreen />;
}
