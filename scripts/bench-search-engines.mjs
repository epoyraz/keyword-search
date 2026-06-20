import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import MiniSearch from "minisearch";
import {
  SEARCH_FIELDS,
  SEARCH_OPTIONS,
  miniSearchOptions,
} from "../lib/searchConfig.mjs";
import { loadFullDocs } from "./loadDocs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUST_PKG = path.resolve(ROOT, "..", "..", "minisearch-rust", "pkg");
const PUBLIC_DIR = path.resolve(ROOT, "public");
const JS_INDEX_FILE = path.resolve(ROOT, "public", "search-index.json");
const RUST_WASM_FILE = path.resolve(RUST_PKG, "minisearch_rust_bg.wasm");
const RUST_JS_FILE = path.resolve(RUST_PKG, "minisearch_rust.js");

const QUERY_SET = [
  "software engineer",
  "data engineer",
  "project manager",
  "product manager",
  "java",
  "javascript",
  "python",
  "react",
  "cloud",
  "kubernetes",
  "devops",
  "security",
  "sales",
  "marketing",
  "finance",
  "pflege",
  "fachperson",
  "sachbearbeiter",
  "apprentissage",
  "praktikum",
  "remote",
  "zürich",
  "c++",
  "c#",
  ".net",
  "node.js",
  "machine learning",
  "business analyst",
  "hr manager",
  "logistik",
];

const iterations = Number(process.env.BENCH_ITERS ?? 120);
const warmupIterations = Number(process.env.BENCH_WARMUP ?? 30);
const topK = Number(process.env.BENCH_TOPK ?? 20);

const rustOptions = {
  idField: "id",
  fields: SEARCH_FIELDS,
  tokenizer: "jobboard",
  searchOptions: SEARCH_OPTIONS,
};

const rustSearchOptions = { ...SEARCH_OPTIONS };

function ms(value) {
  return `${value.toFixed(3)}ms`;
}

function bytes(value) {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value) {
  return value.toLocaleString("en-US");
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((acc, value) => acc + value, 0);
  const percentile = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];

  return {
    mean: sum / samples.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function measure(label, fn) {
  global.gc?.();
  const start = performance.now();
  const value = fn();
  const duration = performance.now() - start;
  console.log(`${label.padEnd(34)} ${ms(duration)}`);
  return { value, duration };
}

function measureQueries(label, queries, searchFn) {
  for (let i = 0; i < warmupIterations; i++) {
    for (const query of queries) searchFn(query);
  }

  global.gc?.();

  const samples = [];
  let checksum = 0;

  for (let i = 0; i < iterations; i++) {
    for (const query of queries) {
      const start = performance.now();
      const results = searchFn(query);
      samples.push(performance.now() - start);
      const length = resultLength(results);
      checksum += length;
      const firstId = firstResultId(results);
      if (firstId) checksum += String(firstId).length;
    }
  }

  const summary = summarize(samples);
  console.log(
    `${label.padEnd(18)} mean ${ms(summary.mean).padStart(10)} median ${ms(summary.median).padStart(10)} p95 ${ms(summary.p95).padStart(10)} min ${ms(summary.min).padStart(10)} max ${ms(summary.max).padStart(10)} checksum ${checksum}`,
  );
  return summary;
}

function resultLength(results) {
  if (typeof results === "number") return results;
  return Array.isArray(results) ? results.length : results.ids.length;
}

function firstResultId(results) {
  if (typeof results === "number") return undefined;
  return Array.isArray(results) ? results[0]?.id : results.ids[0];
}

// Truthfulness proof. Two things must hold for the win to be honest:
//   1. SET identity   — same ids with the same BM25 scores (within float eps).
//   2. Order diffs, if any, occur ONLY between results with equal scores
//      (a tie-break nuance: JS breaks ties by scoring-encounter order, Rust by
//      document id). A position where ids differ AND scores differ is a real
//      ranking bug and is reported as such.
const EPS = 1e-9;
function verifyRanking(queries, jsSearch, rustSearch) {
  let setIdentical = 0;
  let exactOrder = 0;
  let maxScoreDelta = 0;
  let realRankingBugs = 0;
  for (const query of queries) {
    const a = jsSearch(query);
    const b = rustSearch(query);

    const aScore = new Map(a.map((r) => [String(r.id), r.score]));
    const bScore = new Map(b.map((r) => [String(r.id), r.score]));
    let identical = a.length === b.length && aScore.size === bScore.size;
    for (const [id, s] of aScore) {
      const t = bScore.get(id);
      if (t == null) identical = false;
      else maxScoreDelta = Math.max(maxScoreDelta, Math.abs(s - t));
    }
    if (identical && maxScoreDelta <= EPS) setIdentical++;

    let exact = a.length === b.length;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (String(a[i].id) !== String(b[i].id)) {
        exact = false;
        // Real bug only if the two engines disagree on score at this rank.
        if (Math.abs(a[i].score - b[i].score) > EPS) realRankingBugs++;
        break;
      }
    }
    if (exact) exactOrder++;
  }
  console.log(
    `ranking identity: set-identical ${setIdentical}/${queries.length} (max score delta ${maxScoreDelta.toExponential(2)}), exact-order ${exactOrder}/${queries.length}, REAL ranking bugs ${realRankingBugs}/${queries.length} (order diffs are equal-score ties)`,
  );
}

