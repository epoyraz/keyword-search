// Search runs entirely in this Web Worker so the main thread never blocks. It
// fetches the prebuilt Rust/Wasm binary index + docs, instantiates the wasm
// engine, loads the snapshot via MiniSearchWasm.loadBytes (far cheaper than
// re-indexing — and than JSON), and answers queries with searchJoined, which
// runs the whole search in wasm and returns a compact columnar result.
// Versioned URLs let the browser cache serve repeat loads with no re-download.

import init, { MiniSearchWasm } from "minisearch-wasm";
import { tokenize, processTerm, SEARCH_FIELDS, SEARCH_OPTIONS } from "./searchConfig.mjs";
import type {
  Job,
  Hit,
  SortMode,
  Filters,
  SearchOutcome,
  WorkerRequest,
  WorkerResponse,
} from "./types";

let jobs: Job[] = [];
let byId = new Map<string, Job>();
let mini: MiniSearchWasm | null = null;

// Shape returned by MiniSearchWasm.searchJoined: the whole result set as a
// Float64Array of scores plus newline-joined id/term strings (split natively).
interface JoinedResults {
  count: number;
  ids: string;
  scores: Float64Array;
  terms: string;
}

let resolveLoaded!: () => void;
const loaded = new Promise<void>((r) => (resolveLoaded = r));

// Minimal worker-scope typing to avoid pulling in the webworker lib (which
// clashes with the dom lib's `self`).
type WorkerCtx = {
  postMessage(m: WorkerResponse): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};
const ctx = self as unknown as WorkerCtx;

function post(msg: WorkerResponse) {
  ctx.postMessage(msg);
}

async function load(version: string) {
  const v = encodeURIComponent(version);
  // Data comes from the server's /dl provider (derived from GCS job_details.sqlite).
  const docsRes = await fetch(`/dl/jobs.json?v=${v}`);
  if (!docsRes.ok) {
    throw new Error(`load failed: docs ${docsRes.status}`);
  }
  const text = await docsRes.text();
  jobs = JSON.parse(text) as Job[];
  byId = new Map(jobs.map((j) => [j.id, j]));
  // Instantiate the wasm engine (minisearch-wasm web target), then build the
  // index in-worker from the doc JSON (no prebuilt .bin to ship/serve).
  await init();
  mini = new MiniSearchWasm({
    idField: "id",
    fields: SEARCH_FIELDS,
    tokenizer: "jobboard",
    searchOptions: SEARCH_OPTIONS,
  });
  mini.addAllJSON(text);
  resolveLoaded();
  post({ type: "ready" });
}

// --- query engine (pure; mirrors the previous in-page implementation) ------
function passesFilters(job: Job, filters: Filters): boolean {
  if (filters.company && job.company !== filters.company) return false;
  if (filters.city) {
    // A job's location may list several cities joined by "; ".
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

function search(query: string, { sort, filters }: { sort: SortMode; filters: Filters }): SearchOutcome {
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

    // Free-text matching runs in wasm; collect it into a per-id map so it can be
    // combined with field-scoped clauses under either AND or OR.
    const wasmHits = new Map<string, { score: number; terms: string[] }>();
    if (freeText.length && mini) {
      const msQuery = freeText.map((c) => c.value).join(" ");
      // Everything (tokenize, prefix/fuzzy, BM25, ranking) runs in wasm; the
      // result set comes back columnar and is decoded here.
      const r = mini.searchJoined(msQuery, orMode) as JoinedResults;
      if (r.count) {
        const ids = r.ids.split("\n");
        const termRows = r.terms.split("\n");
        for (let i = 0; i < r.count; i++) {
          wasmHits.set(ids[i], {
            score: r.scores[i],
            terms: termRows[i] ? termRows[i].split(" ") : [],
          });
        }
      }
    }

    // Candidate universe. In OR mode a job can qualify via a field clause alone
    // (so it may be outside the free-text hit set) — scan every job. Otherwise,
    // free text (when present) bounds the set to its wasm hits.
    let universe: Job[];
    if (orMode && fieldPos.length > 0) {
      universe = jobs;
    } else if (freeText.length) {
      universe = [];
      for (const id of wasmHits.keys()) {
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

      const wh = wasmHits.get(job.id);
      const inWasm = wh !== undefined;

      // Phrase adjacency for free text is only enforced in AND mode (wasm
      // matches phrase tokens but not their adjacency).
      if (!orMode && freeTextPhrases.length) {
        const text = searchableText(job);
        if (!freeTextPhrases.every((p) => text.includes(p))) continue;
      }

      // Combine free-text and field-scoped clauses honoring AND vs OR.
      const qualifies = orMode
        ? (freeText.length > 0 && inWasm) ||
          fieldPos.some((c) => clauseMatches(job, c))
        : (freeText.length === 0 || inWasm) &&
          fieldPos.every((c) => clauseMatches(job, c));
      if (!qualifies) continue;
      if (negatives.some((c) => clauseMatches(job, c))) continue;

      const terms = wh ? wh.terms : [];
      const ts = new Set(terms);
      const matched: string[] = [];
      for (const { label, toks } of clauseTokenSets) {
        if (toks.length && toks.every((t) => ts.has(t))) matched.push(label);
      }
      // Only tag a field clause that actually matched (matters in OR mode).
      for (const c of fieldPos) {
        if (clauseMatches(job, c)) matched.push(c.value);
      }
      hits.push({
        ...job,
        score: wh ? wh.score : 0,
        terms: hlTerms,
        matched: Array.from(new Set(matched)),
      });
    }

    if (sort === "matches") {
      hits.sort(
        (a, b) => b.matched.length - a.matched.length || byDateDesc(a, b),
      );
    } else if (sort === "date") {
      hits.sort(byDateDesc);
    } else if (freeText.length) {
      // relevance: BM25 score from wasm, newest as tie-break
      hits.sort((a, b) => b.score - a.score || byDateDesc(a, b));
    } else {
      hits.sort(byDateDesc);
    }
  }

  return { hits, total: hits.length, ms: performance.now() - start };
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "load") {
    try {
      await load(msg.version);
    } catch (err) {
      post({ type: "error", message: String(err) });
    }
  } else if (msg.type === "search") {
    await loaded;
    post({ type: "result", reqId: msg.reqId, outcome: search(msg.args.query, msg.args) });
  }
};
