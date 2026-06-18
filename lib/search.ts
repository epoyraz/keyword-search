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
    mini.addAll(jobs);

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

/** Pull "quoted phrases" out of a query, leaving the loose words behind. */
function parseQuery(q: string): { phrases: string[]; loose: string } {
  const phrases: string[] = [];
  const loose = q
    .replace(/"([^"]*)"/g, (_, p: string) => {
      const t = p.trim();
      if (t) phrases.push(t);
      return " ";
    })
    .trim();
  return { phrases, loose };
}

function searchableText(j: Job): string {
  return `${j.title} ${j.company} ${j.location} ${j.description}`.toLowerCase();
}

/**
 * Run a query. Empty query returns the full corpus (filtered + sorted),
 * matching hnsearch's "browse everything when the box is empty" behaviour.
 *
 * Wrapping part of the query in double quotes makes it an exact-phrase match:
 * matching becomes strict (no prefix/fuzzy expansion) and every quoted phrase
 * must appear verbatim in the posting's text. e.g. `".Net"` excludes "Netz".
 */
export function search(
  query: string,
  { sort, filters }: { sort: SortMode; filters: Filters },
): SearchOutcome {
  const start = performance.now();
  const q = query.trim();
  let hits: Hit[];

  if (!q) {
    hits = jobs
      .filter((j) => passesFilters(j, filters))
      .sort(byDateDesc)
      .map((j) => ({ ...j, score: 0, terms: [], matched: [] }));
  } else {
    const { phrases, loose } = parseQuery(q);
    const exact = phrases.length > 0;

    // An uppercase "OR" token (outside quotes) switches to OR matching: any
    // term may match instead of all. Default stays AND. Strip the OR tokens.
    const orMode = /(?:^|\s)OR(?:\s|$)/.test(loose);
    const looseClean = orMode
      ? loose.replace(/(?:^|\s)OR(?=\s|$)/g, " ").replace(/\s+/g, " ").trim()
      : loose;

    const msQuery = [...phrases, looseClean].filter(Boolean).join(" ");

    // Build only the options we want to override; the rest (boost, and in
    // loose mode prefix/fuzzy) fall back to the constructor defaults.
    const opts: Record<string, unknown> = {};
    if (exact) {
      opts.prefix = false;
      opts.fuzzy = false;
    }
    if (orMode) opts.combineWith = "OR";

    const results: SearchResult[] = mini
      ? mini.search(msQuery, Object.keys(opts).length ? opts : undefined)
      : [];

    const lowerPhrases = phrases.map((p) => p.toLowerCase());
    // For exact queries, highlight whole phrases (as units) plus the loose
    // words — never the phrases' individual tokens, which would over-highlight.
    const looseTerms = looseClean ? tokenize(looseClean) : [];

    // Map each processed token back to the original-cased word the user typed,
    // so matched-term tags read "Python" / ".NET" rather than "python" / ".net".
    const displayMap = new Map<string, string>();
    for (const word of looseClean.split(/\s+/)) {
      if (!word) continue;
      for (const tok of tokenize(word)) {
        const key = processTerm(tok);
        if (key && !displayMap.has(key)) displayMap.set(key, word);
      }
    }

    hits = [];
    for (const r of results) {
      const job = byId.get(r.id as string);
      if (!job || !passesFilters(job, filters)) continue;
      // In AND mode, enforce verbatim presence of every quoted phrase (handles
      // adjacency for multi-word phrases and exactness for tokens like ".net").
      // In OR mode the phrases are just alternatives, so don't require them.
      if (exact && !orMode) {
        const text = searchableText(job);
        if (!lowerPhrases.every((p) => text.includes(p))) continue;
      }
      const terms = exact ? [...phrases, ...looseTerms] : r.terms;
      // Distinct matched query terms, original-cased, for the tags column.
      const matched = Array.from(new Set(r.terms)).map(
        (t) => displayMap.get(t) ?? t,
      );
      hits.push({ ...job, score: r.score, terms, matched });
    }

    if (sort === "matches") {
      hits.sort(
        (a, b) => b.matched.length - a.matched.length || byDateDesc(a, b),
      );
    } else if (sort === "date") {
      hits.sort(byDateDesc);
    }
    // relevance is MiniSearch's native order, so leave as-is
  }

  return { hits, total: hits.length, ms: performance.now() - start };
}
