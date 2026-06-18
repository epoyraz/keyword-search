// The engine moved into a Web Worker (lib/search.worker.ts) driven by
// lib/searchClient.ts. This module now just re-exports the shared types so
// existing imports of "@/lib/search" keep working.
export * from "./types";
