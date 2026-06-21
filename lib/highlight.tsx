import React from "react";
import { buildBoundaryRegex } from "./termMatch.mjs";

/**
 * Wrap matched terms in <mark>, but only where the term occurs as a whole,
 * boundary-delimited token — so a one-letter skill like "C" highlights a
 * standalone "C" (as in "C, R, Devops") and never the "c" inside "Cruise" or
 * "JavaScript". Applies to every term, so "Java" no longer lights up inside
 * "JavaScript" either.
 */
export function highlight(text: string, terms: string[]): React.ReactNode {
  if (!terms.length || !text) return text;
  const re = buildBoundaryRegex(terms.filter(Boolean));
  if (!re) return text;
  // split() with a single capturing group puts the matched (odd-indexed) parts
  // between the surrounding text; the look-arounds are zero-width so this holds.
  const parts = text.split(re);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
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
 * matching context is visible (like search-result excerpts). Centres on a real
 * whole-word match (longest term first) so a short term doesn't anchor the
 * excerpt on an incidental substring.
 */
export function snippet(text: string, terms: string[], len = 260): string {
  if (!text) return "";
  if (!terms.length) return text.slice(0, len) + (text.length > len ? "…" : "");

  // Most specific term first (a phrase like "data scientist" over "data").
  const ordered = [...terms].filter(Boolean).sort((a, b) => b.length - a.length);
  let idx = -1;
  for (const t of ordered) {
    const re = buildBoundaryRegex([t], "iu");
    const m = re ? re.exec(text) : null;
    if (m) {
      idx = m.index;
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
