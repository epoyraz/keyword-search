// City normalization for the search index, ported from jobboard-data's
// transform/consolidate.py (normalize_city). Maps noisy JSON-LD locality
// strings ("8060 Zürich", "Aarau - Bahnhofplatz 3d", "Geneva") to a canonical
// Swiss municipality name using the official AMTOVZ municipality list, plus a
// small alias table for common exonyms. Returns null when a value clearly isn't
// a municipality, so junk ("-", "8706", "Switzerland") drops out of the filter.

import { readFile } from "node:fs/promises";

function asciiFold(value) {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** Normalized comparison key for aliases and municipality tokens. */
export function cityKey(value) {
  if (!value) return "";
  let f = asciiFold(value).toLowerCase();
  f = f.replace(/&/g, " and ").replace(/\//g, " ").replace(/-/g, " ");
  f = f.replace(/[()|,.:;]+/g, " ").replace(/[^a-z0-9\s]+/g, " ");
  return f.replace(/\s+/g, " ").trim();
}

// Common exonyms / district names → canonical municipality (keyed by cityKey).
const ALIAS_SOURCE = {
  zurich: "Zürich", zuerich: "Zürich", oerlikon: "Zürich", altstetten: "Zürich",
  geneva: "Genève", geneve: "Genève", genf: "Genève",
  berne: "Bern", lucerne: "Luzern", basle: "Basel", bale: "Basel",
  biel: "Biel/Bienne", "biel/bienne": "Biel/Bienne", bienne: "Biel/Bienne",
  "biel bienne": "Biel/Bienne",
  "st.gallen": "St. Gallen", "st gallen": "St. Gallen", "saint-gallen": "St. Gallen",
  neuenburg: "Neuchâtel", carouge: "Carouge GE",
  "zuerich flughafen": "Kloten", "zurich flughafen": "Kloten", "zurich airport": "Kloten",
  "geneva airport": "Genève", "geneve airport": "Genève",
  "baden daettwil": "Baden", "baden dättwil": "Baden",
  "bern wankdorf": "Bern", "wankdorf bern": "Bern",
};
const CITY_NORMALIZE = new Map(
  Object.entries(ALIAS_SOURCE).map(([k, v]) => [cityKey(k), v]),
);

const NON_CITY_KEYS = new Set([
  "ch", "schweiz", "switzerland", "suisse", "svizzera", "deutschschweiz",
  "ostschweiz", "westschweiz", "mehrere standorte", "hauptsitz",
]);

const NON_CITY_HINT_RE =
  /\b(?:ambulant|ambulatorium|clinic|dienste|facility|hauptsitz|klinik|logistik|motorway|residenz|restaurant|services?|spital|standort|station|transport|zentrum)\b/i;

/** Build a normalizer bound to the official municipality CSV. */
export async function loadCityNormalizer(csvPath) {
  const byCasefold = new Map(); // exact match: name.toLowerCase() -> name
  const byKey = new Map(); // fuzzy: cityKey(name) -> name (first wins)
  const validNames = new Set(); // canonical names (to skip paren-stripping)

  try {
    const text = (await readFile(csvPath, "utf8")).replace(/^﻿/, "");
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const name = (lines[i].split(";")[0] || "").trim();
      if (!name) continue;
      byCasefold.set(name.toLowerCase(), name);
      validNames.add(name);
      const key = cityKey(name);
      if (key && !byKey.has(key)) byKey.set(key, name);
    }
  } catch {
    // No CSV → normalizer becomes a light cleaner (alias + trim only).
  }

  function lookup(value) {
    if (!value) return null;
    const exact = byCasefold.get(value.toLowerCase());
    if (exact) return exact;
    const key = cityKey(value);
    if (!key) return null;
    if (CITY_NORMALIZE.has(key)) return CITY_NORMALIZE.get(key);
    if (byKey.has(key)) return byKey.get(key);
    return null;
  }

  // Windowed token search: find a municipality phrase inside a noisy value
  // ("Aarau - Bahnhofplatz 3d" -> "Aarau", "Winterthur, Archplatz 2" -> "Winterthur").
  function searchTokens(value) {
    const tokens = cityKey(value).split(" ").filter(Boolean);
    if (!tokens.length) return null;
    const maxWindow = Math.min(4, tokens.length);
    for (let w = maxWindow; w >= 1; w--) {
      for (let s = 0; s + w <= tokens.length; s++) {
        const phrase = tokens.slice(s, s + w).join(" ");
        if (CITY_NORMALIZE.has(phrase)) return CITY_NORMALIZE.get(phrase);
        if (byKey.has(phrase)) return byKey.get(phrase);
      }
    }
    return null;
  }

  function normalizeCity(raw) {
    if (!raw) return null;
    let city = String(raw).trim();
    if (!city) return null;
    // Drop pure numbers / percentages (e.g. "8706", "80-") — never a city.
    if (/^\d+[%\-–]?$/.test(city)) return null;

    let hit = lookup(city);
    if (hit) return hit;

    // Strip a leading 4-digit ZIP: "8001 Zürich" -> "Zürich".
    if (city.length > 5 && /^\d{4} /.test(city)) city = city.slice(5).trim();
    // "Dübendorf / 8001 Zürich" -> "Dübendorf".
    if (city.includes(" / ")) city = city.split(" / ")[0].trim();
    // Strip country suffix/prefix.
    city = city
      .replace(/\s+(?:Switzerland|Schweiz|Suisse|Svizzera)\s*$/i, "")
      .replace(/^(?:Switzerland|Schweiz|Suisse|Svizzera)\s*[-–—]\s*/i, "")
      .replace(/\s*\(CH\)\s*$/i, "")
      .trim();
    // Strip trailing canton/metadata parens unless the whole thing is a known name.
    if (!validNames.has(city)) city = city.replace(/\s*\([^)]*\)\s*$/, "").trim();

    hit = lookup(city);
    if (hit) return hit;

    const key = cityKey(city);
    if (!key || NON_CITY_KEYS.has(key) || key.startsWith("region ")) return null;

    hit = searchTokens(city);
    if (hit) return hit;

    // Last resort: reject obvious non-municipalities (facilities, long phrases),
    // but keep a plausible short name as-is (mirrors consolidate.py).
    if (NON_CITY_HINT_RE.test(city) || key.split(" ").length > 3) return null;
    return city;
  }

  return { normalizeCity };
}
