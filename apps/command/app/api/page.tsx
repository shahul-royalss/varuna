import type { Metadata } from "next";

import { ApiScreen } from "./api-screen";

export const metadata: Metadata = {
  title: "API explorer",
  description:
    "The VARUNA OpenAPI document with three ready-made requests: segments in a bounding box, an ambulance route from KEM Hospital to Sion Hospital, and a what-if at 1.3x rain.",
};

export default function ApiPage() {
  return <ApiScreen />;
}
