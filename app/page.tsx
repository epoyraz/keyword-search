"use client";

import { useEffect, useRef, useState } from "react";
import { loadIndex, search as runSearch } from "@/lib/searchClient";
import type { Hit, IndexStats, SearchOutcome, SortMode } from "@/lib/types";
import { highlight, snippet } from "@/lib/highlight";
import CityFilter from "./CityFilter";

const PAGE_SIZE = 30;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

function fmtDate(d: string): string {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtType(t: string): string {
  return t ? t.replace(/_/g, " ").toLowerCase() : "";
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

  // Set the recency window + its cutoff date together (Date.now() is impure, so
  // it must be called from an event/effect, never during render).
  const chooseDays = (d: number) => {
    setDays(d);
    setPostedAfter(
      d ? new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10) : undefined,
    );
  };

  const debouncedQuery = useDebounced(query, 120);
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-[#ff6600] text-white shadow">
        <div className="mx-auto max-w-4xl px-4 py-3 flex items-center gap-3">
          <span className="font-mono font-bold text-lg whitespace-nowrap">
            keyword-search
          </span>
          <div className="relative flex-1">
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
              className="w-full rounded-md border-0 px-3 py-2 text-black bg-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-orange-300"
            />
          </div>
        </div>
      </header>

      {/* Controls */}
      <div className="border-b border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-4xl px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-700">
          <label className="flex items-center gap-1">
            <span className="text-gray-500">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortMode)}
              className="rounded border border-gray-300 bg-white px-1.5 py-1"
            >
              <option value="relevance">by relevance</option>
              <option value="matches">by matches</option>
              <option value="date">by date</option>
            </select>
          </label>

          <label className="flex items-center gap-1">
            <span className="text-gray-500">Company</span>
            <select
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="rounded border border-gray-300 bg-white px-1.5 py-1 max-w-[14rem]"
            >
              <option value="">all</option>
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
              <option value={0}>any time</option>
              <option value={1}>past 24 hours</option>
              <option value={7}>past week</option>
              <option value={30}>past month</option>
              <option value={90}>past 3 months</option>
              <option value={365}>past year</option>
            </select>
          </label>

          {(company || city || query || days) && (
            <button
              onClick={() => {
                setQuery("");
                setCompany("");
                setCity("");
                chooseDays(0);
              }}
              className="text-orange-600 hover:underline"
            >
              clear
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
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-4">
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

        <ol className="space-y-4">
          {visible.map((hit) => (
            <li key={hit.id} className="flex gap-4 leading-snug">
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-medium">
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
                <div className="mt-0.5 text-xs text-gray-500 flex flex-wrap gap-x-2 gap-y-0.5">
                  <span className="font-medium text-orange-700">
                    {hit.company}
                  </span>
                  {hit.location && <span>· {hit.location}</span>}
                  {hit.employmentType && (
                    <span>· {fmtType(hit.employmentType)}</span>
                  )}
                  {hit.datePosted && <span>· {fmtDate(hit.datePosted)}</span>}
                </div>
                {hit.description && (
                  <p className="mt-1 text-[13px] text-gray-700">
                    {highlight(snippet(hit.description, hit.terms), hit.terms)}
                  </p>
                )}
              </div>

              {hit.matched.length > 0 && (
                <div className="hidden sm:flex w-44 shrink-0 flex-col items-end gap-1">
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
          ))}
        </ol>

        {outcome && limit < outcome.total && (
          <div className="mt-6 text-center">
            <button
              onClick={() => setLimit((l) => l + PAGE_SIZE)}
              className="rounded border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
            >
              Show more ({(outcome.total - limit).toLocaleString()} remaining)
            </button>
          </div>
        )}
      </main>

      <footer className="border-t border-gray-200 py-4 text-center text-xs text-gray-400">
        Fully local · indexed from scraped company HTML · no external API
      </footer>
    </div>
  );
}
