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
  async headers() {
    return [
      {
        // Tiny version pointer — must always be fresh.
        source: "/search-meta.json",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
      {
        // Big assets are fetched with a ?v=<hash> query, so they can be cached
        // forever; a data change bumps the hash and busts the cache.
        source: "/:file(jobs.json|search-index.json)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
