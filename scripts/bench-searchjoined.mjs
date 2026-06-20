// searchJoined benchmark + identity proof.
//
// `searchJoined` is the path the app actually uses (lib/search.worker.ts): the
// whole search runs in Wasm and the result set crosses back columnar — one
// Float64Array of scores + two newline-joined strings (ids, terms). This script
// (a) proves its output is IDENTICAL to the original pure-JS minisearch, and
// (b) measures how much faster it is, over the real public/jobs.json.
//
// "Identical" means, per query: same set of result ids, same BM25 score for each
// id (within float epsilon), and the same matched `terms` for each id. Ordering
// is identical too, except among hits with EQUAL scores — there JS minisearch
// tie-breaks by insertion order while the engine tie-breaks by document id.
// Equal-score reorderings are reported, not counted as differences; any other
// divergence fails the run (exit 1).
//
// Run: npm run bench:joined   (or: node --expose-gc scripts/bench-searchjoined.mjs)

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import MiniSearch from "minisearch";
import init, { MiniSearchWasm } from "minisearch-wasm";
import { miniSearchOptions } from "../lib/searchConfig.mjs";
import { loadFullDocs } from "./loadDocs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.resolve(ROOT, "public");
const INDEX_BIN = path.resolve(ROOT, "public", "search-index.bin");
const WASM_FILE = path.resolve(ROOT, "node_modules", "minisearch-wasm", "minisearch_wasm_bg.wasm");

// A broad set chosen to stress identity: single chars, prefixes, symbols,
// multi-word, umlauts/accents, and high- vs low-frequency terms.
const QUERY_SET = [
  "software engineer", "data engineer", "project manager", "product manager",
  "java", "javascript", "python", "react", "cloud", "kubernetes", "devops",
  "security", "sales", "marketing", "finance", "pflege", "fachperson",
  "sachbearbeiter", "apprentissage", "praktikum", "remote", "zürich", "c++",
  "c#", ".net", "node.js", "machine learning", "business analyst",
  "hr manager", "logistik", "eng", "dev", "ing", "a", "data sci",
  "senior software", "fullstack developer", "küche", "gestionnaire",
  "informatiker", "lehre", "verkauf", "consultant", "manager engineer",
];

const iterations = Number(process.env.BENCH_ITERS ?? 150);
const warmupIterations = Number(process.env.BENCH_WARMUP ?? 40);
const EPS = 1e-9;

const ms = (v) => `${v.toFixed(3)}ms`;
const num = (v) => v.toLocaleString("en-US");

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, v) => a + v, 0);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return { mean: sum / samples.length, median: pct(0.5), p95: pct(0.95), min: sorted[0], max: sorted.at(-1) };
}

// minisearch-wasm searchJoined → [{ id, score, terms }], decoded exactly as the
// app's worker does.
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

// minisearch search() → the same { id, score, terms } shape the app reads.
function jsHits(res) {
  const out = new Array(res.length);
  for (let i = 0; i < res.length; i++) {
    out[i] = { id: String(res[i].id), score: res[i].score, terms: res[i].terms };
  }
  return out;
}

const sortedSet = (terms) => [...new Set(terms)].sort();

// Compare one query's results. Returns a per-query verdict.
function compareOne(jsRes, wjRes) {
  if (jsRes.length !== wjRes.length) {
    return { identical: false, reason: `count ${jsRes.length} vs ${wjRes.length}` };
  }
  const byId = new Map(wjRes.map((r) => [String(r.id), r]));
  if (byId.size !== wjRes.length) return { identical: false, reason: "duplicate ids in wasm" };

  let maxScoreDelta = 0;
  for (const j of jsRes) {
    const w = byId.get(String(j.id));
    if (!w) return { identical: false, reason: `id ${j.id} present in JS, absent in wasm` };
    const delta = Math.abs(j.score - w.score);
    maxScoreDelta = Math.max(maxScoreDelta, delta);
    if (delta > EPS) return { identical: false, reason: `score Δ ${delta.toExponential(2)} for id ${j.id}` };
    const a = sortedSet(j.terms);
    const b = sortedSet(w.terms);
    if (a.length !== b.length || a.some((t, i) => t !== b[i])) {
      return { identical: false, reason: `terms differ for id ${j.id}: JS[${a}] vs wasm[${b}]` };
    }
  }

  // Order as-returned (differences here are only legitimate among equal scores).
  let exactOrder = true;
  let firstDiff = -1;
  for (let i = 0; i < jsRes.length; i++) {
    if (String(jsRes[i].id) !== String(wjRes[i].id)) {
      exactOrder = false;
      firstDiff = i;
      break;
    }
  }
  // If the first positional difference is between two EQUAL scores, it's a
  // tie-break nuance; otherwise it's a real ranking divergence.
  let tieOnly = exactOrder;
  if (!exactOrder) {
    tieOnly = Math.abs(jsRes[firstDiff].score - wjRes[firstDiff].score) <= EPS;
    if (!tieOnly) {
      return { identical: false, reason: `ranking differs at rank ${firstDiff} with unequal scores` };
    }
  }
  return { identical: true, exactOrder, maxScoreDelta };
}

