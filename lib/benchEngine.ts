// Benchmark engine: loads BOTH search libraries on the main thread and runs the
// exact same query pipeline through each, so the /benchmark page can time them
// head-to-head on an identical workload.
//
//   - minisearch-wasm  — the prebuilt Rust/Wasm snapshot (loadBytes), the engine
//     the production app ships (see lib/search.worker.ts).
//   - minisearch       — the original pure-JS library, indexed in-browser via
//     addAll from the same jobs.json (so both index an identical document set).
//
// The advanced query parsing, field clauses, OR mode, phrase handling, filters
// and sorting are identical for both — only the free-text backend differs. That
// pipeline is copied from lib/search.worker.ts so the comparison reflects the
// real app's search path; the only swapped piece is `runFreeText`.

import init, { MiniSearchWasm } from "minisearch-wasm";
import MiniSearch, { type Options } from "minisearch";
import { tokenize, processTerm, miniSearchOptions } from "./searchConfig.mjs";
import type { Job, Hit, SortMode, Filters, SearchOutcome } from "./types";

/** Free-text backend: query string + OR-mode flag -> id => {score, terms}. */
export type RunFreeText = (
  query: string,
  orMode: boolean,
) => Map<string, { score: number; terms: string[] }>;

// Shape returned by MiniSearchWasm.searchJoined.
interface JoinedResults {
  count: number;
  ids: string;
  scores: Float64Array;
  terms: string;
}

// --- query pipeline (copied from lib/search.worker.ts) ---------------------
function passesFilters(job: Job, filters: Filters): boolean {
  if (filters.company && job.company !== filters.company) return false;
  if (filters.city) {
    const cities = job.location ? job.location.split(/;\s*/).map((s) => s.trim()) : [];
    if (!cities.includes(filters.city)) return false;
  }
  if (filters.postedAfter) {
    if (!job.datePosted || job.datePosted < filters.postedAfter) return false;
  }
  return true;
}

function byDateDesc(a: Job, b: Job): number {
  return (b.datePosted || "").localeCompare(a.datePosted || "");
}

function searchableText(j: Job): string {
  return `${j.title} ${j.company} ${j.location} ${j.org} ${j.description}`.toLowerCase();
}

const FIELD_ALIASES: Record<string, Array<keyof Job>> = {
  title: ["title"],
  company: ["company", "org"],
  org: ["org"],
  location: ["location"],
  loc: ["location"],
  type: ["employmentType"],
  desc: ["description"],
  description: ["description"],
};
const ALL_TEXT_FIELDS: Array<keyof Job> = [
  "title",
  "company",
  "org",
  "location",
  "description",
];

interface Clause {
  neg: boolean;
  fields?: Array<keyof Job>;
  value: string;
  phrase: boolean;
}

