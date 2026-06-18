// Shared search configuration used BOTH at build time
// (scripts/build-index.mjs, to construct the serialized MiniSearch index) and
// at runtime (the worker, to query it via MiniSearch.loadJSON). They MUST stay
// in lockstep: the index is tokenized at build time, so query tokenization has
// to match exactly or lookups miss.

export const SEARCH_FIELDS = [
  "title",
  "description",
  "company",
  "location",
  "org",
];

// Default tokenization strips "#", "+", ".", which collapses "C#"/"C++"/".NET".
// Treat unicode letters/digits plus those symbols as token chars.
const TOKEN_SEPARATOR = /[^\p{L}\p{N}+#.]+/u;

export function tokenize(text) {
  return text.split(TOKEN_SEPARATOR).filter(Boolean);
}

export function processTerm(term) {
  // Lowercase; strip trailing dots (sentence punctuation) but keep leading dots
  // (".NET" stays distinct from "net") and symbol-bearing terms like "c#".
  const t = term.toLowerCase().replace(/\.+$/, "");
  return t || null;
}

export const SEARCH_OPTIONS = {
  boost: { title: 4, company: 2, location: 1.5 },
  prefix: true,
  fuzzy: 0.2,
  combineWith: "AND",
};

export function miniSearchOptions() {
  return {
    idField: "id",
    fields: SEARCH_FIELDS,
    tokenize,
    processTerm,
    searchOptions: SEARCH_OPTIONS,
  };
}
