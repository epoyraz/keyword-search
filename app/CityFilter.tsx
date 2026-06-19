"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface CityFilterProps {
  value: string;
  onChange: (city: string) => void;
  /** Pre-ordered: top `topCount` biggest first, then the rest alphabetically. */
  cities: string[];
  topCount: number;
}

/**
 * A searchable city picker. Unlike a native <select>, it shows a search box on
 * top, the top N biggest cities first, a separator, then the rest alphabetically.
 * While searching it shows a flat matching list (no grouping/separator).
 */
export default function CityFilter({ value, onChange, cities, topCount }: CityFilterProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the search box when opening.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const q = filter.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? cities.filter((c) => c.toLowerCase().includes(q)) : cities),
    [q, cities],
  );
  // Only group/separate when not actively searching.
  const grouped = q ? null : { top: cities.slice(0, topCount), rest: cities.slice(topCount) };

  const choose = (city: string) => {
    onChange(city);
    setOpen(false);
    setFilter("");
  };

  const Item = ({ city }: { city: string }) => (
    <button
      type="button"
      onClick={() => choose(city)}
      className={`block w-full truncate px-3 py-1 text-left hover:bg-orange-50 ${
        city === value ? "bg-orange-100 font-medium text-orange-800" : "text-gray-700"
      }`}
    >
      {city}
    </button>
  );

  return (
    <div className="relative flex items-center gap-1" ref={rootRef}>
      <span className="text-gray-500">City</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded border border-gray-300 bg-white px-1.5 py-1 max-w-[14rem]"
      >
        <span className="truncate">{value || "all"}</span>
        <span className="text-gray-400">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-md border border-gray-300 bg-white shadow-lg">
          <div className="border-b border-gray-100 p-2">
            <input
              ref={inputRef}
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter cities…"
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-orange-300"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => choose("")}
              className={`block w-full px-3 py-1 text-left hover:bg-orange-50 ${
                value === "" ? "bg-orange-100 font-medium text-orange-800" : "text-gray-700"
              }`}
            >
              all cities
            </button>

            {grouped ? (
              <>
                {grouped.top.map((c) => (
                  <Item key={c} city={c} />
                ))}
                {grouped.top.length > 0 && grouped.rest.length > 0 && (
                  <div className="my-1 border-t border-gray-200" />
                )}
                {grouped.rest.map((c) => (
                  <Item key={c} city={c} />
                ))}
              </>
            ) : matches.length ? (
              matches.map((c) => <Item key={c} city={c} />)
            ) : (
              <p className="px-3 py-2 text-gray-400">No matching city.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
