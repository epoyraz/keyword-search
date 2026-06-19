// Shared text cleaning for scraped job content: repair mojibake, decode HTML
// entities, strip markup, collapse whitespace. Used by the build-time indexer
// (scripts/build-index.mjs) and the runtime data provider (lib/dataProvider).

// The scraped text is UTF-8 that was once decoded as Latin-1 and re-saved,
// so "—" shows up as "â€"" etc. Re-interpret the bytes to recover the original.
export function fixMojibake(s) {
  if (typeof s !== "string" || !s) return s;
  if (!/[ÃÂâ€™“”]/.test(s)) return s; // nothing suspicious
  try {
    const repaired = Buffer.from(s, "latin1").toString("utf8");
    if (!repaired.includes("�")) return repaired;
  } catch {
    /* fall through */
  }
  return s;
}

// Named HTML entities seen in the scraped descriptions (German + French accents
// and common punctuation). Numeric entities are handled separately.
export const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", aring: "å", aelig: "æ",
  Agrave: "À", Aacute: "Á", Acirc: "Â",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û",
  ccedil: "ç", Ccedil: "Ç", ntilde: "ñ", Ntilde: "Ñ", yacute: "ý", yuml: "ÿ",
  oelig: "œ", OElig: "Œ", scaron: "š", Scaron: "Š", Yuml: "Ÿ",
  Oslash: "Ø", Aring: "Å", AElig: "Æ",
  eth: "ð", ETH: "Ð", thorn: "þ", THORN: "Þ",
  ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  sbquo: "‚", bdquo: "„", bull: "•", middot: "·",
  lsaquo: "‹", rsaquo: "›", prime: "′", Prime: "″", minus: "−",
  dagger: "†", Dagger: "‡", permil: "‰",
  shy: "", zwnj: "", zwj: "", ensp: " ", emsp: " ", thinsp: " ",
  sup1: "¹", sup2: "²", sup3: "³", frac12: "½", frac14: "¼", frac34: "¾",
  micro: "µ", para: "¶", sect: "§", cent: "¢", pound: "£", yen: "¥",
  curren: "¤", iexcl: "¡", iquest: "¿", plusmn: "±", divide: "÷",
  deg: "°", euro: "€", copy: "©", reg: "®", trade: "™", times: "×",
};

export function decodeEntities(s) {
  if (typeof s !== "string" || !s) return s;
  // Loop to unwind double-encoded entities like "&amp;nbsp;" -> "&nbsp;" -> " ".
  let out = s;
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
        name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m,
      );
    if (next === out) break;
    out = next;
  }
  return out;
}

export function clean(s) {
  if (typeof s !== "string") return s;
  // Some companies embed HTML markup inside the JSON-LD description.
  const out = decodeEntities(fixMojibake(s).replace(/<[^>]+>/g, " "));
  return out.replace(/\s+/g, " ").trim();
}
