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
  /** Exact city; matched against any of a job's locations. */
  city?: string;
  /** ISO date (YYYY-MM-DD); keep only postings on/after this date. */
  postedAfter?: string;
}

export interface SearchOutcome {
  hits: Hit[];
  total: number;
  ms: number;
}

export interface SearchArgs {
  query: string;
  sort: SortMode;
  filters: Filters;
}

/** Index metadata, computed at build time and shipped as a tiny meta file. */
export interface IndexStats {
  total: number;
  companies: string[];
  /**
   * Cities for the filter, pre-ordered: the `topCityCount` biggest (by posting
   * count) first, then the remainder alphabetically.
   */
  cities: string[];
  /** How many leading entries in `cities` are the "top" group (for the separator). */
  topCityCount: number;
  /** Content hash; used to version the cached index assets. */
  version: string;
}

// --- worker protocol -------------------------------------------------------
export type WorkerRequest =
  | { type: "load"; version: string }
  | { type: "search"; reqId: number; args: SearchArgs };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "result"; reqId: number; outcome: SearchOutcome };
