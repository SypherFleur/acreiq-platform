import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  output: "standalone",
  // An isolated local verification build must not overwrite the running managed build.
  distDir: process.env.ACREIQ_BUILD_DIR || ".next",
  outputFileTracingRoot: path.resolve(process.cwd()),
  poweredByHeader: false,
  devIndicators: false,
};

export default config;
