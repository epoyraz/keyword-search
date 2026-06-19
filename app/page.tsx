"use client";

import { useEffect, useRef, useState } from "react";
import { loadIndex, search as runSearch } from "@/lib/searchClient";
import type { Hit, IndexStats, SearchOutcome, SortMode } from "@/lib/types";
import { highlight, snippet } from "@/lib/highlight";
import CityFilter from "./CityFilter";

const PAGE_SIZE = 30;

const SORT_OPTS: [SortMode, string][] = [
  ["relevance", "Relevance"],
  ["matches", "Most matches"],
  ["date", "Newest"],
];

const POSTED_OPTS: [number, string][] = [
  [0, "Any time"],
  [1, "Past 24 hours"],
  [7, "Past week"],
  [30, "Past month"],
  [90, "Past 3 months"],
  [365, "Past year"],
];

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// Some scraped fields arrive as the literal string "null"/"undefined" or blank;
// treat all of those as absent so they never render in the UI.
function clean(v?: string | null): string {
  const s = (v ?? "").trim();
  return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined" ? s : "";
}

function fmtDate(d: string): string {
  const c = clean(d);
  if (!c) return "";
  const dt = new Date(c);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtType(t: string): string {
  const c = clean(t);
  if (!c) return "";
  const s = c.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function Home() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("relevance");
  const [company, setCompany] = useState("");
  const [city, setCity] = useState("");
  const [days, setDays] = useState(0); // posted-within window; 0 = any time
  const [postedAfter, setPostedAfter] = useState<string | undefined>(undefined);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hydrated, setHydrated] = useState(false);
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false); // mobile filter sheet

  // Set the recency window + its cutoff date together (Date.now() is impure, so
  // it must be called from an event/effect, never during render).
  const chooseDays = (d: number) => {
    setDays(d);
    setPostedAfter(
      d ? new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10) : undefined,
    );
  };

  const clearAll = () => {
    setQuery("");
    setCompany("");
    setCity("");
    chooseDays(0);
  };

  const debouncedQuery = useDebounced(query, 120);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeFilters = [company, city, days].filter(Boolean).length;

  // Hydrate state from the URL once, then load the index. Reading the URL must
  // happen after hydration (an effect, not a lazy initializer) so the first
  // client render still matches the static HTML — hence the rule exception.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- syncing initial state from the URL */
    const p = new URLSearchParams(window.location.search);
    if (p.has("q")) setQuery(p.get("q") ?? "");
    const s = p.get("sort");
    if (s === "relevance" || s === "date" || s === "matches") setSort(s);
    if (p.has("company")) setCompany(p.get("company") ?? "");
    if (p.has("city")) setCity(p.get("city") ?? "");
    const d = Number(p.get("days"));
    if (Number.isFinite(d) && d > 0) chooseDays(d);
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    loadIndex()
      .then((s) => {
        setStats(s);
        setReady(true);
        inputRef.current?.focus();
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Reflect state in the URL so a search is shareable/bookmarkable. replaceState
  // keeps it out of the back-button history.
  useEffect(() => {
    if (!hydrated) return;
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    if (sort !== "relevance") p.set("sort", sort);
    if (company) p.set("company", company);
    if (city) p.set("city", city);
    if (days) p.set("days", String(days));
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [hydrated, query, sort, company, city, days]);

  // Reset pagination whenever the query or a filter changes (adjust state
  // during render, per React guidance, rather than in an effect).
  const viewKey = `${debouncedQuery}|${sort}|${company}|${city}|${days}`;
  const [prevViewKey, setPrevViewKey] = useState(viewKey);
  if (viewKey !== prevViewKey) {
    setPrevViewKey(viewKey);
    setLimit(PAGE_SIZE);
  }

  // Run the search in the worker whenever inputs change; ignore stale responses.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    runSearch({
      query: debouncedQuery,
      sort,
      filters: { company, city, postedAfter },
    }).then((o) => {
      if (!cancelled) setOutcome(o);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, debouncedQuery, sort, company, city, postedAfter]);

  const visible: Hit[] = outcome ? outcome.hits.slice(0, limit) : [];
  const resultCount = outcome ? `${outcome.total.toLocaleString()} results` : "";

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-[#ff6600] text-white shadow [padding-top:env(safe-area-inset-top)]">
        <div className="mx-auto max-w-4xl px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2 sm:gap-3">
          <span className="hidden sm:inline font-mono font-bold text-lg whitespace-nowrap">
            keyword-search
          </span>
          <div className="relative flex-1">
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="9" cy="9" r="6" />
              <line x1="14" y1="14" x2="18" y2="18" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                stats
                  ? `Search ${stats.total.toLocaleString()} job postings…`
                  : "Loading…"
              }
              disabled={!ready}
              className="w-full rounded-xl sm:rounded-md border-0 bg-white pl-9 pr-3 py-2.5 sm:py-2 text-base text-black placeholder-gray-500 outline-none focus:ring-2 focus:ring-orange-300"
            />
          </div>
        </div>
      </header>

      {/* Controls — mobile: a Filters button that opens a bottom sheet */}
      <div className="sm:hidden border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-3 py-2">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 active:bg-gray-100"
          >
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              className="h-4 w-4 text-gray-500"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="3" y1="6" x2="17" y2="6" />
              <line x1="3" y1="14" x2="17" y2="14" />
              <circle cx="8" cy="6" r="2" fill="white" />
              <circle cx="13" cy="14" r="2" fill="white" />
            </svg>
            Filters
            {activeFilters > 0 && (
              <span className="rounded-full bg-[#ff6600] px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">
                {activeFilters}
              </span>
            )}
          </button>
          <span className="ml-auto text-sm text-gray-500">{resultCount}</span>
        </div>
      </div>

      {/* Controls — desktop: the inline filter row (unchanged) */}
      <div className="hidden sm:block border-b border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-4xl px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-700">
          <label className="flex items-center gap-1">
            <span className="text-gray-500">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortMode)}
              className="rounded border border-gray-300 bg-white px-1.5 py-1"
            >
              {SORT_OPTS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1">
            <span className="text-gray-500">Company</span>
            <select
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="rounded border border-gray-300 bg-white px-1.5 py-1 max-w-[14rem]"
            >
              <option value="">All</option>
              {stats?.companies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          {stats && stats.cities.length > 0 && (
            <CityFilter
              value={city}
              onChange={setCity}
              cities={stats.cities}
              topCount={stats.topCityCount}
            />
          )}

          <label className="flex items-center gap-1">
            <span className="text-gray-500">Posted</span>
            <select
              value={days}
              onChange={(e) => chooseDays(Number(e.target.value))}
              className="rounded border border-gray-300 bg-white px-1.5 py-1"
            >
              {POSTED_OPTS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          {(company || city || query || days) && (
            <button onClick={clearAll} className="text-orange-600 hover:underline">
              Clear
            </button>
          )}

          <span className="hidden lg:inline text-gray-400">
            tip: <code className="font-mono">&quot;exact&quot;</code> ·{" "}
            <code className="font-mono">a OR b</code> ·{" "}
            <code className="font-mono">-exclude</code> ·{" "}
            <code className="font-mono">title:engineer</code>
          </span>

          <span className="ml-auto text-gray-500">
            {outcome
              ? `${outcome.total.toLocaleString()} results (${outcome.ms.toFixed(
                  1,
                )} ms)`
              : ""}
          </span>
        </div>
      </div>

      {/* Results */}
      <main className="mx-auto w-full max-w-4xl flex-1 px-3 sm:px-4 py-3 sm:py-4">
        {error && (
          <p className="text-red-600">
            Could not load the index: {error}. Run{" "}
            <code className="font-mono">npm run index</code> first.
          </p>
        )}

        {!error && !outcome && (
          <p className="text-gray-500">
            {stats
              ? `Building local index (${stats.total.toLocaleString()} postings)…`
              : "Loading…"}
          </p>
        )}

        {outcome && outcome.total === 0 && (
          <p className="text-gray-500">No matching job postings.</p>
        )}

        <ol className="space-y-3 sm:space-y-4">
          {visible.map((hit) => {
            const loc = clean(hit.location);
            const type = fmtType(hit.employmentType);
            const date = fmtDate(hit.datePosted);
            return (
              <li
                key={hit.id}
                className="flex gap-4 rounded-xl border border-gray-200 bg-white p-4 leading-snug active:bg-gray-50 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:active:bg-transparent"
              >
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-medium sm:text-[15px]">
                    {hit.url ? (
                      <a
                        href={hit.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-900 hover:text-orange-600 hover:underline"
                      >
                        {highlight(hit.title, hit.terms)}
                      </a>
                    ) : (
                      <span className="text-gray-900">
                        {highlight(hit.title, hit.terms)}
                      </span>
                    )}
                  </h2>
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[13px] text-gray-500 sm:mt-0.5 sm:text-xs">
                    <span className="font-medium text-orange-700">{hit.company}</span>
                    {loc && <span>· {loc}</span>}
                    {type && <span>· {type}</span>}
                    {date && <span>· {date}</span>}
                  </div>
                  {hit.description && (
                    <p className="mt-1.5 text-sm text-gray-700 sm:mt-1 sm:text-[13px]">
                      {highlight(snippet(hit.description, hit.terms), hit.terms)}
                    </p>
                  )}
                  {hit.matched.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1 sm:hidden">
                      {hit.matched.map((m) => (
                        <span
                          key={m}
                          className="rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-800"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {hit.matched.length > 0 && (
                  <div className="hidden w-44 shrink-0 flex-col items-end gap-1 sm:flex">
                    <span className="text-[11px] font-semibold text-gray-400">
                      {hit.matched.length} match
                      {hit.matched.length > 1 ? "es" : ""}
                    </span>
                    <div className="flex flex-wrap justify-end gap-1">
                      {hit.matched.map((m) => (
                        <span
                          key={m}
                          className="rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-800"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        {outcome && limit < outcome.total && (
          <div className="mt-6 text-center">
            <button
              onClick={() => setLimit((l) => l + PAGE_SIZE)}
              className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm text-gray-700 active:bg-gray-100 sm:w-auto sm:rounded sm:py-2 sm:hover:bg-gray-100"
            >
              Show more ({(outcome.total - limit).toLocaleString()} remaining)
            </button>
          </div>
        )}
      </main>

      <footer className="border-t border-gray-200 py-4 text-center text-xs text-gray-400 [padding-bottom:calc(env(safe-area-inset-bottom)+1rem)] sm:pb-4">
        Fully local · indexed from scraped company HTML · no external API
      </footer>

      {/* Mobile filter sheet */}
      {sheetOpen && (
        <div className="fixed inset-0 z-40 sm:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            aria-hidden
            onClick={() => setSheetOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between px-4 pt-4 pb-3">
              <h2 className="text-lg font-semibold text-gray-900">Filters</h2>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label="Close filters"
                className="-mr-1.5 rounded-full p-2 text-xl leading-none text-gray-500 active:bg-gray-100"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Sort
                </label>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortMode)}
                  className="h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900"
                >
                  {SORT_OPTS.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Company
                </label>
                <select
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900"
                >
                  <option value="">All companies</option>
                  {stats?.companies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              {stats && stats.cities.length > 0 && (
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                    City
                  </label>
                  <CityFilter
                    fullWidth
                    value={city}
                    onChange={setCity}
                    cities={stats.cities}
                    topCount={stats.topCityCount}
                  />
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Posted
                </label>
                <select
                  value={days}
                  onChange={(e) => chooseDays(Number(e.target.value))}
                  className="h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900"
                >
                  {POSTED_OPTS.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex gap-3 border-t border-gray-200 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
              <button
                type="button"
                onClick={clearAll}
                className="flex-1 rounded-xl border border-gray-300 py-3 text-base font-medium text-gray-700 active:bg-gray-100"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="flex-1 rounded-xl bg-[#ff6600] py-3 text-base font-semibold text-white active:bg-orange-600"
              >
                {outcome ? `Show ${outcome.total.toLocaleString()}` : "Show results"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
