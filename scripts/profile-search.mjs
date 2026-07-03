// Focused profiler: where does a query's time actually go? Loads the prebuilt
// binary index (public/search-index.bin) into the installed minisearch-wasm
// package and times each stage over the shared query set — exact scoring,
// +prefix expansion, +fuzzy expansion, the searchJoined boundary, JS-side
// decode, and the searchRaw typed-array path — plus the JS MiniSearch app path
// for reference. Iterations repeat the same queries, so engine numbers show
// the warm expansion-cache path (representative of search-as-you-type; the
// first run of a query is slower).
//
// Run: npm run profile   (or: node --expose-gc scripts/profile-search.mjs)
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import MiniSearch from "minisearch";
import init, { MiniSearchWasm } from "minisearch-wasm";
import { miniSearchOptions } from "../lib/searchConfig.mjs";
import { loadFullDocs } from "./loadDocs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INDEX_BIN = path.resolve(ROOT, "public", "search-index.bin");
const WASM_FILE = path.resolve(ROOT, "node_modules", "minisearch-wasm", "minisearch_wasm_bg.wasm");

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
      checksum += typeof r === "number" ? r : Array.isArray(r) ? r.length : (r.count ?? 0);
    }
  }
  const s = summarize(samples);
  console.log(
    `${label.padEnd(30)} mean ${s.mean.toFixed(4)}ms  median ${s.median.toFixed(4)}ms  p95 ${s.p95.toFixed(4)}ms  checksum ${checksum}`,
  );
  return s;
}

async function main() {
  console.log(`profiler — queries ${QUERY_SET.length}, warmup ${WARMUP}, iters ${ITERS}`);

  const [{ jobs }, indexBin, wasmBin] = await Promise.all([
    loadFullDocs(path.resolve(ROOT, "public")),
    readFile(INDEX_BIN),
    readFile(WASM_FILE),
  ]);
  await init({ module_or_path: wasmBin });
  const wasm = MiniSearchWasm.loadBytes(new Uint8Array(indexBin));
  const idTable = wasm.docIdTable().split("\n");

  const js = new MiniSearch(miniSearchOptions());
  js.addAll(jobs);

  // The end-to-end app workload: produce [{id, score, terms}] for a query.
  const jsApp = (q) => {
    const res = js.search(q);
    const out = new Array(res.length);
    for (let i = 0; i < res.length; i++) out[i] = { id: res[i].id, score: res[i].score, terms: res[i].terms };
    return out;
  };
  const wasmJoined = (q) => {
    const r = wasm.searchJoined(q, false);
    const out = new Array(r.count);
    if (!r.count) return out;
    const ids = r.ids.split("\n");
    const rows = r.terms.split("\n");
    for (let i = 0; i < r.count; i++) out[i] = { id: ids[i], score: r.scores[i], terms: rows[i] ? rows[i].split(" ") : [] };
    return out;
  };
  // The worker's actual path since 0.8.0: typed arrays + one interned term table.
  const wasmRaw = (q) => {
    const r = wasm.searchRaw(q);
    const termTable = r.termTable ? r.termTable.split("\n") : [];
    const out = new Array(r.count);
    for (let i = 0; i < r.count; i++) {
      const terms = [];
      for (let k = r.termOffsets[i]; k < r.termOffsets[i + 1]; k++) terms.push(termTable[r.termIds[k]]);
      out[i] = { id: idTable[r.docIds[i]], score: r.scores[i], terms };
    }
    return out;
  };

  console.log("\n--- engine stages (hit count only; isolates compute) ---");
  bench("exact scoring only", (q) => wasm.searchCountOpts(q, false, false));
  bench("+ prefix expansion", (q) => wasm.searchCountOpts(q, true, false));
  const engine = bench("+ prefix + fuzzy (full)", (q) => wasm.searchCountOpts(q, true, true));

  console.log("\n--- boundary + decode ---");
  bench("searchJoined (no decode)", (q) => wasm.searchJoined(q, false));
  bench("searchRaw (no decode)", (q) => wasm.searchRaw(q));

  console.log("\n--- app workload ({id, score, terms} per hit) ---");
  const jsS = bench("JS MiniSearch", jsApp);
  const joinedS = bench("wasm searchJoined + decode", wasmJoined);
  const rawS = bench("wasm searchRaw + decode", wasmRaw);

  console.log("");
  console.log(`engine share of raw path:  ${((engine.mean / rawS.mean) * 100).toFixed(0)}%`);
  console.log(`APP  JS / wasm joined:  mean ${(jsS.mean / joinedS.mean).toFixed(2)}x  median ${(jsS.median / joinedS.median).toFixed(2)}x`);
  console.log(`APP  JS / wasm raw:     mean ${(jsS.mean / rawS.mean).toFixed(2)}x  median ${(jsS.median / rawS.median).toFixed(2)}x`);
}

main().catch((e) => { console.error(e); process.exit(1); });
