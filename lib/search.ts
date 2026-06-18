// Fully client-side search engine. Loads the locally-built index (public/jobs.json),
// builds an in-memory MiniSearch index in the browser, and answers queries with no
// network calls beyond the one static file fetch. No web API of any kind.

import MiniSearch, { type SearchResult } from "minisearch";

export interface Job {
  id: string;
  title: string;
  company: string;
  org: string;
  location: string;
  employmentType: string;
  datePosted: string;
  validThrough: string;
  url: string;
  description: string;
}

export interface Hit extends Job {
  score: number;
  /** Lowercased terms that matched, used for highlighting. */
  terms: string[];
  /** Distinct query terms this job matched, in original casing — shown as tags. */
  matched: string[];
}

export type SortMode = "relevance" | "date" | "matches";

export interface Filters {
  company?: string;
  employmentType?: string;
  /** ISO date (YYYY-MM-DD); keep only postings on/after this date. */
  postedAfter?: string;
}

// Default MiniSearch tokenization strips "#", "+", "." etc., which collapses
// "C#" → "c", "C++" → "c", ".NET" → "net" and makes those terms unsearchable.
// Treat unicode letters/digits plus those symbols as token characters, splitting
// only on everything else. The same config is used for indexing and querying.
const TOKEN_SEPARATOR = /[^\p{L}\p{N}+#.]+/u;

function tokenize(text: string): string[] {
  return text.split(TOKEN_SEPARATOR).filter(Boolean);
}

function processTerm(term: string): string | null {
  // Lowercase and strip trailing dots (sentence punctuation, e.g. "Python."),
  // but KEEP leading dots so ".NET" / ".js" stay distinct from "net" / "js",
  // and keep symbol-bearing terms like "c#" and "c++" intact.
  const t = term.toLowerCase().replace(/\.+$/, "");
  return t || null;
}

let jobs: Job[] = [];
let byId: Map<string, Job> = new Map();
let mini: MiniSearch<Job> | null = null;
let loadPromise: Promise<void> | null = null;

export interface IndexStats {
  total: number;
  companies: string[];
  employmentTypes: string[];
}

let stats: IndexStats = { total: 0, companies: [], employmentTypes: [] };

export function getStats(): IndexStats {
  return stats;
}

/** Load jobs.json and build the index once. Safe to call repeatedly. */
export function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const res = await fetch("/jobs.json");
    if (!res.ok) throw new Error(`Failed to load index: ${res.status}`);
    jobs = (await res.json()) as Job[];
    byId = new Map(jobs.map((j) => [j.id, j]));

    mini = new MiniSearch<Job>({
      idField: "id",
      fields: ["title", "description", "company", "location", "org"],
      tokenize,
      processTerm,
      // We resolve full docs from byId, so nothing needs to be stored in the index.
      searchOptions: {
        boost: { title: 4, company: 2, location: 1.5 },
        prefix: true,
        fuzzy: 0.2,
        combineWith: "AND",
      },
    });
    // Async, chunked indexing yields to the event loop so the page stays
    // responsive while building the index for the full corpus (~17k+ docs).
    await mini.addAllAsync(jobs, { chunkSize: 1000 });

    const companies = Array.from(new Set(jobs.map((j) => j.company)))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const employmentTypes = Array.from(
      new Set(jobs.map((j) => j.employmentType)),
    )
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    stats = { total: jobs.length, companies, employmentTypes };
  })();
  return loadPromise;
}

function passesFilters(job: Job, filters: Filters): boolean {
  if (filters.company && job.company !== filters.company) return false;
  if (filters.employmentType && job.employmentType !== filters.employmentType)
    return false;
  if (filters.postedAfter) {
    // ISO dates compare lexicographically; undated postings are dropped when a
    // recency window is active since we can't confirm they're recent.
    if (!job.datePosted || job.datePosted < filters.postedAfter) return false;
  }
  return true;
}

function byDateDesc(a: Job, b: Job): number {
  return (b.datePosted || "").localeCompare(a.datePosted || "");
}

export interface SearchOutcome {
  hits: Hit[];
  total: number;
  ms: number;
}

function searchableText(j: Job): string {
  return `${j.title} ${j.company} ${j.location} ${j.org} ${j.description}`.toLowerCase();
}

// --- query language --------------------------------------------------------
// Supported syntax:
//   foo bar          → AND (all terms)
//   foo OR bar        → OR (any term)
//   "foo bar"         → exact phrase
//   -foo  /  NOT foo  → exclude
//   field:foo         → scope to a field (title|company|location|type|desc)
//   field:"foo bar"   → scoped exact phrase   (also -company:Roche, etc.)

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
  fieldName?: string;
  value: string;
  phrase: boolean;
}

/** Split a query into tokens, keeping quoted runs (and their field:/- prefixes) whole. */
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
    let fieldName: string | undefined;
    const colon = tok.indexOf(":");
    if (colon > 0) {
      const name = tok.slice(0, colon).toLowerCase();
      if (FIELD_ALIASES[name]) {
        fields = FIELD_ALIASES[name];
        fieldName = name;
        tok = tok.slice(colon + 1);
      }
    }

    const phrase = tok.startsWith('"') && tok.endsWith('"');
    const value = (phrase ? tok.slice(1, -1) : tok).trim();
    if (!value) continue;
    clauses.push({ neg, fields, fieldName, value, phrase });
  }
  return { clauses, orMode };
}

/** Does a job satisfy a single clause (ignoring its negation)? */
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
 * Run a query against the in-memory index. Supports AND (default), OR, quoted
 * exact phrases, `-`/`NOT` exclusion, and `field:term` scoping. An empty query
 * browses the whole corpus (filtered + sorted), like hnsearch.
 */
export function search(
  query: string,
  { sort, filters }: { sort: SortMode; filters: Filters },
): SearchOutcome {
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
    // Free-text quoted phrases are enforced for adjacency in AND mode.
    const freeTextPhrases = freeText
      .filter((c) => c.phrase)
      .map((c) => c.value.toLowerCase());

    // One matched tag per positive clause (not per token), so a quoted phrase
    // like "Claude Code" counts as a single match, not one per word.
    const clauseTokenSets = freeText.map((c) => ({
      label: c.value,
      toks: tokenize(c.value)
        .map((t) => processTerm(t))
        .filter((t): t is string => Boolean(t)),
    }));

    // Candidate retrieval: MiniSearch ranks free-text positives; if there are
    // none (pure field/exclusion query) we scan the corpus and post-filter.
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

    // Terms used for highlighting: every positive value / token.
    const hlTerms = positives.flatMap((c) =>
      c.phrase ? [c.value] : tokenize(c.value),
    );

    hits = [];
    for (const { job, score, terms } of candidates) {
      if (!passesFilters(job, filters)) continue;
      // AND mode: each free-text phrase must appear verbatim (adjacency).
      if (!orMode && freeTextPhrases.length) {
        const text = searchableText(job);
        if (!freeTextPhrases.every((p) => text.includes(p))) continue;
      }
      // Field-scoped positives are always required (filters).
      if (!fieldPos.every((c) => clauseMatches(job, c))) continue;
      // Exclusions remove any job matching a negated clause.
      if (negatives.some((c) => clauseMatches(job, c))) continue;

      // A free-text clause matched this job if all its tokens are among the
      // MiniSearch-matched terms; field-scoped positives already passed above.
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
      // No ranking signal without free-text terms → newest first.
      hits.sort(byDateDesc);
    }
    // otherwise keep MiniSearch's relevance order
  }

  return { hits, total: hits.length, ms: performance.now() - start };
}