function scanTokens(input: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let inQuote = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
    } else if (ch === " " && !inQuote) {
      if (buf) tokens.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function parseAdvanced(input: string): { clauses: Clause[]; orMode: boolean } {
  const clauses: Clause[] = [];
  let orMode = false;
  let pendingNeg = false;

  for (const raw of scanTokens(input)) {
    if (raw === "OR") {
      orMode = true;
      continue;
    }
    if (raw === "NOT") {
      pendingNeg = true;
      continue;
    }
    let tok = raw;
    let neg = pendingNeg;
    pendingNeg = false;
    if (tok.startsWith("-") && tok.length > 1) {
      neg = true;
      tok = tok.slice(1);
    }

    let fields: Array<keyof Job> | undefined;
    const colon = tok.indexOf(":");
    if (colon > 0) {
      const name = tok.slice(0, colon).toLowerCase();
      if (FIELD_ALIASES[name]) {
        fields = FIELD_ALIASES[name];
        tok = tok.slice(colon + 1);
      }
    }

    const phrase = tok.startsWith('"') && tok.endsWith('"');
    const value = (phrase ? tok.slice(1, -1) : tok).trim();
    if (!value) continue;
    clauses.push({ neg, fields, value, phrase });
  }
  return { clauses, orMode };
}

/**
 * Whether a query actually exercises the full-text engine. An empty query — or
 * one with only field-scoped/negated clauses — bypasses it (the pipeline just
 * filters/sorts documents), so a speed comparison wouldn't reflect the engines.
 */
export function hasFreeTextTerm(query: string): boolean {
  const { clauses } = parseAdvanced(query.trim());
  return clauses.some((c) => !c.neg && !c.fields);
}

function clauseMatches(job: Job, c: Clause): boolean {
  const fields = c.fields ?? ALL_TEXT_FIELDS;
  const val = c.value.toLowerCase();
  if (c.phrase) {
    return fields.some((f) => String(job[f] ?? "").toLowerCase().includes(val));
  }
  const valTok = processTerm(val) ?? val;
  return fields.some((f) =>
    tokenize(String(job[f] ?? "")).some((t) =>
      (processTerm(t) ?? "").startsWith(valTok),
    ),
  );
}

/**
 * Build a search function bound to a document set and a free-text backend. The
 * returned function runs the whole pipeline and reports its own elapsed ms.
 */
export function createRunner(
  jobs: Job[],
  byId: Map<string, Job>,
  runFreeText: RunFreeText,
): (query: string, sort: SortMode, filters: Filters) => SearchOutcome {
  return function search(query, sort, filters) {
    const start = performance.now();
    const { clauses, orMode } = parseAdvanced(query.trim());

    let hits: Hit[];

    if (clauses.length === 0) {
      hits = jobs
        .filter((j) => passesFilters(j, filters))
        .sort(byDateDesc)
        .map((j) => ({ ...j, score: 0, terms: [], matched: [] }));
    } else {
      const positives = clauses.filter((c) => !c.neg);
      const negatives = clauses.filter((c) => c.neg);
      const freeText = positives.filter((c) => !c.fields);
      const fieldPos = positives.filter((c) => c.fields);
      const freeTextPhrases = freeText
        .filter((c) => c.phrase)
        .map((c) => c.value.toLowerCase());

      const clauseTokenSets = freeText.map((c) => ({
        label: c.value,
        toks: tokenize(c.value)
          .map((t) => processTerm(t))
          .filter((t): t is string => Boolean(t)),
      }));

      // Free-text matching runs in the chosen engine; collect into a per-id map
      // so it combines with field-scoped clauses under either AND or OR.
      let textHits = new Map<string, { score: number; terms: string[] }>();
      if (freeText.length) {
        const q = freeText.map((c) => c.value).join(" ");
        textHits = runFreeText(q, orMode);
      }

      let universe: Job[];
      if (orMode && fieldPos.length > 0) {
        universe = jobs;
      } else if (freeText.length) {
        universe = [];
        for (const id of textHits.keys()) {
          const job = byId.get(id);
          if (job) universe.push(job);
        }
      } else {
        universe = jobs;
      }

      const hlTerms = positives.flatMap((c) =>
        c.phrase ? [c.value] : tokenize(c.value),
      );

      hits = [];
      for (const job of universe) {
        if (!passesFilters(job, filters)) continue;

        const th = textHits.get(job.id);
        const inText = th !== undefined;

        if (!orMode && freeTextPhrases.length) {
          const text = searchableText(job);
          if (!freeTextPhrases.every((p) => text.includes(p))) continue;
        }

        const qualifies = orMode
          ? (freeText.length > 0 && inText) ||
            fieldPos.some((c) => clauseMatches(job, c))
          : (freeText.length === 0 || inText) &&
            fieldPos.every((c) => clauseMatches(job, c));
        if (!qualifies) continue;
        if (negatives.some((c) => clauseMatches(job, c))) continue;

        const terms = th ? th.terms : [];
        const ts = new Set(terms);
        const matched: string[] = [];
        for (const { label, toks } of clauseTokenSets) {
          if (toks.length && toks.every((t) => ts.has(t))) matched.push(label);
        }
        for (const c of fieldPos) {
          if (clauseMatches(job, c)) matched.push(c.value);
        }
        hits.push({
          ...job,
          score: th ? th.score : 0,
          terms: hlTerms,
          matched: Array.from(new Set(matched)),
        });
      }

      if (sort === "matches") {
        hits.sort((a, b) => b.matched.length - a.matched.length || byDateDesc(a, b));
      } else if (sort === "date") {
        hits.sort(byDateDesc);
      } else if (freeText.length) {
        hits.sort((a, b) => b.score - a.score || byDateDesc(a, b));
      } else {
        hits.sort(byDateDesc);
      }
    }

    return { hits, total: hits.length, ms: performance.now() - start };
  };
}

// --- backends --------------------------------------------------------------
function wasmBackend(mini: MiniSearchWasm): RunFreeText {
  return (query, orMode) => {
    const out = new Map<string, { score: number; terms: string[] }>();
    const r = mini.searchJoined(query, orMode) as JoinedResults;
    if (r.count) {
      const ids = r.ids.split("\n");
      const termRows = r.terms.split("\n");
      for (let i = 0; i < r.count; i++) {
        out.set(ids[i], {
          score: r.scores[i],
          terms: termRows[i] ? termRows[i].split(" ") : [],
        });
      }
    }
    return out;
  };
}

function jsBackend(mini: MiniSearch<Job>): RunFreeText {
  return (query, orMode) => {
    const out = new Map<string, { score: number; terms: string[] }>();
    // combineWith overrides the instance default (AND); other search options
    // (boost/prefix/fuzzy) are merged in from the constructor config.
    const res = mini.search(query, { combineWith: orMode ? "OR" : "AND" });
    for (const r of res) out.set(String(r.id), { score: r.score, terms: r.terms });
    return out;
  };
}

// --- loading ---------------------------------------------------------------
export interface Engine {
  name: string;
  /** Short note on how this engine's index was obtained. */
  detail: string;
  run: (query: string, sort: SortMode, filters: Filters) => SearchOutcome;
  /** ms to load/build the index. */
  loadMs: number;
}

export interface LoadedEngines {
  jobs: Job[];
  /** From search-meta.json — companies/cities for the shared filter UI. */
  stats: {
    total: number;
    companies: string[];
    cities: string[];
    topCityCount: number;
    version: string;
  };
  wasm: Engine;
  js: Engine;
}

/**
 * Fetch the shared docs + prebuilt wasm snapshot, instantiate both engines, and
 * return runners for each. The JS index is built in-browser (addAll) from the
 * same jobs.json that the wasm snapshot was built from, guaranteeing both index
 * an identical document set.
 */
export async function loadEngines(): Promise<LoadedEngines> {
  const metaRes = await fetch("/search-meta.json", { cache: "no-cache" });
  if (!metaRes.ok) throw new Error(`Failed to load index metadata: ${metaRes.status}`);
  const stats = (await metaRes.json()) as LoadedEngines["stats"];
  const v = encodeURIComponent(stats.version);

  const [docsRes, idxRes] = await Promise.all([
    fetch(`/dl/jobs.json?v=${v}`),
    fetch(`/dl/search-index.bin?v=${v}`),
  ]);
  if (!docsRes.ok) throw new Error(`load failed: docs ${docsRes.status}`);
  if (!idxRes.ok) throw new Error(`load failed: index ${idxRes.status}`);

  const jobs = JSON.parse(await docsRes.text()) as Job[];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const indexBytes = new Uint8Array(await idxRes.arrayBuffer());

  // minisearch-wasm: restore the prebuilt snapshot.
  await init();
  const tWasm = performance.now();
  const wasm = MiniSearchWasm.loadBytes(indexBytes);
  const wasmLoadMs = performance.now() - tWasm;

  // minisearch (JS): index the same docs from scratch in the browser.
  const tJs = performance.now();
  const js = new MiniSearch<Job>(miniSearchOptions() as unknown as Options<Job>);
  js.addAll(jobs);
  const jsLoadMs = performance.now() - tJs;

  return {
    jobs,
    stats,
    wasm: {
      name: "minisearch-wasm",
      detail: "prebuilt Rust/Wasm snapshot · loadBytes",
      run: createRunner(jobs, byId, wasmBackend(wasm)),
      loadMs: wasmLoadMs,
    },
    js: {
      name: "minisearch",
      detail: "pure-JS · addAll in browser",
      run: createRunner(jobs, byId, jsBackend(js)),
      loadMs: jsLoadMs,
    },
  };
}

// --- timing ----------------------------------------------------------------
export interface Timing {
  median: number;
  mean: number;
  min: number;
  p95: number;
  iters: number;
}

export interface Measured {
  outcome: SearchOutcome;
  timing: Timing;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

/**
 * Run `engine.run` repeatedly to get a stable timing for the given query, and
 * return the last result for rendering. Warmup runs are excluded from the stats.
 */
export function measure(
  engine: Engine,
  query: string,
  sort: SortMode,
  filters: Filters,
  iters: number,
  warmup = 3,
): Measured {
  for (let i = 0; i < warmup; i++) engine.run(query, sort, filters);

  const samples: number[] = [];
  let outcome = engine.run(query, sort, filters);
  samples.push(outcome.ms);
  for (let i = 1; i < iters; i++) {
    outcome = engine.run(query, sort, filters);
    samples.push(outcome.ms);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    outcome,
    timing: {
      median: percentile(sorted, 0.5),
      mean,
      min: sorted[0],
      p95: percentile(sorted, 0.95),
      iters: samples.length,
    },
  };
}
