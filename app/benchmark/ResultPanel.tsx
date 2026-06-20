"use client";

import type { Hit, SearchOutcome } from "@/lib/types";
import type { Timing } from "@/lib/benchEngine";
import { highlight, snippet } from "@/lib/highlight";
import { clean, fmtPosted, fmtType } from "@/lib/format";

const PAGE_SIZE = 30;

interface ResultPanelProps {
  /** Library name shown as the column label. */
  name: string;
  /** Short note on how this engine's index was obtained. */
  detail: string;
  /** Accent color for the label (brand orange for wasm, slate for JS). */
  accent: "orange" | "slate";
  outcome: SearchOutcome | null;
  timing: Timing | null;
  now: number | null;
}

const ACCENTS = {
  orange: { dot: "bg-[#ff6600]", text: "text-[#ff6600]", ms: "text-orange-700" },
  slate: { dot: "bg-slate-500", text: "text-slate-600", ms: "text-slate-700" },
} as const;

export default function ResultPanel({
  name,
  detail,
  accent,
  outcome,
  timing,
  now,
}: ResultPanelProps) {
  const a = ACCENTS[accent];
  const visible: Hit[] = outcome ? outcome.hits.slice(0, PAGE_SIZE) : [];

  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-gray-200 bg-white">
      {/* Column header / label */}
      <div className="sticky top-0 z-10 flex items-center gap-2 rounded-t-xl border-b border-gray-200 bg-gray-50/90 px-4 py-2.5 backdrop-blur">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${a.dot}`} />
        <div className="min-w-0">
          <h2 className={`font-mono text-sm font-bold ${a.text}`}>{name}</h2>
          <p className="truncate text-[11px] text-gray-400">{detail}</p>
        </div>
        <div className="ml-auto text-right">
          <div className={`font-mono text-sm font-semibold tabular-nums ${a.ms}`}>
            {timing ? `${timing.median.toFixed(2)} ms` : "—"}
          </div>
          <div className="text-[11px] text-gray-400">
            {outcome ? `${outcome.total.toLocaleString()} results` : "…"}
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-3">
        {!outcome ? (
          <p className="py-8 text-center text-sm text-gray-400">Searching…</p>
        ) : outcome.total === 0 ? (
          <p className="py-8 text-center text-sm text-gray-500">No matches.</p>
        ) : (
          <ol className="space-y-4">
            {visible.map((hit) => {
              const loc = clean(hit.location);
              const type = fmtType(hit.employmentType);
              const posted = fmtPosted(hit.datePosted, now);
              return (
                <li key={hit.id} className="leading-snug">
                  <h3 className="text-[15px] font-medium">
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
                      <span className="text-gray-900">{highlight(hit.title, hit.terms)}</span>
                    )}
                  </h3>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
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
                  {hit.description && (
                    <p className="mt-1 text-[13px] text-gray-700">
                      {highlight(snippet(hit.description, hit.terms), hit.terms)}
                    </p>
                  )}
                  {hit.matched.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
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
                </li>
              );
            })}
          </ol>
        )}

        {outcome && outcome.total > PAGE_SIZE && (
          <p className="mt-4 text-center text-xs text-gray-400">
            Showing first {PAGE_SIZE} of {outcome.total.toLocaleString()}
          </p>
        )}
      </div>
    </section>
  );
}
