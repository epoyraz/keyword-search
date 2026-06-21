// Shared term-boundary helpers used by the highlighter (lib/highlight.tsx), the
// search worker (lib/search.worker.ts), and the test set
// (scripts/test-term-matching.mjs). Kept as .mjs so all three — TSX, TS, and a
// plain Node script — can import the same source of truth.
//
// The boundary definition mirrors the tokenizer in searchConfig.mjs
// (TOKEN_SEPARATOR = /[^\p{L}\p{N}+#.]+/u): a "token char" is a unicode letter or
// digit, or one of + # . (so "C#", "C++", ".NET" stay whole). A term is at a word
// boundary when the chars immediately around it are NOT token chars (or are the
// string edge). This is why "C" matches a standalone "C" but not "Cruise".

// Char class for a token char. Used to assert NON-token-chars (or edges) around a
// match via look-behind / look-ahead.
const TOKEN_CHAR = "\\p{L}\\p{N}+#.";

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A term is "short" — and thus prone to prefix-flooding the index and to
// substring-highlight noise — when it is purely 1–2 letters (C, R, Go, AI).
// Symbol-bearing terms (c#, c++, .net) and anything 3+ chars are not short.
export function isShortAlphaTerm(term) {
  return /^\p{L}{1,2}$/u.test(term);
}

// Build one boundary-anchored, alternation regex for `terms`, or null when there
// is nothing usable. Longest-first so e.g. "data scientist" wins over "data".
// The single capturing group keeps String.split() splitting on matches (the
// look-arounds are zero-width and not captured).
export function buildBoundaryRegex(terms, flags = "giu") {
  const pattern = terms
    .filter(Boolean)
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join("|");
  if (!pattern) return null;
  return new RegExp(`(?<![${TOKEN_CHAR}])(${pattern})(?![${TOKEN_CHAR}])`, flags);
}

// True when `term` occurs in `text` as a whole, boundary-delimited token
// (case-insensitive). Non-global so it carries no lastIndex state.
export function boundedMatch(text, term) {
  if (!text || !term) return false;
  const re = buildBoundaryRegex([term], "iu");
  return re ? re.test(text) : false;
}