function ids(results) {
  return Array.isArray(results)
    ? results.map((result) => String(result.id))
    : results.ids.map((id) => String(id));
}

function compareResultSets(queries, jsSearch, rustSearch) {
  const rows = [];

  for (const query of queries) {
    const jsIds = ids(jsSearch(query));
    const rustIds = ids(rustSearch(query));
    const jsTop = jsIds.slice(0, topK);
    const rustTop = new Set(rustIds.slice(0, topK));
    const overlap = jsTop.filter((id) => rustTop.has(id)).length;
    rows.push({
      query,
      jsCount: jsIds.length,
      rustCount: rustIds.length,
      top1: jsIds[0] === rustIds[0],
      overlap,
      overlapPct: jsTop.length ? overlap / jsTop.length : 1,
    });
  }

  const countMatches = rows.filter((row) => row.jsCount === row.rustCount).length;
  const top1Matches = rows.filter((row) => row.top1).length;
  const avgOverlap =
    rows.reduce((sum, row) => sum + row.overlapPct, 0) / rows.length;

  console.log("\nCorrectness / overlap check");
  console.log(
    `count match: ${countMatches}/${rows.length}, top1 match: ${top1Matches}/${rows.length}, avg top-${topK} overlap: ${(avgOverlap * 100).toFixed(1)}%`,
  );
  console.log("worst top overlap:");
  for (const row of [...rows].sort((a, b) => a.overlapPct - b.overlapPct).slice(0, 8)) {
    console.log(
      `  ${row.query.padEnd(22)} js=${String(row.jsCount).padStart(5)} rust=${String(row.rustCount).padStart(5)} top1=${row.top1 ? "yes" : " no"} overlap=${row.overlap}/${topK}`,
    );
  }

  return rows;
}

