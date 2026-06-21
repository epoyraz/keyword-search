// Headless "drop your CV" simulator — reproduces the UI pipeline without a browser:
//   PDF -> text (readPdfText) -> extractSkills -> buildSkillQuery -> worker search
// and reports the total hit count plus a per-skill breakdown so we can see which
// extracted skills are inflating the result set.
//
// Usage: node scripts/cv-search-sim.mjs [path-to.pdf]   (default: private/cv.pdf)
//
// The CV lives under private/ (gitignored). This is a local diagnostic, not shipped.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import init, { MiniSearchWasm } from "minisearch-wasm";
import { tokenize, processTerm } from "../lib/searchConfig.mjs";
import { isShortAlphaTerm } from "../lib/termMatch.mjs";
import { extractSkills } from "../lib/skillExtraction.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CV = process.argv[2] || path.resolve(ROOT, "private", "cv.pdf");
const TOTAL_JOBS_HINT = 0;

// --- 1. PDF -> text (mirrors lib/readPdfText.ts line grouping) ----------------
async function readPdfText(file) {
  const data = new Uint8Array(await readFile(file));
  const pdf = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    const rows = content.items
      .flatMap((it) => (typeof it.str === "string" && it.str.trim() ? [{ text: it.str, x: it.transform?.[4] ?? 0, y: Math.round(it.transform?.[5] ?? 0) }] : []))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    let curY = null;
    for (const r of rows) {
      const last = lines.at(-1);
      if (!last || curY === null || Math.abs(curY - r.y) > 2) { lines.push(r.text); curY = r.y; }
      else lines[lines.length - 1] = `${last} ${r.text}`;
    }
    pages.push(lines.join("\n"));
  }
  return pages.join("\n");
}

// --- worker search replica (lib/search.worker.ts, OR mode, free-text only) -----
function makeSearcher(mini) {
  // Job-id set for ONE committed skill, mirroring lib/search.worker.ts: a skill
  // now matches as EXACT whole tokens (multiword = all its tokens, AND). No
  // prefix/fuzzy — that's reserved for the live in-progress term in the UI.
  return (skillName) =>
    new Set(
      mini
        .search(skillName, {
          prefix: false,
          fuzzy: false,
          combineWith: /\s/.test(skillName) ? "AND" : "OR",
        })
        .map((r) => r.id),
    );
}

// --- run ----------------------------------------------------------------------
const [text, indexBin, wasmBin] = await Promise.all([
  readPdfText(CV),
  readFile(path.resolve(ROOT, "public", "search-index.bin")),
  readFile(path.resolve(ROOT, "node_modules", "minisearch-wasm", "minisearch_wasm_bg.wasm")),
]);
await init({ module_or_path: wasmBin });
const mini = MiniSearchWasm.loadBytes(new Uint8Array(indexBin));
const totalJobs = TOTAL_JOBS_HINT || JSON.parse(await readFile(path.resolve(ROOT, "public", "jobs.json"))).length;
const searchIds = makeSearcher(mini);

const skills = extractSkills(text);
console.log(`CV: ${path.basename(CV)}  | text chars: ${text.length}  | corpus: ${totalJobs} jobs\n`);
console.log(`extractSkills → ${skills.length} skills (OR-combined):`);
console.log("  " + skills.map((s) => `${s.name}[${s.score}]`).join(", ") + "\n");

// Per-skill id sets under the current worker logic (multiword skills match as a
// unit; 1–2 letter skills don't broaden when a longer skill is present).
const isShortSkill = (name) => { const t = tokenize(name).map(processTerm).filter(Boolean); return t.length === 1 && isShortAlphaTerm(t[0]); };
const sets = new Map();
for (const s of skills) sets.set(s.name, searchIds(s.name));
const union = (ss) => { const u = new Set(); for (const s of ss) for (const id of s) u.add(id); return u; };

const longSkills = skills.filter((s) => !isShortSkill(s.name));
const shortSkills = skills.filter((s) => isShortSkill(s.name));
// Non-broadening: the result set is bounded by the longer skills; lone short
// skills only refine/rank within it (unless the query is entirely short skills).
const longUnion = union(longSkills.map((s) => sets.get(s.name)));
const total = longSkills.length ? longUnion : union(sets.values());

console.log(`short (refine-only) skills: ${shortSkills.map((s) => s.name).join(", ") || "(none)"}\n`);
console.log(`TOTAL results: ${total.size}  (${((total.size / totalJobs) * 100).toFixed(1)}% of corpus)\n`);

console.log("per-skill match counts (alone = jobs the skill matches; short skills don't broaden):");
console.log("  " + "skill".padEnd(20) + "alone".padStart(8) + "  %corpus".padStart(9));
const rows = [...skills].sort((a, b) => sets.get(b.name).size - sets.get(a.name).size);
for (const s of rows) {
  const n = sets.get(s.name).size;
  const tag = isShortSkill(s.name) ? "  ← refine-only" : "";
  console.log("  " + s.name.padEnd(20) + String(n).padStart(8) + "  " + ((n / totalJobs) * 100).toFixed(1).padStart(7) + "%" + tag);
}

// Among the qualifying jobs, how many skills (long + short) does each match? This
// is the signal a future ≥N-skills threshold (#2) would use to rank/trim further.
const perJob = new Map();
for (const id of total) {
  let c = 0;
  for (const set of sets.values()) if (set.has(id)) c++;
  perJob.set(id, c);
}
const atLeast = (n) => [...perJob.values()].filter((v) => v >= n).length;
console.log("\nqualifying jobs by # of skills matched (for a future ≥N-skills threshold):");
for (const n of [1, 2, 3, 4, 5]) console.log(`  ≥${n} skills: ${String(atLeast(n)).padStart(5)} jobs  (${((atLeast(n) / totalJobs) * 100).toFixed(1)}%)`);
