"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  loadEngines,
  measure,
  hasFreeTextTerm,
  type LoadedEngines,
} from "@/lib/benchEngine";
import type { SortMode } from "@/lib/types";
import CityFilter from "../CityFilter";
import ResultPanel from "./ResultPanel";
import BenchChart from "./BenchChart";

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

// How many top results to cross-check between the two engines.
const AGREE_N = 50;

export default function BenchmarkPage() {
  const [engines, setEngines] = useState<LoadedEngines | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);

  // A representative default so the page opens on a meaningful comparison
  // (an empty query bypasses the engines entirely).
  const [query, setQuery] = useState("software engineer");
  const [sort, setSort] = useState<SortMode>("relevance");
  const [company, setCompany] = useState("");
  const [city, setCity] = useState("");
  const [days, setDays] = useState(0);
  const [postedAfter, setPostedAfter] = useState<string | undefined>(undefined);
  const [iters, setIters] = useState(25);

  const debouncedQuery = useDebounced(query, 200);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Load both engines once.
  useEffect(() => {
    loadEngines()
      .then((e) => {
        setNow(Date.now());
        setEngines(e);
        inputRef.current?.focus();
      })
      .catch((err) => setError(String(err)));
  }, []);

  // Re-measure both engines whenever the shared query/filters change. This is a
  // pure (if expensive) function of the inputs, so it derives via useMemo rather
  // than effect+state — both panels and the chart read from the same result.
  const { js, wasm, agreement } = useMemo(() => {
    if (!engines) return { js: null, wasm: null, agreement: null };
    const filters = { company, city, postedAfter };

    // Big result sets (e.g. empty query → every job) are costly per run, so
    // dial back iterations to keep the page responsive on each keystroke.
    const probe = engines.wasm.run(debouncedQuery, sort, filters);
    const eff = probe.total > 5000 ? Math.min(iters, 8) : iters;

    const w = measure(engines.wasm, debouncedQuery, sort, filters, eff);
    const j = measure(engines.js, debouncedQuery, sort, filters, eff);

    // Sanity check: do both engines return the same top results?
    const n = Math.min(AGREE_N, w.outcome.total, j.outcome.total);
    let identical = 0;
    for (let i = 0; i < n; i++) {
      if (w.outcome.hits[i]?.id === j.outcome.hits[i]?.id) identical++;
    }
    return { js: j, wasm: w, agreement: { compared: n, identical } };
  }, [engines, debouncedQuery, sort, company, city, postedAfter, iters]);

  const stats = engines?.stats;
  const activeFilters = [company, city, days].filter(Boolean).length;

  return (
    <div className="flex min-h-full flex-col bg-gray-50">
      {/* Header — shared search for both engines (mirrors the main app) */}
      <header className="sticky top-0 z-30 bg-[#ff6600] text-white shadow">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="hidden whitespace-nowrap font-mono text-lg font-bold hover:underline sm:inline"
          >
            keyword-search
          </Link>
          <span className="hidden rounded bg-white/20 px-2 py-0.5 text-xs font-semibold sm:inline">
            benchmark
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
                  : "Loading both engines…"
              }
              disabled={!engines}
              className="w-full rounded-md border-0 bg-white py-2 pl-9 pr-9 text-base text-black placeholder-gray-500 outline-none focus:ring-2 focus:ring-orange-300 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Shared filter row (one set of controls drives both engines) */}
      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm text-gray-700">
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
              className="max-w-[14rem] rounded border border-gray-300 bg-white px-1.5 py-1"
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

          <label className="flex items-center gap-1">
            <span className="text-gray-500">Iterations</span>
            <select
              value={iters}
              onChange={(e) => setIters(Number(e.target.value))}
              className="rounded border border-gray-300 bg-white px-1.5 py-1"
            >
              {[5, 10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          {(company || city || query || days) && (
            <button onClick={clearAll} className="text-orange-600 hover:underline">
              Clear
            </button>
          )}

          {activeFilters > 0 && (
            <span className="text-gray-400">
              {activeFilters} filter{activeFilters > 1 ? "s" : ""} active
            </span>
          )}
        </div>
      </div>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">
        {error && (
          <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Could not load engines: {error}. Run{" "}
            <code className="font-mono">npm run index</code> first.
          </p>
        )}

        {!engines && !error && (
          <p className="py-10 text-center text-sm text-gray-500">
            Loading documents and instantiating both engines…
          </p>
        )}

        {engines && (
          <>
            {/* Chart first so the headline number is visible without scrolling */}
            <BenchChart
              jsName={engines.js.name}
              wasmName={engines.wasm.name}
              jsTiming={js?.timing ?? null}
              wasmTiming={wasm?.timing ?? null}
              jsLoadMs={engines.js.loadMs}
              wasmLoadMs={engines.wasm.loadMs}
              agreement={agreement}
              query={debouncedQuery}
              engineUsed={hasFreeTextTerm(debouncedQuery)}
            />

            {/* Side-by-side result panels (stack on small screens) */}
            <div className="mt-5 flex flex-col gap-5 lg:flex-row">
              <ResultPanel
                name={engines.wasm.name}
                detail={engines.wasm.detail}
                accent="orange"
                outcome={wasm?.outcome ?? null}
                timing={wasm?.timing ?? null}
                now={now}
              />
              <ResultPanel
                name={engines.js.name}
                detail={engines.js.detail}
                accent="slate"
                outcome={js?.outcome ?? null}
                timing={js?.timing ?? null}
                now={now}
              />
            </div>
          </>
        )}
      </main>

      <footer className="border-t border-gray-200 py-4 text-center text-xs text-gray-400">
        Both engines run on the main thread over the same documents · timings are
        the median of {iters} runs (after warmup)
      </footer>
    </div>
  );
}
