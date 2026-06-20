// Build the minisearch-wasm binary index snapshot the worker loads at runtime.
//
// - Reads public/jobs.json (metadata-only) + public/descriptions.json and
//   merges them back into full docs (the index tokenizes descriptions too).
// - Builds a MiniSearchWasm index with the shared search config and writes
//   public/search-index.bin (+ .gz/.br) — the worker fetches it via /dl.
//
// The wasm engine now ships as the `minisearch-wasm` npm package (wasm-pack
// bundler target, self-initializing on import). Both this builder and the
// worker import it directly, so there is no engine to copy into the app.
//
// Run standalone (`node scripts/build-rust-index.mjs`) against an existing
// public/jobs.json, or call syncRustEngineAndIndex() from build-index.mjs.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import init, { MiniSearchWasm } from "minisearch-wasm";
import { SEARCH_FIELDS, SEARCH_OPTIONS } from "../lib/searchConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.resolve(ROOT, "public");

// The web-target init() defaults to fetching the wasm via a file: URL, which
// Node's fetch can't do — so initialize once from the wasm bytes directly.
let wasmReady;
function ensureWasm() {
  if (!wasmReady) {
    const wasmPath = createRequire(import.meta.url).resolve(
      "minisearch-wasm/minisearch_wasm_bg.wasm",
    );
    wasmReady = readFile(wasmPath).then((bytes) => init(bytes));
  }
  return wasmReady;
}

async function writeVariants(file, buf) {
  await writeFile(file, buf);
  await writeFile(`${file}.gz`, gzipSync(buf, { level: 9 }));
  await writeFile(
    `${file}.br`,
    brotliCompressSync(buf, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }),
  );
}

/** Build the binary index from a jobs.json text and write it (+ compressed). */
export async function buildRustIndex(jobsJson) {
  await ensureWasm();
  const mini = new MiniSearchWasm({
    idField: "id",
    fields: SEARCH_FIELDS,
    tokenizer: "jobboard",
    searchOptions: SEARCH_OPTIONS,
  });
  mini.addAllJSON(jobsJson);
  const bytes = Buffer.from(mini.toBytes());
  await writeVariants(path.join(PUBLIC_DIR, "search-index.bin"), bytes);
  // Version the cache key by the index CONTENT (data + format), so a format
  // change busts client caches even when the underlying job data is unchanged.
  const version = createHash("sha1").update(bytes).digest("hex").slice(0, 12);
  return { indexBytes: bytes.length, version };
}

/**
 * Build the binary index. The engine ships via the `minisearch-wasm` package,
 * so unlike before there is nothing to copy into lib/engine — this is now just
 * an alias for buildRustIndex, kept so build-index.mjs's call site is stable.
 */
export async function syncRustEngineAndIndex(jobsJson) {
  return buildRustIndex(jobsJson);
}

/** Update only the `version` field of public/search-meta.json. */
async function updateMetaVersion(version) {
  const metaPath = path.join(PUBLIC_DIR, "search-meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  meta.version = version;
  await writeFile(metaPath, JSON.stringify(meta));
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  // jobs.json is metadata-only now; re-merge descriptions so the index is built
  // from full docs (matching build-index.mjs).
  const jobs = JSON.parse(await readFile(path.join(PUBLIC_DIR, "jobs.json"), "utf8"));
  const descriptions = JSON.parse(
    await readFile(path.join(PUBLIC_DIR, "descriptions.json"), "utf8"),
  );
  for (const j of jobs) j.description = descriptions[j.id] ?? "";
  const jobsJson = JSON.stringify(jobs);
  const { indexBytes, version } = await buildRustIndex(jobsJson);
  await updateMetaVersion(version);
  console.log(`Wrote public/search-index.bin — ${mb(indexBytes)} (+ .gz/.br)`);
  console.log(`Updated search-meta.json version -> ${version}`);
}

// Run as a CLI only when invoked directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
