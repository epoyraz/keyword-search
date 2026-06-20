"use client";

import type { Timing } from "@/lib/benchEngine";

interface BenchChartProps {
  jsName: string;
  wasmName: string;
  jsTiming: Timing | null;
  wasmTiming: Timing | null;
  jsLoadMs: number;
  wasmLoadMs: number;
  /** Top-N result agreement between the two engines (sanity check). */
  agreement: { compared: number; identical: number } | null;
  query: string;
  /** False when the query bypasses the full-text engine (sort/filter only). */
  engineUsed: boolean;
}

type Bar = { name: string; value: number; accent: "orange" | "slate" };

const BAR_COLOR = {
  orange: "bg-[#ff6600]",
  slate: "bg-slate-400",
} as const;

function fmtMs(v: number): string {
  return v < 1 ? `${v.toFixed(3)} ms` : `${v.toFixed(2)} ms`;
}

// Horizontal bar chart: each bar's width is proportional to its value, the
// fastest (smallest) one is highlighted.
function BarChart({ bars, unit }: { bars: Bar[]; unit: string }) {
  const max = Math.max(...bars.map((b) => b.value), 0);
  const fastest = Math.min(...bars.map((b) => b.value));
  return (
    <div className="space-y-3">
      {bars.map((b) => {
        const pct = max > 0 ? (b.value / max) * 100 : 0;
        const isFastest = b.value === fastest;
        return (
          <div key={b.name} className="grid grid-cols-[9rem_1fr] items-center gap-3">
            <span
              className={`truncate text-right font-mono text-xs ${
                isFastest ? "font-bold text-gray-900" : "text-gray-500"
              }`}
            >
              {b.name}
            </span>
            <div className="flex items-center gap-2">
              <div className="h-6 flex-1 overflow-hidden rounded bg-gray-100">
                <div
                  className={`h-full rounded ${BAR_COLOR[b.accent]} transition-[width] duration-300`}
                  style={{ width: `${Math.max(pct, 1.5)}%` }}
                />
              </div>
              <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-gray-700">
                {b.value.toFixed(b.value < 1 ? 3 : 2)} {unit}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// "<faster> is N% faster than <slower> (M.MM× )"
function FasterLine({
  a,
  b,
  label,
}: {
  a: { name: string; value: number };
  b: { name: string; value: number };
  label: string;
}) {
  const [fast, slow] = a.value <= b.value ? [a, b] : [b, a];
  if (!(slow.value > 0) || !(fast.value > 0) || fast.value === slow.value) {
    return (
      <p className="text-sm text-gray-500">
        {label}: too close to call ({fmtMs(a.value)} vs {fmtMs(b.value)}).
      </p>
    );
  }
  const pct = ((slow.value - fast.value) / slow.value) * 100;
  const ratio = slow.value / fast.value;
  return (
    <p className="text-sm text-gray-700">
      <span className="text-gray-400">{label}: </span>
      <span className="font-mono font-bold text-[#ff6600]">{fast.name}</span> is{" "}
      <span className="font-bold text-gray-900">{pct.toFixed(0)}% faster</span> than{" "}
      <span className="font-mono">{slow.name}</span>{" "}
      <span className="text-gray-500">({ratio.toFixed(2)}× the speed)</span>.
    </p>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="font-mono text-sm tabular-nums text-gray-800">{value}</div>
    </div>
  );
}

export default function BenchChart({
  jsName,
  wasmName,
  jsTiming,
  wasmTiming,
  jsLoadMs,
  wasmLoadMs,
  agreement,
  query,
  engineUsed,
}: BenchChartProps) {
  const ready = jsTiming && wasmTiming;

  const searchBars: Bar[] = ready
    ? [
        { name: wasmName, value: wasmTiming.median, accent: "orange" },
        { name: jsName, value: jsTiming.median, accent: "slate" },
      ]
    : [];

  const loadBars: Bar[] = [
    { name: wasmName, value: wasmLoadMs, accent: "orange" },
    { name: jsName, value: jsLoadMs, accent: "slate" },
  ];

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900">Benchmark</h2>
        <span className="truncate text-xs text-gray-400">
          {query.trim() ? (
            <>
              query <span className="font-mono text-gray-600">“{query.trim()}”</span>
            </>
          ) : (
            "empty query (browse / sort all)"
          )}
          {ready ? ` · median of ${wasmTiming.iters} runs` : ""}
        </span>
      </div>

      {/* Search latency */}
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Search latency (lower is better)
      </div>
      {ready ? (
        <BarChart bars={searchBars} unit="ms" />
      ) : (
        <p className="py-6 text-center text-sm text-gray-400">Measuring…</p>
      )}

      {ready &&
        (engineUsed ? (
          <div className="mt-4 rounded-lg bg-orange-50 px-4 py-3">
            <FasterLine
              label="Search"
              a={{ name: wasmName, value: wasmTiming.median }}
              b={{ name: jsName, value: jsTiming.median }}
            />
          </div>
        ) : (
          <div className="mt-4 rounded-lg bg-gray-50 px-4 py-3">
            <p className="text-sm text-gray-500">
              This query has no full-text term, so both engines are bypassed — the
              times above are the shared filter/sort path, not the search engines.
              Type a keyword to compare them.
            </p>
          </div>
        ))}

      {/* Per-engine stats */}
      {ready && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {(
            [
              { name: wasmName, t: wasmTiming, dot: "bg-[#ff6600]" },
              { name: jsName, t: jsTiming, dot: "bg-slate-400" },
            ] as const
          ).map(({ name, t, dot }) => (
            <div key={name} className="rounded-lg border border-gray-200 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${dot}`} />
                <span className="font-mono text-xs font-semibold text-gray-700">{name}</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <StatCell label="median" value={fmtMs(t.median)} />
                <StatCell label="mean" value={fmtMs(t.mean)} />
                <StatCell label="min" value={fmtMs(t.min)} />
                <StatCell label="p95" value={fmtMs(t.p95)} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Index load — secondary comparison */}
      <div className="mt-6 border-t border-gray-100 pt-5">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Index load (one-time, lower is better)
        </div>
        <BarChart bars={loadBars} unit="ms" />
        <div className="mt-4 rounded-lg bg-gray-50 px-4 py-3">
          <FasterLine
            label="Index load"
            a={{ name: wasmName, value: wasmLoadMs }}
            b={{ name: jsName, value: jsLoadMs }}
          />
        </div>
      </div>

      {/* Result agreement */}
      {agreement && (
        <p className="mt-4 text-xs text-gray-400">
          Result agreement:{" "}
          {agreement.identical === agreement.compared ? (
            <span className="font-medium text-green-600">
              identical top {agreement.compared} ✓
            </span>
          ) : (
            <span className="font-medium text-amber-600">
              {agreement.identical}/{agreement.compared} of top results match
            </span>
          )}{" "}
          — both engines do the same work; only the speed differs.
        </p>
      )}
    </div>
  );
}
