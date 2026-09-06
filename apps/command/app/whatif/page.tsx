import type { Metadata } from "next";

import { WhatIfScreen } from "./whatif-screen";

export const metadata: Metadata = {
  title: "What-if lab",
  description:
    "Ask the twin a question and get the answer before the next radar frame: rain scale, tide offset, cleaned pipes and a pump plan, run through the reduced-order emulator.",
};

export default function WhatIfPage() {
  return <WhatIfScreen />;
}
