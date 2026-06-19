// Main-thread facade over the search Web Worker. Fetches the tiny meta file
// (stats + version) so filters populate immediately, kicks off the worker's
// index load, and correlates async search requests/responses by id.

import type {
  IndexStats,
  SearchArgs,
  SearchOutcome,
  WorkerRequest,
  WorkerResponse,
} from "./types";

let worker: Worker | null = null;
let reqSeq = 0;
const pending = new Map<number, (o: SearchOutcome) => void>();
let statsCache: IndexStats | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./search.worker.ts", import.meta.url));
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const m = e.data;
    if (m.type === "result") {
      pending.get(m.reqId)?.(m.outcome);
      pending.delete(m.reqId);
    } else if (m.type === "error") {
      console.error("search worker error:", m.message);
    }
  };
  // Surface module-load/instantiation failures (otherwise the UI hangs forever
  // on "Building local index…").
  worker.onerror = (e) => {
    const msg = e.message || "worker failed to load";
    console.error("search worker failed:", msg, e);
    (globalThis as Record<string, unknown>).__workerError = msg;
  };
  return worker;
}

/** Fetch index metadata and start the worker loading the index. */
export async function loadIndex(): Promise<IndexStats> {
  if (statsCache) return statsCache;
  const res = await fetch("/search-meta.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load index metadata: ${res.status}`);
  const meta = (await res.json()) as IndexStats;
  statsCache = meta;
  ensureWorker().postMessage({ type: "load", version: meta.version } satisfies WorkerRequest);
  return meta;
}

/** Run a search in the worker. Resolves once the index is loaded. */
export function search(args: SearchArgs): Promise<SearchOutcome> {
  const reqId = ++reqSeq;
  return new Promise<SearchOutcome>((resolve) => {
    pending.set(reqId, resolve);
    ensureWorker().postMessage({ type: "search", reqId, args } satisfies WorkerRequest);
  });
}