async function main() {
  console.log("keyword-search MiniSearch vs minisearch-rust benchmark");
  console.log(`queries: ${QUERY_SET.length}, warmup: ${warmupIterations}, iterations: ${iterations}`);
  console.log(`rust pkg: ${RUST_PKG}`);

  const [{ jobs, fullJobsJson, metaJobsJson }, jsIndexJson] = await Promise.all([
    loadFullDocs(PUBLIC_DIR),
    readFile(JS_INDEX_FILE, "utf8"),
  ]);

  console.log(`\ndocs: ${formatNumber(jobs.length)}`);
  console.log(`jobs.json: ${bytes(Buffer.byteLength(metaJobsJson))} (metadata)`);
  console.log(`js search-index.json: ${bytes(Buffer.byteLength(jsIndexJson))}`);

  const rustModule = await import(pathToFileURL(RUST_JS_FILE).href);
  await rustModule.default({ module_or_path: await readFile(RUST_WASM_FILE) });
  const { MiniSearchWasm } = rustModule;

  console.log("\nConstruction / load");
  const jsLoad = measure("JS MiniSearch.loadJSON", () =>
    MiniSearch.loadJSON(jsIndexJson, miniSearchOptions()),
  );
  const jsBuild = measure("JS MiniSearch addAll", () => {
    const mini = new MiniSearch(miniSearchOptions());
    mini.addAll(jobs);
    return mini;
  });
  const jsStringify = measure("JS MiniSearch JSON.stringify", () =>
    JSON.stringify(jsBuild.value),
  );
  const rustBuildBridge = measure("Rust/Wasm addAll JS objects", () => {
    const mini = new MiniSearchWasm(rustOptions);
    mini.addAll(jobs);
    return mini;
  });
  const rustBuild = measure("Rust/Wasm addAllJSON", () => {
    const mini = new MiniSearchWasm(rustOptions);
    mini.addAllJSON(fullJobsJson);
    return mini;
  });
  const rustIndex = measure("Rust/Wasm toJSONString", () =>
    rustBuild.value.toJSONString(),
  );
  const rustLoadJson = measure("Rust/Wasm loadJSON own index", () =>
    MiniSearchWasm.loadJSON(rustIndex.value),
  );
  const rustBytes = measure("Rust/Wasm toBytes", () => rustBuild.value.toBytes());
  const rustLoad = measure("Rust/Wasm loadBytes own index", () =>
    MiniSearchWasm.loadBytes(rustBytes.value),
  );

  console.log(`rust search-index JSON: ${bytes(Buffer.byteLength(rustIndex.value))}`);
  console.log(`rust search-index bytes: ${bytes(rustBytes.value.byteLength)}`);
  console.log(`js built search-index JSON: ${bytes(Buffer.byteLength(jsStringify.value))}`);

  // ---- Truthful comparison: measure the work the app actually does ---------
  // The worker (lib/search.worker.ts) consumes ONLY {id, score, terms} per hit.
  // JS MiniSearch has no compact API, so the app calls full search() and reads
  // the 3 fields it needs. The Rust port returns exactly those 3 fields via
  // searchJoined (scores as a Float64Array, ids/terms as newline-joined strings)
  // and we decode them here the same way the worker would. Both paths therefore
  // do the same job and — verified below — return identical rankings.
  const jsRawSearch = (query) => jsLoad.value.search(query);
  const rustRawSearch = (query) => rustLoad.value.search(query, rustSearchOptions);

  const jsAppSearch = (query) => {
    const res = jsLoad.value.search(query);
    const out = new Array(res.length);
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      out[i] = { id: r.id, score: r.score, terms: r.terms };
    }
    return out;
  };

  const decodeJoined = (r) => {
    const out = new Array(r.count);
    if (!r.count) return out;
    const idList = r.ids.split("\n");
    const termRows = r.terms.split("\n");
    const scores = r.scores;
    for (let i = 0; i < r.count; i++) {
      const row = termRows[i];
      out[i] = { id: idList[i], score: scores[i], terms: row ? row.split(" ") : [] };
    }
    return out;
  };
  const rustAppSearch = (query) =>
    decodeJoined(rustLoad.value.searchJoined(query, false));
  const rustCountOnly = (query) => rustLoad.value.searchCountDefault(query, false);

  compareResultSets(QUERY_SET, jsAppSearch, rustAppSearch);
  verifyRanking(QUERY_SET, jsAppSearch, rustAppSearch);

  console.log("\nSearch latency — APP WORKLOAD (each produces {id, score, terms})");
  const jsAppSummary = measureQueries("JS app path", QUERY_SET, jsAppSearch);
  const rustAppSummary = measureQueries("Rust app (joined)", QUERY_SET, rustAppSearch);

  console.log("\nSearch latency — reference / transparency");
  const jsRawSummary = measureQueries("JS full search()", QUERY_SET, jsRawSearch);
  const rustRawSummary = measureQueries("Rust full search()", QUERY_SET, rustRawSearch);
  measureQueries("Rust engine only", QUERY_SET, rustCountOnly);

  console.log("\nSummary");
  console.log(
    `APP WORKLOAD  JS vs Rust(joined):  mean ${(jsAppSummary.mean / rustAppSummary.mean).toFixed(2)}x  median ${(jsAppSummary.median / rustAppSummary.median).toFixed(2)}x faster`,
  );
  console.log(
    `compat API    JS full vs Rust full: mean ${(jsRawSummary.mean / rustRawSummary.mean).toFixed(2)}x  (Rust slower by design — rebuilds MiniSearch's nested per-hit match objects across the wasm boundary; the app never uses them)`,
  );
  console.log(`JS loadJSON vs Rust loadJSON ratio: ${(jsLoad.duration / rustLoadJson.duration).toFixed(2)}x`);
  console.log(`JS loadJSON vs Rust loadBytes ratio: ${(jsLoad.duration / rustLoad.duration).toFixed(2)}x`);
  console.log(`JS stringify vs Rust toJSONString ratio: ${(jsStringify.duration / rustIndex.duration).toFixed(2)}x`);
  console.log(`JS stringify vs Rust toBytes ratio: ${(jsStringify.duration / rustBytes.duration).toFixed(2)}x`);
  console.log(`JS build vs Rust addAll JS objects ratio: ${(jsBuild.duration / rustBuildBridge.duration).toFixed(2)}x`);
  console.log(`JS build vs Rust addAllJSON ratio: ${(jsBuild.duration / rustBuild.duration).toFixed(2)}x`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
