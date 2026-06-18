import type { NextConfig } from "next";
import path from "node:path";

const root = path.resolve(__dirname);

const nextConfig: NextConfig = {
  // Standalone output so the Cloud Run image ships a self-contained server.js.
  output: "standalone",
  // Other lockfiles exist in parent dirs; pin the root so dev's workspace
  // inference and standalone file-tracing both resolve to this project.
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;
