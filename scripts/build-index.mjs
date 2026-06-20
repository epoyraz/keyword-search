// Build the search assets for keyword-search from the detail-scraper's export.
//
// Source: GCS latest/job_details.json (a minified array of detail rows, produced
// daily by jobboard-data/detail_runner.py). Output (baked into the image):
//   - public/jobs.json (+ .gz/.br) — metadata-only document store (no
//     description) the worker loads for filtering/sorting/rendering.
//   - public/descriptions.json (+ .gz/.br) — { id: description } map, fetched
//     on demand (per id) via /dl/desc. ~32 MB of the old 38 MB jobs.json lived
//     here; splitting it out is what shrinks the cold-start download.
//   - public/search-index.bin (+ .gz/.br) — the prebuilt wasm index, built from
//     the FULL docs (descriptions included) so term/BM25 search is unchanged.
//   - public/search-meta.json — stats + version pointer for the filter UI.
//
// Run: npm run index   (the Dockerfile runs this at image-build time)

import { writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clean } from "../lib/textClean.mjs";
import { buildCompanies, buildCityMeta } from "../lib/cityMeta.mjs";
import { buildRustIndex } from "./build-rust-index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.resolve(ROOT, "public");
const SOURCE_URL = process.env.JOB_DETAILS_URL
  || "https://storage.googleapis.com/jobboard-data-exports/latest/job_details.json";

// Map a detail-DB row to the search Job shape, cleaning the text fields here
// (single source of truth for cleaning — the scraper stores raw schema.org text).
function toJob(r) {
  const company = clean(r.company) || "";
  return {
    id: r.jobId,
    title: clean(r.title) || "(untitled)",
    company,
    org: clean(r.hiring_organization) || company,
    location: clean(r.city) || "",
    employmentType: clean(r.employment_type) || "",
    datePosted: (r.date_posted || "").slice(0, 10),
    validThrough: (r.valid_through || "").slice(0, 10),
    url: r.url || "",
    description: clean(r.description) || "",
  };
}

async function writeVariants(file, str) {
  const buf = Buffer.from(str);
  await writeFile(file, buf);
  await writeFile(`${file}.gz`, gzipSync(buf, { level: 9 }));
  await writeFile(
    `${file}.br`,
    brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }),
  );
}

// Some job "detail pages" are actually PDFs (or other binary), so the scraped
// description/title is undecoded binary. Detect that by the share of replacement
// (U+FFFD) and control characters.
function isGarbage(s) {
  if (!s) return false;
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd || c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad > 8 && bad / s.length > 0.03;
}

async function main() {
  console.log("Fetching", SOURCE_URL);
  const res = await fetch(SOURCE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch ${SOURCE_URL} -> ${res.status}`);
  const rows = await res.json();
  const mapped = rows.map(toJob).filter((j) => j.id);
  let blanked = 0;
  for (const j of mapped) {
    if (isGarbage(j.description)) { j.description = ""; blanked++; }
    if (isGarbage(j.title)) j.title = "(untitled)";
  }
  // Drop entries with no usable content (PDF/binary detail pages): no real
  // title AND no description.
  const jobs = mapped.filter((j) => !(j.title === "(untitled)" && !j.description));
  console.log(`Excluded ${mapped.length - jobs.length} content-less jobs; blanked ${blanked} garbage descriptions`);
  // Newest first — the default ordering for an empty query.
  jobs.sort((a, b) => (b.datePosted || "").localeCompare(a.datePosted || ""));

  if (!existsSync(PUBLIC_DIR)) await mkdir(PUBLIC_DIR, { recursive: true });

  // Build the prebuilt wasm index snapshot (public/search-index.bin + .gz/.br)
  // from the FULL docs (descriptions included), so term/BM25 search over
  // descriptions is unchanged. Its content hash is the cache key: it changes
  // when the data OR the engine's snapshot format changes, so a client never
  // loads a stale/incompatible .bin against a newer engine.
  const fullDocsJson = JSON.stringify(jobs);
  const { indexBytes, version } = await buildRustIndex(fullDocsJson);

  // Split the docs: a metadata-only jobs.json (small — what the worker loads up
  // front) and a separate { id: description } map fetched on demand. Skip blank
  // descriptions so absent ⇒ known-empty (saves bytes and a fetch round-trip).
  const metaJobs = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    company: j.company,
    org: j.org,
    location: j.location,
    employmentType: j.employmentType,
    datePosted: j.datePosted,
    validThrough: j.validThrough,
    url: j.url,
  }));
  await writeVariants(path.join(PUBLIC_DIR, "jobs.json"), JSON.stringify(metaJobs));

  const descriptions = {};
  for (const j of jobs) {
    if (j.description) descriptions[j.id] = j.description;
  }
  await writeVariants(
    path.join(PUBLIC_DIR, "descriptions.json"),
    JSON.stringify(descriptions),
  );
  const { cities, topCityCount } = buildCityMeta(jobs);
  const meta = {
    total: jobs.length,
    companies: buildCompanies(jobs),
    cities,
    topCityCount,
    version,
  };
  await writeFile(path.join(PUBLIC_DIR, "search-meta.json"), JSON.stringify(meta));

  const mb = async (f) => ((await stat(f)).size / 1024 / 1024).toFixed(1);
  console.log(`Indexed ${jobs.length} jobs from ${meta.companies.length} companies; `
    + `${cities.length} cities; version ${version}`);
  console.log(`Wrote public/jobs.json — ${await mb(path.join(PUBLIC_DIR, "jobs.json"))} MB metadata-only (+ .gz/.br)`);
  console.log(`Wrote public/descriptions.json — ${await mb(path.join(PUBLIC_DIR, "descriptions.json"))} MB (+ .gz/.br)`);
  console.log(`Wrote public/search-index.bin — ${(indexBytes / 1048576).toFixed(1)} MB (+ .gz/.br)`);
  console.log(`Wrote public/search-meta.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
