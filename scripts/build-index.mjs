// Build a compact, fully-local search index from the scraped company HTML pages.
//
// Source: ../jobboard-data/details/<Company>/*.html
// Each page embeds a <script type="application/ld+json"> JobPosting block.
// We parse that (falling back to OpenGraph meta tags), repair the mojibake
// encoding, dedupe, and write public/jobs.json — the only data the app loads.
//
// Run: npm run index

import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";
import { miniSearchOptions } from "../lib/searchConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(ROOT, "..", "jobboard-data", "details");
const PUBLIC_DIR = path.resolve(ROOT, "public");
const OUT_FILE = path.resolve(PUBLIC_DIR, "jobs.json");
const INDEX_FILE = path.resolve(PUBLIC_DIR, "search-index.json");
const META_FILE = path.resolve(PUBLIC_DIR, "search-meta.json");

// --- encoding repair -------------------------------------------------------
// The scraped text is UTF-8 that was once decoded as Latin-1 and re-saved,
// so "—" shows up as "â€"" etc. Re-interpret the bytes to recover the original.
function fixMojibake(s) {
  if (typeof s !== "string" || !s) return s;
  if (!/[ÃÂâ€™“”]/.test(s)) return s; // nothing suspicious
  try {
    const repaired = Buffer.from(s, "latin1").toString("utf8");
    // Only keep the repair if it didn't introduce replacement chars.
    if (!repaired.includes("�")) return repaired;
  } catch {
    /* fall through */
  }
  return s;
}

// Named HTML entities seen in the scraped descriptions (German + French
// accents and common punctuation). Numeric entities are handled separately.
const NAMED_ENTITIES = {
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
  oslash: "ø", Oslash: "Ø", aring: "å", Aring: "Å", aelig: "æ", AElig: "Æ",
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

function decodeEntities(s) {
  if (typeof s !== "string" || !s) return s;
  // Loop to unwind double-encoded entities like "&amp;nbsp;" -> "&nbsp;" -> " ".
  let out = s;
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
        String.fromCodePoint(parseInt(h, 16)),
      )
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
        name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m,
      );
    if (next === out) break;
    out = next;
  }
  return out;
}

const clean = (s) => {
  if (typeof s !== "string") return s;
  // Some companies embed HTML markup inside the JSON-LD description.
  const out = decodeEntities(fixMojibake(s).replace(/<[^>]+>/g, " "));
  return out.replace(/\s+/g, " ").trim();
};

// --- field extraction ------------------------------------------------------
function extractJsonLd(html) {
  // There can be more than one ld+json block; grab the JobPosting one.
  const re =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const job = arr.find(
        (o) => o && (o["@type"] === "JobPosting" || o.title || o.description),
      );
      if (job) return job;
    } catch {
      /* malformed block, keep looking */
    }
  }
  return null;
}

function metaContent(html, key) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const m = html.match(re);
  if (m) return m[1];
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
    "i",
  );
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}

function canonicalUrl(html) {
  const m = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  if (m) return m[1];
  return metaContent(html, "og:url");
}

function locationOf(job) {
  const loc = job?.jobLocation;
  const places = Array.isArray(loc) ? loc : loc ? [loc] : [];
  const parts = places
    .map((p) => p?.address?.addressLocality || p?.address?.addressRegion)
    .filter(Boolean);
  return clean(parts.join("; "));
}

function parseHtml(html, fallbackCompany) {
  const job = extractJsonLd(html);
  const title = clean(job?.title) || clean(metaContent(html, "og:title"));
  const description =
    clean(job?.description) || clean(metaContent(html, "og:description"));
  if (!title && !description) return null;

  const org =
    clean(job?.hiringOrganization?.name) || fallbackCompany || "";

  // Some fields (notably employmentType) can be arrays in the JSON-LD.
  const asText = (v) =>
    Array.isArray(v) ? v.map(asText).filter(Boolean).join(", ") : v ? String(v) : "";

  return {
    title: title || "(untitled)",
    company: fallbackCompany,
    org,
    location: locationOf(job),
    employmentType: clean(asText(job?.employmentType)),
    datePosted: asText(job?.datePosted).slice(0, 10),
    validThrough: asText(job?.validThrough).slice(0, 10),
    url: canonicalUrl(html) || "",
    description: description || "",
  };
}

