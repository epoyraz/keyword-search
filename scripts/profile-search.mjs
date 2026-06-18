// Focused profiler: isolates search-compute from boundary/serialization cost.
// Loads the Rust index once (loadBytes) and JS index once (loadJSON), then
// times each path over the shared query set with heavy warmup + iterations.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import MiniSearch from "minisearch";
import { SEARCH_FIELDS, SEARCH_OPTIONS, miniSearchOptions } from "../lib/searchConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUST_PKG = path.resolve(ROOT, "..", "..", "minisearch-rust", "pkg");
const JOBS_FILE = path.resolve(ROOT, "public", "jobs.json");
const JS_INDEX_FILE = path.resolve(ROOT, "public", "search-index.json");

const QUERY_SET = [
  "software engineer", "data engineer", "project manager", "product manager",
  "java", "javascript", "python", "react", "cloud", "kubernetes", "devops",
  "security", "sales", "marketing", "finance", "pflege", "fachperson",
  "sachbearbeiter", "apprentissage", "praktikum", "remote", "zürich", "c++",
  "c#", ".net", "node.js", "machine learning", "business analyst", "hr manager",
  "logistik",
];

const ITERS = Number(process.env.PROF_ITERS ?? 300);
const WARMUP = Number(process.env.PROF_WARMUP ?? 60);

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return { mean: sum / samples.length, median: pct(0.5), p95: pct(0.95) };
}

function bench(label, fn) {
  for (let i = 0; i < WARMUP; i++) for (const q of QUERY_SET) fn(q);
  global.gc?.();
  const samples = [];
  let checksum = 0;
  for (let i = 0; i < ITERS; i++) {
    for (const q of QUERY_SET) {
      const t = performance.now();
      const r = fn(q);
      samples.push(performance.now() - t);
      checksum += typeof r === "number" ? r : Array.isArray(r) ? r.length : r.ids.length;
    }
  }
  const s = summarize(samples);
  console.log(
    `${label.padEnd(22)} mean ${s.mean.toFixed(3)}ms  median ${s.median.toFixed(3)}ms  p95 ${s.p95.toFixed(3)}ms  checksum ${checksum}`,
  );
  return s;
}

async function main() {
  console.log(`profiler — queries ${QUERY_SET.length}, warmup ${WARMUP}, iters ${ITERS}`);
  const jsIndexJson = await readFile(JS_INDEX_FILE, "utf8");
  const rustModule = await import(pathToFileURL(path.resolve(RUST_PKG, "minisearch_rust.js")).href);
  await rustModule.default({ module_or_path: await readFile(path.resolve(RUST_PKG, "minisearch_rust_bg.wasm")) });
  const { MiniSearchWasm } = rustModule;

  const jobsJson = await readFile(JOBS_FILE, "utf8");
  const rustOptions = { idField: "id", fields: SEARCH_FIELDS, tokenizer: "jobboard", searchOptions: SEARCH_OPTIONS };
  const rustMini = new MiniSearchWasm(rustOptions);
  rustMini.addAllJSON(jobsJson);
  const rust = MiniSearchWasm.loadBytes(rustMini.toBytes());
  const js = MiniSearch.loadJSON(jsIndexJson, miniSearchOptions());

  const opts = { ...SEARCH_OPTIONS };

  // The real end-to-end app workload: produce [{id, score, terms}] for a query.
  const jsApp = (q) => {
    const res = js.search(q);
    const out = new Array(res.length);
    for (let i = 0; i < res.length; i++) out[i] = { id: res[i].id, score: res[i].score, terms: res[i].terms };
    return out;
  };
  const rustApp = (q) => {
    const r = rust.searchJoined(q, false);
    const out = new Array(r.count);
    if (!r.count) return out;
    const ids = r.ids.split("\n");
    const rows = r.terms.split("\n");
    for (let i = 0; i < r.count; i++) out[i] = { id: ids[i], score: r.scores[i], terms: rows[i] ? rows[i].split(" ") : [] };
    return out;
  };

  console.log("");
  const jsAppS = bench("JS app path", jsApp);
  const rustAppS = bench("Rust app (joined)", rustApp);
  const jsFull = bench("JS full search", (q) => js.search(q));
  const countOnly = bench("Rust engine only", (q) => rust.searchCountDefault(q, false));

  console.log("");
  console.log(`APP PATH   JS / Rust(joined):  mean ${(jsAppS.mean / rustAppS.mean).toFixed(2)}x  median ${(jsAppS.median / rustAppS.median).toFixed(2)}x`);
  console.log(`ENGINE     JS full / Rust engine-only: mean ${(jsFull.mean / countOnly.mean).toFixed(2)}x  median ${(jsFull.median / countOnly.median).toFixed(2)}x`);
}

main().catch((e) => { console.error(e); process.exit(1); });