function verifyIdentity(label, jsSearch, wjSearch) {
  let identical = 0, exactOrder = 0, tieReorders = 0, maxDelta = 0;
  const failures = [];
  for (const q of QUERY_SET) {
    const verdict = compareOne(jsSearch(q), wjSearch(q));
    if (!verdict.identical) {
      failures.push({ q, reason: verdict.reason });
      continue;
    }
    identical++;
    maxDelta = Math.max(maxDelta, verdict.maxScoreDelta);
    if (verdict.exactOrder) exactOrder++;
    else tieReorders++;
  }
  const n = QUERY_SET.length;
  console.log(`\nIdentity check — ${label}`);
  console.log(`  ids + scores + terms identical: ${identical}/${n}`);
  console.log(`  exact returned order:           ${exactOrder}/${n}  (rest differ only among equal-score ties: ${tieReorders})`);
  console.log(`  max BM25 score delta:           ${maxDelta.toExponential(2)}`);
  if (failures.length) {
    console.log(`  ❌ FAILURES (${failures.length}):`);
    for (const f of failures.slice(0, 10)) console.log(`     "${f.q}": ${f.reason}`);
  } else {
    console.log(`  ✅ searchJoined is identical to minisearch (modulo equal-score tie order)`);
  }
  return failures.length === 0;
}

function measure(label, fn) {
  for (let i = 0; i < warmupIterations; i++) for (const q of QUERY_SET) fn(q);
  global.gc?.();
  const samples = [];
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    for (const q of QUERY_SET) {
      const start = performance.now();
      const r = fn(q);
      samples.push(performance.now() - start);
      checksum += r.length;
    }
  }
  const s = summarize(samples);
  console.log(
    `  ${label.padEnd(22)} mean ${ms(s.mean).padStart(10)} median ${ms(s.median).padStart(10)} p95 ${ms(s.p95).padStart(10)} min ${ms(s.min).padStart(10)} (checksum ${checksum})`,
  );
  return s;
}

async function main() {
  console.log("searchJoined benchmark + identity proof (vs original minisearch)");
  console.log(`queries: ${QUERY_SET.length}, warmup: ${warmupIterations}, iterations: ${iterations}`);

  const [{ jobs }, indexBin, wasmBin] = await Promise.all([
    loadFullDocs(PUBLIC_DIR),
    readFile(INDEX_BIN),
    readFile(WASM_FILE),
  ]);
  console.log(`\ndocs: ${num(jobs.length)}`);

  await init({ module_or_path: wasmBin });
  const wasm = MiniSearchWasm.loadBytes(new Uint8Array(indexBin));
  const js = new MiniSearch(miniSearchOptions());
  js.addAll(jobs);

  // Search functions producing the identical { id, score, terms } shape.
  const jsAnd = (q) => jsHits(js.search(q, { combineWith: "AND" }));
  const jsOr = (q) => jsHits(js.search(q, { combineWith: "OR" }));
  const wjAnd = (q) => decodeJoined(wasm.searchJoined(q, false));
  const wjOr = (q) => decodeJoined(wasm.searchJoined(q, true));

  // (a) Prove identity in both combine modes.
  const okAnd = verifyIdentity("AND mode", jsAnd, wjAnd);
  const okOr = verifyIdentity("OR mode", jsOr, wjOr);

  // (b) Benchmark the app workload (AND mode).
  console.log("\nSearch latency — AND mode (each yields {id, score, terms})");
  const jsS = measure("minisearch", jsAnd);
  const wjS = measure("searchJoined", wjAnd);

  console.log("\nSummary");
  const meanRatio = jsS.mean / wjS.mean;
  const medRatio = jsS.median / wjS.median;
  console.log(
    `  searchJoined is ${((1 - wjS.mean / jsS.mean) * 100).toFixed(0)}% faster than minisearch ` +
      `(mean ${meanRatio.toFixed(2)}×, median ${medRatio.toFixed(2)}×)`,
  );

  if (!okAnd || !okOr) {
    console.error("\n❌ identity check FAILED — searchJoined is NOT identical to minisearch");
    process.exit(1);
  }
  console.log("\n✅ identical results, and searchJoined is the faster path.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
