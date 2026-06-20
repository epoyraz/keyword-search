// Headless, UI-free benchmark: the installed `minisearch` (pure JS) vs
// `minisearch-wasm` (Rust/Wasm) npm packages, over the real public/jobs.json.
//
// Unlike scripts/bench-search-engines.mjs (which points at a sibling
// minisearch-rust checkout), this one uses exactly the two libraries the app
// depends on, and restores the same prebuilt snapshot (public/search-index.bin)
// the browser loads. It reports indexing time, snapshot-load time, search
// latency, and a correctness/agreement check so any speed claim is honest.
//
// Run: npm run bench:wasm     (or: node --expose-gc scripts/bench-minisearch-vs-wasm.mjs)

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import MiniSearch from "minisearch";
import init, { MiniSearchWasm } from "minisearch-wasm";
import { SEARCH_FIELDS, SEARCH_OPTIONS, miniSearchOptions } from "../lib/searchConfig.mjs";
import { loadFullDocs } from "./loadDocs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.resolve(ROOT, "public");
const INDEX_BIN = path.resolve(ROOT, "public", "search-index.bin");
const WASM_FILE = path.resolve(ROOT, "node_modules", "minisearch-wasm", "minisearch_wasm_bg.wasm");

// Same options the app uses. minisearch-wasm takes a named tokenizer
// ("jobboard") baked into the engine; minisearch takes the JS tokenize/process.
const wasmOptions = {
  idField: "id",
  fields: SEARCH_FIELDS,
  tokenizer: "jobboard",
  searchOptions: SEARCH_OPTIONS,
};

const QUERY_SET = [
  "software engineer", "data engineer", "project manager", "product manager",
  "java", "javascript", "python", "react", "cloud", "kubernetes", "devops",
  "security", "sales", "marketing", "finance", "pflege", "fachperson",
  "sachbearbeiter", "apprentissage", "praktikum", "remote", "zürich", "c++",
  "c#", ".net", "node.js", "machine learning", "business analyst",
  "hr manager", "logistik",
];

const iterations = Number(process.env.BENCH_ITERS ?? 120);
const warmupIterations = Number(process.env.BENCH_WARMUP ?? 30);
const topK = Number(process.env.BENCH_TOPK ?? 20);
const EPS = 1e-9;

const ms = (v) => `${v.toFixed(3)}ms`;
const mb = (v) => `${(v / 1024 / 1024).toFixed(1)} MB`;
const num = (v) => v.toLocaleString("en-US");

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, v) => a + v, 0);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return { mean: sum / samples.length, median: pct(0.5), p95: pct(0.95), min: sorted[0], max: sorted.at(-1) };
}

function measure(label, fn) {
  global.gc?.();
  const start = performance.now();
  const value = fn();
  const duration = performance.now() - start;
  console.log(`${label.padEnd(30)} ${ms(duration)}`);
  return { value, duration };
}

// Like measure(), but runs `factory` k times (after a warmup) taking the median,
// and frees throwaway instances between runs. A single cold call to loadBytes is
// badly skewed by whatever else is on the heap at that moment (it clocked ~20×
// the browser otherwise); repeating in isolation with frees gives a stable,
// representative figure. `free` disposes an instance we won't keep.
function measureRepeat(label, factory, k, free) {
  global.gc?.();
  const warm = factory();
  free?.(warm);
  const samples = [];
  let last;
  for (let i = 0; i < k; i++) {
    global.gc?.();
    const start = performance.now();
    const value = factory();
    samples.push(performance.now() - start);
    if (i === k - 1) last = value;
    else free?.(value);
  }
  const s = summarize(samples);
  console.log(`${label.padEnd(30)} ${ms(s.median)}  (min ${ms(s.min)}, median of ${k})`);
  return { value: last, duration: s.median };
}

