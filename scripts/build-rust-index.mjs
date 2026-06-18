// Build the Rust/Wasm search index (binary snapshot) the worker loads at
// runtime, and sync the engine files (wasm + JS glue) into the app.
//
// - Reads public/jobs.json (the same doc store the JS index is built from).
// - Builds a MiniSearchWasm index with the shared search config and writes
//   public/search-index.bin (+ .gz/.br) — the worker fetches it via /dl.
// - Copies the freshly built pkg into the app: JS glue -> lib/engine/,
//   wasm binary -> public/ (+ .gz/.br) so the engine + index stay in lockstep.
//
// Run standalone (`node scripts/build-rust-index.mjs`) against an existing
// public/jobs.json, or call syncRustEngineAndIndex() from build-index.mjs.

import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SEARCH_FIELDS, SEARCH_OPTIONS } from "../lib/searchConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PKG = path.resolve(ROOT, "..", "..", "minisearch-rust", "pkg");
const PUBLIC_DIR = path.resolve(ROOT, "public");
const ENGINE_DIR = path.resolve(ROOT, "lib", "engine");

const WASM_FILE = "minisearch_rust_bg.wasm";
const GLUE_FILES = ["minisearch_rust.js", "minisearch_rust.d.ts"];

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

async function loadEngine() {
  const glue = await import(pathToFileURL(path.join(PKG, "minisearch_rust.js")).href);
  await glue.default({ module_or_path: await readFile(path.join(PKG, WASM_FILE)) });
  return glue.MiniSearchWasm;
}

/** Build the binary index from a jobs.json text and write it (+ compressed). */
export async function buildRustIndex(jobsJson) {
  const MiniSearchWasm = await loadEngine();
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
 * Copy the built engine into lib/engine/ so it ships with the app bundle. The
 * wasm sits next to its JS glue: the bundler resolves the glue's
 * `new URL('minisearch_rust_bg.wasm', import.meta.url)` and emits the wasm as a
 * hashed static asset that `init()` fetches at runtime.
 */
export async function syncEngine() {
  await mkdir(ENGINE_DIR, { recursive: true });
  for (const f of [...GLUE_FILES, WASM_FILE]) {
    await copyFile(path.join(PKG, f), path.join(ENGINE_DIR, f));
  }
  const wasm = await readFile(path.join(PKG, WASM_FILE));
  return wasm.length;
}

/** Both steps, sharing one engine build. Call this from build-index.mjs. */
export async function syncRustEngineAndIndex(jobsJson) {
  const { indexBytes, version } = await buildRustIndex(jobsJson);
  const wasmBytes = await syncEngine();
  return { indexBytes, wasmBytes, version };
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
  const jobsJson = await readFile(path.join(PUBLIC_DIR, "jobs.json"), "utf8");
  const { indexBytes, wasmBytes, version } = await syncRustEngineAndIndex(jobsJson);
  await updateMetaVersion(version);
  console.log(`Wrote public/search-index.bin — ${mb(indexBytes)} (+ .gz/.br)`);
  console.log(`Synced engine into lib/engine/: ${[...GLUE_FILES, WASM_FILE].join(", ")} — wasm ${mb(wasmBytes)}`);
  console.log(`Updated search-meta.json version -> ${version}`);
}

// Run as a CLI only when invoked directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
