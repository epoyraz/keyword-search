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
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(ROOT, "..", "jobboard-data", "details");
const OUT_FILE = path.resolve(ROOT, "public", "jobs.json");

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

function decodeEntities(s) {
  if (typeof s !== "string" || !s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
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

  if (!existsSync(path.dirname(OUT_FILE))) {
    await mkdir(path.dirname(OUT_FILE), { recursive: true });
  }
  await writeFile(OUT_FILE, JSON.stringify(jobs));
  const { size } = await stat(OUT_FILE);

  const companyCount = new Set(jobs.map((j) => j.company)).size;
  console.log(
    `\nIndexed ${jobs.length} jobs from ${companyCount} companies ` +
      `(scanned ${scanned} files, skipped ${skipped}).`,
  );
  console.log(`Wrote ${OUT_FILE} — ${(size / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