function measureQueries(label, searchFn) {
  for (let i = 0; i < warmupIterations; i++) for (const q of QUERY_SET) searchFn(q);
  global.gc?.();
  const samples = [];
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    for (const q of QUERY_SET) {
      const start = performance.now();
      const r = searchFn(q);
      samples.push(performance.now() - start);
      checksum += Array.isArray(r) ? r.length : r.count ?? r;
    }
  }
  const s = summarize(samples);
  console.log(
    `${label.padEnd(20)} mean ${ms(s.mean).padStart(10)} median ${ms(s.median).padStart(10)} p95 ${ms(s.p95).padStart(10)} min ${ms(s.min).padStart(10)} (checksum ${checksum})`,
  );
  return s;
}

// minisearch-wasm searchJoined → array of {id, score, terms} (the app path).
function decodeJoined(r) {
  const out = new Array(r.count);
  if (!r.count) return out;
  const ids = r.ids.split("\n");
  const termRows = r.terms.split("\n");
  for (let i = 0; i < r.count; i++) {
    out[i] = { id: ids[i], score: r.scores[i], terms: termRows[i] ? termRows[i].split(" ") : [] };
  }
  return out;
}

function checkAgreement(jsSearch, wasmSearch) {
  let countMatch = 0, top1 = 0, setIdentical = 0, overlapSum = 0, maxScoreDelta = 0, realRankingBugs = 0;
  for (const q of QUERY_SET) {
    const a = jsSearch(q);
    const b = wasmSearch(q);
    if (a.length === b.length) countMatch++;
    if (a[0]?.id === b[0]?.id) top1++;

    const aScore = new Map(a.map((r) => [String(r.id), r.score]));
    const bScore = new Map(b.map((r) => [String(r.id), r.score]));
    let identical = a.length === b.length && aScore.size === bScore.size;
    for (const [id, sc] of aScore) {
      const t = bScore.get(id);
      if (t == null) identical = false;
      else maxScoreDelta = Math.max(maxScoreDelta, Math.abs(sc - t));
    }
    if (identical && maxScoreDelta <= EPS) setIdentical++;

    const aTop = a.slice(0, topK).map((r) => String(r.id));
    const bTop = new Set(b.slice(0, topK).map((r) => String(r.id)));
    const overlap = aTop.filter((id) => bTop.has(id)).length;
    overlapSum += aTop.length ? overlap / aTop.length : 1;

    // A position where ids differ AND scores differ is a real ranking bug;
    // equal-score ties broken differently are not.
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (String(a[i].id) !== String(b[i].id)) {
        if (Math.abs(a[i].score - b[i].score) > EPS) realRankingBugs++;
        break;
      }
    }
  }
  const n = QUERY_SET.length;
  console.log("\nCorrectness / agreement");
  console.log(`  count match:        ${countMatch}/${n}`);
  console.log(`  top-1 match:        ${top1}/${n}`);
  console.log(`  set-identical:      ${setIdentical}/${n} (max BM25 score delta ${maxScoreDelta.toExponential(2)})`);
  console.log(`  avg top-${topK} overlap:  ${(overlapSum / n * 100).toFixed(1)}%`);
  console.log(`  real ranking bugs:  ${realRankingBugs}/${n} (order diffs are equal-score ties)`);
}

function faster(label, jsVal, wasmVal) {
  const [fast, slow, fastName, slowName] =
    wasmVal <= jsVal
      ? [wasmVal, jsVal, "minisearch-wasm", "minisearch"]
      : [jsVal, wasmVal, "minisearch", "minisearch-wasm"];
  const pct = slow > 0 ? ((slow - fast) / slow) * 100 : 0;
  const ratio = fast > 0 ? slow / fast : Infinity;
  console.log(`  ${label.padEnd(16)} ${fastName} is ${pct.toFixed(0)}% faster than ${slowName} (${ratio.toFixed(2)}×)`);
}

