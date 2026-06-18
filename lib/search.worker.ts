// Search runs entirely in this Web Worker so the main thread never blocks:
// it fetches the prebuilt index + docs, deserializes via MiniSearch.loadJSON
// (far cheaper than re-indexing), and answers queries. Versioned URLs let the
// browser cache serve repeat loads with no re-download.

import MiniSearch, { type SearchResult } from "minisearch";
import { miniSearchOptions, tokenize, processTerm } from "./searchConfig.mjs";
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
let mini: MiniSearch<Job> | null = null;

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
  const [docsRes, idxRes] = await Promise.all([
    fetch(`/dl/jobs.json?v=${v}`),
    fetch(`/dl/search-index.json?v=${v}`),
  ]);
  if (!docsRes.ok || !idxRes.ok) {
    throw new Error(`load failed: docs ${docsRes.status}, index ${idxRes.status}`);
  }
  jobs = (await docsRes.json()) as Job[];
  byId = new Map(jobs.map((j) => [j.id, j]));
  mini = MiniSearch.loadJSON<Job>(await idxRes.text(), miniSearchOptions());
  resolveLoaded();
  post({ type: "ready" });
}

// --- query engine (pure; mirrors the previous in-page implementation) ------
function passesFilters(job: Job, filters: Filters): boolean {
  if (filters.company && job.company !== filters.company) return false;
  if (filters.employmentType && job.employmentType !== filters.employmentType)
    return false;
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

    let candidates: Array<{ job: Job; score: number; terms: string[] }>;
    if (freeText.length && mini) {
      const msQuery = freeText.map((c) => c.value).join(" ");
      const results: SearchResult[] = mini.search(
        msQuery,
        orMode ? { combineWith: "OR" } : undefined,
      );
      candidates = [];
      for (const r of results) {
        const job = byId.get(r.id as string);
        if (job) candidates.push({ job, score: r.score, terms: r.terms });
      }
    } else {
      candidates = jobs.map((job) => ({ job, score: 0, terms: [] }));
    }

    const hlTerms = positives.flatMap((c) =>
      c.phrase ? [c.value] : tokenize(c.value),
    );

    hits = [];
    for (const { job, score, terms } of candidates) {
      if (!passesFilters(job, filters)) continue;
      if (!orMode && freeTextPhrases.length) {
        const text = searchableText(job);
        if (!freeTextPhrases.every((p) => text.includes(p))) continue;
      }
      if (!fieldPos.every((c) => clauseMatches(job, c))) continue;
      if (negatives.some((c) => clauseMatches(job, c))) continue;

      const ts = new Set(terms);
      const matched: string[] = [];
      for (const { label, toks } of clauseTokenSets) {
        if (toks.length && toks.every((t) => ts.has(t))) matched.push(label);
      }
      for (const c of fieldPos) matched.push(c.value);
      hits.push({
        ...job,
        score,
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
    } else if (!freeText.length) {
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
