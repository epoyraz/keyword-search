"use client";

import { useEffect, useRef, useState } from "react";
import { loadIndex, search as runSearch } from "@/lib/searchClient";
import { fetchDescriptions } from "@/lib/descriptions";
import { readPdfText } from "@/lib/readPdfText";
import { extractSkills } from "@/lib/skillExtraction";
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

const POPULAR = [
  "Software Engineer",
  "Projektleiter",
  "Pflege",
  "Praktikum",
  "Data Analyst",
  "Marketing",
  "Zürich",
  "Sachbearbeiter",
];

const RECENTS_KEY = "ks:recent";

// Build the worker query from the committed skill tags. Tags OR-combine (match
// any skill, ranked by how many match); multi-word skills are quoted so each
// stays a single clause. A lone tag is just a plain term query.
function buildSkillQuery(skills: string[]): string {
  const parts = skills
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/\s/.test(s) ? `"${s}"` : s));
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0] : parts.join(" OR ");
}

// Tags can come from free-form CV text or typed input; drop quotes (they're our
// phrase delimiter) and collapse whitespace so a tag stays one clean clause.
function cleanSkill(raw: string): string {
  return raw.replace(/"/g, "").replace(/\s+/g, " ").trim();
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

// Relative "3 days ago"-style label + whether it counts as recent (<= 7 days).
// `now` is captured once after mount (Date.now() is impure in render). Garbage
// epoch dates (year < 2000) are dropped rather than shown as "56 years ago".
function fmtPosted(d: string, now: number | null): { label: string; isNew: boolean } {
  const c = clean(d);
  if (!c) return { label: "", isNew: false };
  const t = new Date(c).getTime();
  if (Number.isNaN(t) || new Date(t).getFullYear() < 2000) {
    return { label: "", isNew: false };
  }
  if (now == null) return { label: fmtDate(c), isNew: false };
  const days = Math.floor((now - t) / 86_400_000);
  let label: string;
  if (days < 0) label = fmtDate(c);
  else if (days === 0) label = "Today";
  else if (days === 1) label = "Yesterday";
  else if (days < 7) label = `${days} days ago`;
  else if (days < 14) label = "Last week";
  else if (days < 30) label = `${Math.floor(days / 7)} weeks ago`;
  else if (days < 60) label = "Last month";
  else if (days < 365) label = `${Math.floor(days / 30)} months ago`;
  else label = fmtDate(c);
  return { label, isNew: days >= 0 && days <= 7 };
}

function fmtType(t: string): string {
  const c = clean(t);
  if (!c) return "";
  const s = c.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function postedLabel(days: number): string {
  return POSTED_OPTS.find(([d]) => d === days)?.[1] ?? "";
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 py-1 pl-3 pr-1.5 text-sm font-medium text-orange-800">
      <span className="max-w-[12rem] truncate">{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove ${label}`}
        className="flex h-5 w-5 items-center justify-center rounded-full text-orange-700 hover:bg-orange-200"
      >
        ✕
      </button>
    </span>
  );
}

function SkeletonList() {
  return (
    <ol className="space-y-3 sm:space-y-4" aria-hidden>
      {Array.from({ length: 7 }).map((_, i) => (
        <li
          key={i}
          className="animate-pulse rounded-xl border border-gray-200 bg-white p-4 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0"
        >
          <div className="h-4 w-3/5 rounded bg-gray-200" />
          <div className="mt-2 h-3 w-2/5 rounded bg-gray-100" />
          <div className="mt-3 h-3 w-full rounded bg-gray-100" />
          <div className="mt-1.5 h-3 w-11/12 rounded bg-gray-100" />
        </li>
      ))}
    </ol>
  );
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
  const [now, setNow] = useState<number | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [dragY, setDragY] = useState(0); // sheet swipe-to-dismiss offset
  const [dragging, setDragging] = useState(false); // active drag (disables transition)

  // Preview descriptions are fetched lazily (they're no longer in jobs.json) for
  // just the visible slice, cached by id (in state so the list re-renders when a
  // batch lands), and re-fetched on "Show more". An id mapped to "" is a known
  // blank — distinct from `undefined` (not fetched yet).
  const [descById, setDescById] = useState<Record<string, string>>({});

  // Committed skill tags drive the search (the input box only composes the next
  // tag). Tags come from Enter / "Add skill" / a dropped CV.
  const [skills, setSkills] = useState<string[]>([]);
  const [cvStatus, setCvStatus] = useState<"idle" | "reading" | "error">("idle");
  const [cvError, setCvError] = useState("");
  const [cvName, setCvName] = useState("");
  const [dropActive, setDropActive] = useState(false); // CV drag-over highlight
  const fileInputRef = useRef<HTMLInputElement>(null);

  const chooseDays = (d: number) => {
    setDays(d);
    setPostedAfter(
      d ? new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10) : undefined,
    );
  };

  const clearAll = () => {
    setQuery("");
    setSkills([]);
    setCvStatus("idle");
    setCvError("");
    setCompany("");
    setCity("");
    chooseDays(0);
  };

  const inputRef = useRef<HTMLInputElement>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<number | null>(null);
  const activeFilters = [company, city, days].filter(Boolean).length;

  const addRecent = (q: string) => {
    const v = q.trim();
    if (v.length < 2) return;
    setRecents((prev) => {
      const next = [v, ...prev.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, 6);
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Commit the typed text as a skill tag (Enter / "Add skill" / a suggestion).
  const addSkill = (raw: string) => {
    const v = cleanSkill(raw);
    if (!v) return;
    // First tag: switch to "most matches" ranking — the OR-search intent.
    if (skills.length === 0 && sort === "relevance") setSort("matches");
    setSkills((prev) =>
      prev.some((s) => s.toLowerCase() === v.toLowerCase()) ? prev : [...prev, v],
    );
    addRecent(v);
    setQuery("");
  };

  // Bulk-add (a dropped CV's extracted skills), de-duped case-insensitively.
  const addSkills = (names: string[]) => {
    const cleaned = names.map(cleanSkill).filter(Boolean);
    if (cleaned.length === 0) return;
    if (skills.length === 0 && sort === "relevance") setSort("matches");
    setSkills((prev) => {
      const seen = new Set(prev.map((s) => s.toLowerCase()));
      const merged = [...prev];
      for (const v of cleaned) {
        if (!seen.has(v.toLowerCase())) {
          seen.add(v.toLowerCase());
          merged.push(v);
        }
      }
      return merged;
    });
  };

  const removeSkill = (s: string) => setSkills((prev) => prev.filter((x) => x !== s));

  // Read a dropped/picked PDF CV in the browser and turn its skills into tags.
  const handleCvFile = async (file?: File) => {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setCvError("Please choose a PDF CV.");
      setCvStatus("error");
      return;
    }
    setCvName(file.name);
    setCvStatus("reading");
    setCvError("");
    try {
      const text = await readPdfText(file);
      const names = extractSkills(text).map((s) => s.name);
      if (names.length === 0) {
        setCvError("No skills found — a scanned (image) CV would need OCR first.");
        setCvStatus("error");
        return;
      }
      addSkills(names);
      setCvStatus("idle");
    } catch (err) {
      console.error(err);
      setCvError("Could not read text from this PDF.");
      setCvStatus("error");
    }
  };

  const onCvDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      setDropActive(true);
    }
  };
  const onCvDragLeave = () => setDropActive(false);
  const onCvDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    void handleCvFile(e.dataTransfer.files?.[0]);
  };

  const pickSearch = (q: string) => {
    addSkill(q);
    setSearchFocused(false);
    inputRef.current?.blur();
  };

  // Hydrate state from the URL once, then load the index. Reading the URL must
  // happen after hydration (an effect, not a lazy initializer) so the first
  // client render still matches the static HTML — hence the rule exception.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- syncing initial state from the URL */
    setNow(Date.now());
    try {
      const r = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
      if (Array.isArray(r)) setRecents(r.filter((x) => typeof x === "string").slice(0, 6));
    } catch {}
    const p = new URLSearchParams(window.location.search);
    const sk = p.get("skills");
    if (sk) {
      setSkills(sk.split(",").map(cleanSkill).filter(Boolean));
    } else if (p.has("q")) {
      // Back-compat with old shareable links: a single free-text query → one tag.
      const q = cleanSkill(p.get("q") ?? "");
      if (q) setSkills([q]);
    }
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

  // Reflect state in the URL so a search is shareable/bookmarkable.
  useEffect(() => {
    if (!hydrated) return;
    const p = new URLSearchParams();
    if (skills.length) p.set("skills", skills.join(","));
    if (sort !== "relevance") p.set("sort", sort);
    if (company) p.set("company", company);
    if (city) p.set("city", city);
    if (days) p.set("days", String(days));
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [hydrated, skills, sort, company, city, days]);

  // Lock background scroll while the mobile filter sheet is open.
  useEffect(() => {
    if (!sheetOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sheetOpen]);

  // Close the search suggestions on outside click / Escape.
  useEffect(() => {
    if (!searchFocused) return;
    const onDown = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node))
        setSearchFocused(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSearchFocused(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [searchFocused]);

  // The committed skill tags are the actual search query.
  const searchQuery = buildSkillQuery(skills);

  // Reset pagination whenever the query or a filter changes.
  const viewKey = `${searchQuery}|${sort}|${company}|${city}|${days}`;
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
      query: searchQuery,
      sort,
      filters: { company, city, postedAfter },
    }).then((o) => {
      if (!cancelled) setOutcome(o);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, searchQuery, sort, company, city, postedAfter]);

  // Lazily fetch descriptions for the visible slice (id-cached across queries —
  // raw text doesn't depend on the query, only the highlight terms do).
  useEffect(() => {
    if (!stats || !outcome) return;
    const missing = outcome.hits
      .slice(0, limit)
      .map((h) => h.id)
      .filter((id) => !(id in descById));
    if (missing.length === 0) return;
    fetchDescriptions(missing, stats.version)
      .then((map) => {
        // Record every requested id (absent ⇒ "") so blanks aren't refetched.
        const next: Record<string, string> = {};
        for (const id of missing) next[id] = map[id] ?? "";
        setDescById((prev) => ({ ...prev, ...next }));
      })
      .catch(() => {});
  }, [outcome, limit, stats, descById]);

  const visible: Hit[] = outcome ? outcome.hits.slice(0, limit) : [];
  const resultCount = outcome ? `${outcome.total.toLocaleString()} results` : "";
  const showSuggest = searchFocused && query.trim() === "";

  // Sheet swipe-to-dismiss (drag the handle/header down to close).
  const onDragStart = (e: React.TouchEvent) => {
    dragStart.current = e.touches[0].clientY;
    setDragging(true);
  };
  const onDragMove = (e: React.TouchEvent) => {
    if (dragStart.current == null) return;
    const dy = e.touches[0].clientY - dragStart.current;
    if (dy > 0) setDragY(dy);
  };
  const onDragEnd = () => {
    if (dragY > 100) setSheetOpen(false);
    setDragY(0);
    dragStart.current = null;
    setDragging(false);
  };

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-[#ff6600] text-white shadow [padding-top:env(safe-area-inset-top)]">
        <div className="mx-auto max-w-4xl px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2 sm:gap-3">
          <span className="hidden sm:inline font-mono font-bold text-lg whitespace-nowrap">
            keyword-search
          </span>
          <div
            className={`relative flex-1 rounded-xl sm:rounded-md ${
              dropActive ? "ring-2 ring-white" : ""
            }`}
            ref={searchBoxRef}
            onDragOver={onCvDragOver}
            onDragLeave={onCvDragLeave}
            onDrop={onCvDrop}
          >
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
              onFocus={() => setSearchFocused(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addSkill(query);
                }
              }}
              placeholder={
                !stats
                  ? "Loading…"
                  : skills.length
                    ? "Add another skill…"
                    : "Add a skill, or drop your CV (PDF)…"
              }
              disabled={!ready}
              className="w-full rounded-xl sm:rounded-md border-0 bg-white pl-9 pr-16 py-2.5 sm:py-2 text-base text-black placeholder-gray-500 outline-none focus:ring-2 focus:ring-orange-300 [&::-webkit-search-cancel-button]:hidden"
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
              {query && (
                <button
                  type="button"
                  aria-label="Clear input"
                  onClick={() => {
                    setQuery("");
                    inputRef.current?.focus();
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  ✕
                </button>
              )}
              <button
                type="button"
                aria-label="Upload a PDF CV to add its skills"
                title="Upload a PDF CV to add its skills"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-6 w-6 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-orange-600"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.2 9.19a1 1 0 01-1.41-1.41l8.49-8.49" />
                </svg>
              </button>
            </div>
            {dropActive && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl sm:rounded-md bg-[#ff6600]/95 text-sm font-semibold text-white">
                Drop your CV to add skills
              </div>
            )}

            {showSuggest && (
              <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-xl bg-white text-black shadow-lg ring-1 ring-black/5">
                {recents.length > 0 && (
                  <div className="border-b border-gray-100 py-1">
                    <div className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
                      Recent
                    </div>
                    {recents.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pickSearch(r);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-orange-50"
                      >
                        <span className="text-gray-400">↩</span>
                        <span className="truncate">{r}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="px-3 py-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Popular
                </div>
                <div className="flex flex-wrap gap-2 p-3 pt-1.5">
                  {POPULAR.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickSearch(p);
                      }}
                      className="rounded-full bg-gray-100 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => addSkill(query)}
            disabled={!ready || !query.trim()}
            className="shrink-0 rounded-xl sm:rounded-md bg-white px-3 py-2.5 text-sm font-semibold text-orange-700 shadow-sm hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50 sm:py-2"
          >
            Add skill
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              void handleCvFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      {/* Skill tags — the committed query. Press Enter / Add skill, or drop a CV. */}
      {(skills.length > 0 || cvStatus !== "idle") && (
        <div className="border-b border-gray-200 bg-white">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
            {skills.map((s) => (
              <span
                key={s}
                className="inline-flex items-center gap-1 rounded-full bg-orange-100 py-1 pl-3 pr-1.5 text-sm font-medium text-orange-800"
              >
                <span className="max-w-[12rem] truncate">{s}</span>
                <button
                  type="button"
                  onClick={() => removeSkill(s)}
                  aria-label={`Remove ${s}`}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-orange-700 hover:bg-orange-200"
                >
                  ✕
                </button>
              </span>
            ))}
            {skills.length > 0 && (
              <button
                type="button"
                onClick={() => setSkills([])}
                className="ml-1 text-xs font-medium text-gray-500 hover:text-orange-600 hover:underline"
              >
                Clear skills
              </button>
            )}
            {cvStatus === "reading" && (
              <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-orange-500" />
                Extracting skills from {cvName}…
              </span>
            )}
            {cvStatus === "error" && <span className="text-xs text-red-600">{cvError}</span>}
          </div>
        </div>
      )}

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

      {/* Controls — desktop: the inline filter row */}
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

          {(company || city || skills.length > 0 || days) && (
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
              ? `${outcome.total.toLocaleString()} results (${outcome.ms.toFixed(1)} ms)`
              : ""}
          </span>
        </div>
      </div>

      {/* Results */}
      <main className="mx-auto w-full max-w-4xl flex-1 px-3 sm:px-4 py-3 sm:py-4">
        {/* Active-filter chips */}
        {(company || city || days > 0) && (
          <div className="mb-3 flex flex-wrap gap-2">
            {company && <FilterChip label={company} onClear={() => setCompany("")} />}
            {city && <FilterChip label={city} onClear={() => setCity("")} />}
            {days > 0 && (
              <FilterChip label={postedLabel(days)} onClear={() => chooseDays(0)} />
            )}
          </div>
        )}

        {error && (
          <p className="text-red-600">
            Could not load the index: {error}. Run{" "}
            <code className="font-mono">npm run index</code> first.
          </p>
        )}

        {!error && !outcome && <SkeletonList />}

        {outcome && outcome.total === 0 && (
          <div className="py-10 text-center">
            <p className="text-gray-700">
              No matches
              {skills.length === 1 ? (
                <> for “{skills[0]}”</>
              ) : skills.length > 1 ? (
                <> for your {skills.length} skills</>
              ) : null}
              .
            </p>
            <p className="mt-1 text-sm text-gray-500">
              {activeFilters > 0
                ? "Try removing a filter or check your spelling."
                : "Check your spelling or try a different term."}
            </p>
            {activeFilters > 0 && (
              <button
                onClick={clearAll}
                className="mt-4 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-100"
              >
                Clear all filters
              </button>
            )}
          </div>
        )}

        <ol className="space-y-3 sm:space-y-4">
          {visible.map((hit) => {
            const loc = clean(hit.location);
            const type = fmtType(hit.employmentType);
            const posted = fmtPosted(hit.datePosted, now);
            const desc = descById[hit.id];
            return (
              <li
                key={hit.id}
                className="relative flex gap-4 rounded-xl border border-gray-200 bg-white p-4 leading-snug transition-colors active:bg-gray-50 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:active:bg-transparent"
              >
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-medium sm:text-[15px]">
                    {hit.url ? (
                      <a
                        href={hit.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-900 after:absolute after:inset-0 hover:text-orange-600 hover:underline"
                      >
                        {highlight(hit.title, hit.terms)}
                      </a>
                    ) : (
                      <span className="text-gray-900">{highlight(hit.title, hit.terms)}</span>
                    )}
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-gray-500 sm:mt-0.5 sm:text-xs">
                    {posted.isNew && (
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] font-semibold text-green-700">
                        New
                      </span>
                    )}
                    <span className="font-medium text-orange-700">{hit.company}</span>
                    {loc && <span>· {loc}</span>}
                    {type && <span>· {type}</span>}
                    {posted.label && <span>· {posted.label}</span>}
                  </div>
                  {desc === undefined ? (
                    <div
                      aria-hidden
                      className="mt-1.5 h-3 w-11/12 animate-pulse rounded bg-gray-100 sm:mt-1"
                    />
                  ) : desc ? (
                    <p className="mt-1.5 text-sm text-gray-700 sm:mt-1 sm:text-[13px]">
                      {highlight(snippet(desc, hit.terms), hit.terms)}
                    </p>
                  ) : null}
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

      {/* Mobile filter sheet (always mounted so it can animate in/out) */}
      <div
        className={`fixed inset-0 z-40 sm:hidden ${sheetOpen ? "" : "pointer-events-none"}`}
        aria-hidden={!sheetOpen}
      >
        <div
          className={`absolute inset-0 bg-black/40 transition-opacity duration-300 ${
            sheetOpen ? "opacity-100" : "opacity-0"
          }`}
          onClick={() => setSheetOpen(false)}
        />
        <div
          className="absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-2xl bg-white shadow-2xl transition-transform duration-300 will-change-transform"
          style={{
            transform: sheetOpen ? `translateY(${dragY}px)` : "translateY(100%)",
            transition: dragging ? "none" : undefined,
          }}
        >
          <div
            onTouchStart={onDragStart}
            onTouchMove={onDragMove}
            onTouchEnd={onDragEnd}
          >
            <div className="flex justify-center pt-2.5">
              <div className="h-1.5 w-10 rounded-full bg-gray-300" />
            </div>
            <div className="flex items-center justify-between px-4 pt-1 pb-3">
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
    </div>
  );
}
