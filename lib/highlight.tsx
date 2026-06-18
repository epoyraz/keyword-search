import React from "react";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap any occurrence of the matched terms in <mark>. */
export function highlight(text: string, terms: string[]): React.ReactNode {
  if (!terms.length || !text) return text;
  const pattern = terms
    .filter(Boolean)
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join("|");
  if (!pattern) return text;
  const re = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(re);
  return parts.map((part, i) =>
    re.test(part) && i % 2 === 1 ? (
      <mark key={i} className="bg-orange-200 text-inherit rounded-sm">
        {part}
      </mark>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}

/**
 * Produce a snippet of `text` centred on the first matched term, so the
 * matching context is visible (like search-result excerpts).
 */
export function snippet(text: string, terms: string[], len = 260): string {
  if (!text) return "";
  if (!terms.length) return text.slice(0, len) + (text.length > len ? "…" : "");

  const lower = text.toLowerCase();
  // Centre on the most specific term that occurs (longest first), so a phrase
  // like "data scientist" wins over an incidental earlier "data".
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  let idx = -1;
  for (const t of ordered) {
    const found = lower.indexOf(t.toLowerCase());
    if (found !== -1) {
      idx = found;
      break;
    }
  }
  if (idx === -1) return text.slice(0, len) + (text.length > len ? "…" : "");

  const start = Math.max(0, idx - Math.floor(len / 3));
  const end = Math.min(text.length, start + len);
  let s = text.slice(start, end);
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}
