// Run every test persona (scripts/personas.mjs) through the matcher and report
// how each profession fares — mirrors lib/search.worker.ts (exact committed
// skills, short skills refine-only). Shows match count, top job titles, and any
// refine-only skills, so we can sanity-check the matcher beyond tech CVs.
//
// Usage: node scripts/personas-test.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import init, { MiniSearchWasm } from "minisearch-wasm";
import { tokenize, processTerm } from "../lib/searchConfig.mjs";
import { isShortAlphaTerm } from "../lib/termMatch.mjs";
import { personas } from "./personas.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [indexBin, wasmBin, jobsRaw] = await Promise.all([
  readFile(path.resolve(ROOT, "public", "search-index.bin")),
  readFile(path.resolve(ROOT, "node_modules", "minisearch-wasm", "minisearch_wasm_bg.wasm")),
  readFile(path.resolve(ROOT, "public", "jobs.json"), "utf8"),
]);
await init({ module_or_path: wasmBin });
const mini = MiniSearchWasm.loadBytes(new Uint8Array(indexBin));
const byId = new Map(JSON.parse(jobsRaw).map((j) => [j.id, j]));
const totalJobs = byId.size;

// A skill matches jobs containing ALL its tokens exactly (AND); it broadens the
// result set only if it has a non-short token (else it's refine-only).
const skillIds = (name) => new Set(mini.search(name, { prefix: false, fuzzy: false, combineWith: "AND" }).map((r) => r.id));
const broadens = (name) => /\s/.test(name) || tokenize(name).map(processTerm).filter(Boolean).some((t) => !isShortAlphaTerm(t));

let prof = "";
for (const p of personas) {
  if (p.profession !== prof) {
    prof = p.profession;
    console.log(`\n══════════ ${prof.toUpperCase()} ══════════`);
  }
  const sets = new Map(p.skills.map((s) => [s, skillIds(s)]));
  const refineOnly = p.skills.filter((s) => !broadens(s));
  const broadening = p.skills.filter((s) => broadens(s));
  const total = new Set();
  for (const s of broadening) for (const id of sets.get(s)) total.add(id);
  // rank by # of (all) skills matched, like the UI's "matches" sort
  const score = (id) => p.skills.reduce((n, s) => n + (sets.get(s).has(id) ? 1 : 0), 0);
  const top = [...total].sort((a, b) => score(b) - score(a)).slice(0, 4);

  console.log(`\n${p.name} — ${p.role}`);
  console.log(`  skills: ${p.skills.join(", ")}`);
  if (refineOnly.length) console.log(`  refine-only (don't broaden): ${refineOnly.join(", ")}`);
  console.log(`  per-skill: ${p.skills.map((s) => `${s}=${sets.get(s).size}`).join("  ")}`);
  console.log(`  TOTAL matches: ${total.size}  (${((total.size / totalJobs) * 100).toFixed(2)}%)`);
  for (const id of top) {
    const j = byId.get(id);
    console.log(`     • [${score(id)} skills] ${j?.title}  — ${j?.company ?? j?.org ?? ""}`);
  }
  if (!top.length) console.log("     (no matches)");
}