// --- walk ------------------------------------------------------------------
async function main() {
  console.log("Reading from", DATA_DIR);
  const companies = (await readdir(DATA_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const jobs = [];
  const seen = new Set();
  let scanned = 0;
  let skipped = 0;

  for (const company of companies) {
    const dir = path.join(DATA_DIR, company);
    let files;
    try {
      files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".html"));
    } catch {
      continue;
    }
    for (const file of files) {
      scanned++;
      const full = path.join(dir, file);
      let html;
      try {
        html = await readFile(full, "utf8");
      } catch {
        skipped++;
        continue;
      }
      const rec = parseHtml(html, company);
      if (!rec) {
        skipped++;
        continue;
      }
      // Stable id from company + file name.
      rec.id = `${company}/${file.replace(/\.html$/i, "")}`;
      // Dedupe on url (fall back to id).
      const key = rec.url || rec.id;
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      jobs.push(rec);
    }
    process.stdout.write(
      `\r  ${company.padEnd(28)} — ${jobs.length} jobs so far`.padEnd(60),
    );
  }
  process.stdout.write("\n");

  // Sort newest first as the default ordering.
  jobs.sort((a, b) => (b.datePosted || "").localeCompare(a.datePosted || ""));

  if (!existsSync(PUBLIC_DIR)) await mkdir(PUBLIC_DIR, { recursive: true });

  // Write a file plus precompressed .gz and .br siblings. The /dl route handler
  // serves whichever the client accepts (br → gzip → raw); brotli ~halves the
  // transfer vs gzip and is far too slow to do per-request, so we do it here.
  const writeVariants = async (file, str) => {
    const buf = Buffer.from(str);
    await writeFile(file, buf);
    await writeFile(`${file}.gz`, gzipSync(buf, { level: 9 }));
    await writeFile(
      `${file}.br`,
      brotliCompressSync(buf, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
      }),
    );
  };

  // 1. Doc store (display + snippets).
  const docsJson = JSON.stringify(jobs);
  await writeVariants(OUT_FILE, docsJson);

  // 2. Prebuilt, serialized MiniSearch index — the browser deserializes this
  //    with loadJSON (≈6× faster than rebuilding from scratch on every load).
  const mini = new MiniSearch(miniSearchOptions());
  mini.addAll(jobs);
  await writeVariants(INDEX_FILE, JSON.stringify(mini));

  // 3. Tiny meta file: stats for the filter UI + a content hash to version the
  //    cached assets (so a data change busts the browser cache).
  const version = createHash("sha1").update(docsJson).digest("hex").slice(0, 12);
  const companyNames = Array.from(new Set(jobs.map((j) => j.company)))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const employmentTypes = Array.from(new Set(jobs.map((j) => j.employmentType)))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  await writeFile(
    META_FILE,
    JSON.stringify({
      total: jobs.length,
      companies: companyNames,
      employmentTypes,
      version,
    }),
  );

  const mb = async (f) => ((await stat(f)).size / 1024 / 1024).toFixed(1);
  console.log(
    `\nIndexed ${jobs.length} jobs from ${companyNames.length} companies ` +
      `(scanned ${scanned} files, skipped ${skipped}).`,
  );
  console.log(`Wrote ${OUT_FILE} — ${await mb(OUT_FILE)} MB`);
  console.log(`Wrote ${INDEX_FILE} — ${await mb(INDEX_FILE)} MB`);
  console.log(`Wrote ${META_FILE} (version ${version})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