async function main() {
  console.log("minisearch vs minisearch-wasm — headless benchmark");
  console.log(`queries: ${QUERY_SET.length}, warmup: ${warmupIterations}, iterations: ${iterations}, topK: ${topK}`);

  const [{ jobs, fullJobsJson, metaJobsJson }, indexBin, wasmBin] = await Promise.all([
    loadFullDocs(PUBLIC_DIR),
    readFile(INDEX_BIN),
    readFile(WASM_FILE),
  ]);
  console.log(`\ndocs: ${num(jobs.length)} · jobs.json ${mb(Buffer.byteLength(metaJobsJson))} (metadata) · search-index.bin ${mb(indexBin.byteLength)}`);

  await init({ module_or_path: wasmBin });

  // --- loading prebuilt snapshot (measured first, in isolation) -----------
  // Restoring a snapshot is what the app actually does on startup. Measure it
  // before building/serializing the big in-memory indexes below, so the heap is
  // light and the numbers match real conditions (cf. the browser's loadBytes).
  console.log("\nLoading prebuilt snapshot (restore, lower is better)");
  const wasmLoad = measureRepeat(
    "minisearch-wasm loadBytes",
    () => MiniSearchWasm.loadBytes(new Uint8Array(indexBin)),
    6,
    (m) => m.free(),
  );
  const wasm = wasmLoad.value; // keep the last instance for searching

  // --- indexing from scratch ---------------------------------------------
  console.log("\nIndexing from scratch (build, lower is better)");
  const jsBuild = measure("minisearch addAll", () => {
    const mini = new MiniSearch(miniSearchOptions());
    mini.addAll(jobs);
    return mini;
  });
  const wasmBuild = measure("minisearch-wasm addAllJSON", () => {
    const mini = new MiniSearchWasm(wasmOptions);
    mini.addAllJSON(fullJobsJson);
    return mini;
  });
  wasmBuild.value.free(); // not needed past the timing; release wasm memory

  // minisearch's own snapshot path for reference (JSON, vs wasm's binary).
  const jsSerialized = JSON.stringify(jsBuild.value);
  const jsLoad = measureRepeat(
    "minisearch loadJSON",
    () => MiniSearch.loadJSON(jsSerialized, miniSearchOptions()),
    6,
  );
  console.log(`  snapshot sizes: minisearch JSON ${mb(Buffer.byteLength(jsSerialized))} · minisearch-wasm binary ${mb(indexBin.byteLength)}`);

  // Query the loaded instances (what the app actually runs against).
  const js = jsLoad.value;

  // --- app-path search functions -----------------------------------------
  // The app only needs {id, score, terms} per hit. minisearch returns rich
  // objects (we read the 3 fields); minisearch-wasm returns exactly those via
  // searchJoined. Both produce the same 3-field shape for a fair comparison.
  const jsApp = (q) => {
    const res = js.search(q);
    const out = new Array(res.length);
    for (let i = 0; i < res.length; i++) out[i] = { id: res[i].id, score: res[i].score, terms: res[i].terms };
    return out;
  };
  const wasmApp = (q) => decodeJoined(wasm.searchJoined(q, false));

  checkAgreement(jsApp, wasmApp);

  console.log("\nSearch latency — app path (each produces {id, score, terms})");
  const jsAppS = measureQueries("minisearch", jsApp);
  const wasmAppS = measureQueries("minisearch-wasm", wasmApp);

  console.log("\nSearch latency — full search() API (reference)");
  const jsFullS = measureQueries("minisearch", (q) => js.search(q));
  const wasmFullS = measureQueries("minisearch-wasm", (q) => wasm.search(q, SEARCH_OPTIONS));
  // Same rich shape minus the per-hit `match` map (opt-in). Most apps never read
  // `match`; skipping it removes the biggest remaining boundary cost.
  const leanOptions = { ...SEARCH_OPTIONS, includeMatch: false };
  const wasmLeanS = measureQueries("minisearch-wasm -match", (q) => wasm.search(q, leanOptions));

  // --- summary ------------------------------------------------------------
  console.log("\nSummary (who is faster)");
  faster("search (mean)", jsAppS.mean, wasmAppS.mean);
  faster("search (median)", jsAppS.median, wasmAppS.median);
  faster("full search()", jsFullS.mean, wasmFullS.mean);
  faster("full -match", jsFullS.mean, wasmLeanS.mean);
  faster("index build", jsBuild.duration, wasmBuild.duration);
  faster("snapshot load", jsLoad.duration, wasmLoad.duration);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
