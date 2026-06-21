// Search runs entirely in this Web Worker so the main thread never blocks. It
// fetches the prebuilt Rust/Wasm binary index + docs, instantiates the wasm
// engine, loads the snapshot via MiniSearchWasm.loadBytes (far cheaper than
// re-indexing — and than JSON), and answers queries with searchJoined, which
// runs the whole search in wasm and returns a compact columnar result.
// Versioned URLs let the browser cache serve repeat loads with no re-download.

import init, { MiniSearchWasm } from "minisearch-wasm";
import { tokenize, processTerm } from "./searchConfig.mjs";
import { isShortAlphaTerm } from "./termMatch.mjs";
import { fetchDescriptions } from "./descriptions";
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
let version = "";

// Descriptions are no longer in jobs.json — fetched on demand (and cached for
// the session) only for the advanced operators that scan raw text. Plain term
// queries never touch this. Absent id ⇒ known-empty description.
const descCache = new Map<string, string>();

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

async function load(v0: string) {
  version = v0;
  const v = encodeURIComponent(version);
  // Docs (for rendering hit details via byId) and the prebuilt wasm index
  // snapshot are fetched in parallel from the server's /dl provider. The index
  // is built once at image-build time (npm run index), so the worker restores
  // it via loadBytes instead of re-indexing ~22k docs in every browser
  // (~6.5s/load saved). The search config is baked into the snapshot.
  const [docsRes, idxRes] = await Promise.all([
    fetch(`/dl/jobs.json?v=${v}`),
    fetch(`/dl/search-index.bin?v=${v}`),
  ]);
  if (!docsRes.ok) {
    throw new Error(`load failed: docs ${docsRes.status}`);
  }
  if (!idxRes.ok) {
    throw new Error(`load failed: index ${idxRes.status}`);
  }
  const text = await docsRes.text();
  jobs = JSON.parse(text) as Job[];
  byId = new Map(jobs.map((j) => [j.id, j]));
  const indexBytes = new Uint8Array(await idxRes.arrayBuffer());
  await init();
  mini = MiniSearchWasm.loadBytes(indexBytes);
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

// Raw description for a job — from the lazy cache, not the (stripped) job
// object. Only the advanced-query path reads this, and only after fetching.
function descOf(job: Job): string {
  return descCache.get(job.id) ?? "";
}

// Field text for clause matching. Every field but `description` lives on the
// metadata job object; `description` comes from the lazy cache.
function fieldValue(job: Job, f: keyof Job): string {
  return f === "description" ? descOf(job) : String(job[f] ?? "");
}

function searchableText(j: Job): string {
  return `${j.title} ${j.company} ${j.location} ${j.org} ${descOf(j)}`.toLowerCase();
}

// Fetch (and cache) descriptions for any of `ids` not seen yet. No-op when all
// are cached, so the common path that never needs descriptions stays sync-fast.
async function ensureDescriptions(ids: string[]): Promise<void> {
  const missing = ids.filter((id) => !descCache.has(id));
  if (missing.length === 0) return;
  const map = await fetchDescriptions(missing, version);
  // Record every requested id (absent ⇒ "") so we never refetch a blank one.
  for (const id of missing) descCache.set(id, map[id] ?? "");
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

// Does this clause scan the (lazy) description field? Such clauses force a
// description fetch for the candidate set before the post-filter runs.
function clauseUsesDescription(c: Clause): boolean {
  return (c.fields ?? ALL_TEXT_FIELDS).includes("description");
}

function clauseMatches(job: Job, c: Clause): boolean {
  const fields = c.fields ?? ALL_TEXT_FIELDS;
  const val = c.value.toLowerCase();
  if (c.phrase) {
    return fields.some((f) => fieldValue(job, f).toLowerCase().includes(val));
  }
  const valTok = processTerm(val) ?? val;
  return fields.some((f) =>
    tokenize(fieldValue(job, f)).some((t) =>
      (processTerm(t) ?? "").startsWith(valTok),
    ),
  );
}

async function search(
  query: string,
  { sort, filters }: { sort: SortMode; filters: Filters },
): Promise<SearchOutcome> {
  const start = performance.now();
  const { clauses, orMode } = parseAdvanced(query.trim());

  let hits: Hit[];
  // Time spent awaiting on-demand description fetches is data-loading, not search
  // work — subtracted from the reported `ms` so it stays comparable to the
  // common (no-fetch) path.
  let fetchMs = 0;

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
    // Multiword skills arrive quoted (buildSkillQuery), so they parse as phrase
    // clauses; single-word skills are bare term clauses.
    const termClauses = freeText.filter((c) => !c.phrase);
    const phraseClauses = freeText.filter((c) => c.phrase);

    const termTokenSets = termClauses.map((c) => ({
      label: c.value,
      toks: tokenize(c.value)
        .map((t) => processTerm(t))
        .filter((t): t is string => Boolean(t)),
    }));

    // Short 1–2-letter tokens (C, R, Go) are split off from the wasm query.
    // `prefix:true` is baked into searchJoined, so leaving "C" in the query makes
    // it match every token starting with "c" (~14k jobs) — both wrong and, since
    // that prefix traversal dominates search time, slow. Normal tokens go to the
    // engine (full prefix+fuzzy preserved); each short token is resolved to its
    // exact whole-token doc set via the per-call options path. Net effect: correct
    // *and* faster (no flood to compute then discard).
    const freeToks = termTokenSets.flatMap((c) => c.toks);
    const shortQ = [...new Set(freeToks.filter(isShortAlphaTerm))];
    const normalQ = freeToks.filter((t) => !isShortAlphaTerm(t));

    // Free-text (normal, non-phrase) matching runs in wasm; collect it into a
    // per-id map so it can be combined with field-scoped clauses under AND or OR.
    const wasmHits = new Map<string, { score: number; terms: string[] }>();
    if (normalQ.length && mini) {
      // Everything (tokenize, prefix/fuzzy, BM25, ranking) runs in wasm; the
      // result set comes back columnar and is decoded here.
      const r = mini.searchJoined(normalQ.join(" "), orMode) as JoinedResults;
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

    // Exact, whole-token doc sets for the short tokens.
    const exactIds = new Map<string, Set<string>>();
    if (shortQ.length && mini) {
      for (const t of shortQ) {
        const res = mini.search(t, {
          prefix: false,
          fuzzy: false,
          combineWith: "OR",
        }) as Array<{ id: string }>;
        exactIds.set(t, new Set(res.map((r) => r.id)));
      }
    }
    const shortMatches = (jobId: string, t: string): boolean =>
      exactIds.get(t)?.has(jobId) ?? false;

    // Multiword skills must match as a unit. Their tokens are kept OUT of the wasm
    // query above (so "REST APIs" can't prefix-flood via "rest"→"Restaurant");
    // instead each phrase resolves to the jobs that contain ALL its tokens exactly.
    // (AND mode additionally confirms adjacency in the loop below.)
    const phraseHits = new Map<string, Set<string>>();
    if (phraseClauses.length && mini) {
      for (const c of phraseClauses) {
        const res = mini.search(c.value, {
          prefix: false,
          fuzzy: false,
          combineWith: "AND",
        }) as Array<{ id: string }>;
        phraseHits.set(c.value, new Set(res.map((r) => r.id)));
      }
    }
    const hasFree = freeText.length > 0;
    // Longer skills (≥3-char terms and multiword phrases) are the ones that can
    // include a job; lone 1–2 letter skills only refine/rank (see qualify below).
    const hasLong = normalQ.length > 0 || phraseClauses.length > 0;

    // Candidate universe. In OR mode a job can qualify via a field clause alone
    // (so it may be outside the free-text hit set) — scan every job. Otherwise,
    // free text (when present) bounds the set to its term-token hits ∪ the phrase
    // hits. Short-term hits join the candidate set only when there's no longer
    // skill to corroborate against (otherwise a lone "R"/"C" doesn't broaden).
    let universe: Job[];
    if (orMode && fieldPos.length > 0) {
      universe = jobs;
    } else if (hasFree) {
      const ids = new Set<string>(wasmHits.keys());
      for (const set of phraseHits.values()) for (const id of set) ids.add(id);
      if (!hasLong) {
        for (const set of exactIds.values()) for (const id of set) ids.add(id);
      }
      universe = [];
      for (const id of ids) {
        const job = byId.get(id);
        if (job) universe.push(job);
      }
    } else {
      universe = jobs;
    }

    const hlTerms = positives.flatMap((c) =>
      c.phrase ? [c.value] : tokenize(c.value),
    );

    // Filters are cheap and need no description, so apply them first to bound
    // the candidate set. Only then (and only if an operator scans raw text) do
    // we fetch descriptions — for exactly the candidates, batched and cached.
    // OR-mode phrases need no adjacency check, so they stay on the no-fetch path.
    const candidateJobs = universe.filter((j) => passesFilters(j, filters));
    const needsDesc =
      (!orMode && phraseClauses.length > 0) ||
      negatives.some(clauseUsesDescription) ||
      fieldPos.some(clauseUsesDescription);
    if (needsDesc) {
      const t = performance.now();
      await ensureDescriptions(candidateJobs.map((j) => j.id));
      fetchMs = performance.now() - t;
    }

    hits = [];
    for (const job of candidateJobs) {
      const wh = wasmHits.get(job.id);
      const inWasm = wh !== undefined; // matched ≥1 term token (OR) / all (AND)
      const ts = new Set(wh ? wh.terms : []);

      // A phrase matches when the job has all its tokens (phraseHits); AND mode
      // additionally requires them adjacent (substring), preserving quoted-phrase
      // semantics for advanced queries.
      const phraseOk = (value: string): boolean => {
        if (!phraseHits.get(value)?.has(job.id)) return false;
        return orMode || searchableText(job).includes(value.toLowerCase());
      };

      let freeQualifies: boolean;
      if (orMode) {
        // A longer skill matching (normal term via the engine, or a phrase) is
        // what includes a job. A lone 1–2 letter skill is too ambiguous to do so
        // by itself — "R"/"C" mostly hit a German gender suffix or French "c'est",
        // not the language — so it only broadens when there's no longer skill to
        // corroborate with (an all-short query still returns results).
        const corroborated =
          inWasm || phraseClauses.some((c) => phraseOk(c.value));
        freeQualifies =
          corroborated ||
          (!hasLong && shortQ.some((t) => shortMatches(job.id, t)));
      } else {
        // AND: every clause must match — all normal tokens (inWasm), every short
        // token exactly, and every phrase.
        const termOk =
          (normalQ.length === 0 || inWasm) &&
          shortQ.every((t) => shortMatches(job.id, t));
        freeQualifies = termOk && phraseClauses.every((c) => phraseOk(c.value));
      }

      // Combine free-text and field-scoped clauses honoring AND vs OR.
      const qualifies = orMode
        ? (hasFree && freeQualifies) || fieldPos.some((c) => clauseMatches(job, c))
        : (!hasFree || freeQualifies) && fieldPos.every((c) => clauseMatches(job, c));
      if (!qualifies) continue;
      if (negatives.some((c) => clauseMatches(job, c))) continue;

      // Label a clause when it matched — term tokens via the wasm/exact sets,
      // phrases as a unit.
      const matched: string[] = [];
      for (const { label, toks } of termTokenSets) {
        if (
          toks.length &&
          toks.every((t) => (isShortAlphaTerm(t) ? shortMatches(job.id, t) : ts.has(t)))
        )
          matched.push(label);
      }
      for (const c of phraseClauses) {
        if (phraseOk(c.value)) matched.push(c.value);
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

  return { hits, total: hits.length, ms: performance.now() - start - fetchMs };
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
    const outcome = await search(msg.args.query, msg.args);
    post({ type: "result", reqId: msg.reqId, outcome });
  }
};
