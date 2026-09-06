import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  transpilePackages: ["@varuna/tokens"],
  // `make demo` serves the console from `next dev`, so the dev route indicator would sit in the
  // corner of the map on stage and in every docs/screens baseline. Compile and runtime errors are
  // still surfaced (CLAUDE.md section 15: nothing on screen that is not the product).
  devIndicators: false,
};

export default nextConfig;
