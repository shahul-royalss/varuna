import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import { Providers } from "@/lib/providers";

import "./globals.css";

/** Display face: landing headlines, page titles, the big depth number (CLAUDE.md section 6.3). */
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-bricolage",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "VARUNA",
    template: "%s - VARUNA",
  },
  description:
    "Street-level urban flood nowcasting digital twin: Doppler radar to street-by-street depth for the next three hours, a drain map that learns from every flood, and routes for emergency services. SIH 2026, PS SIH26085.",
  applicationName: "VARUNA",
  icons: {
    icon: "/icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#0A1020", // lint-design-allow: browser chrome colour must be a literal; equals --ink
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark h-full ${bricolage.variable} ${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="flex min-h-full flex-col bg-ink font-sans text-text antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
