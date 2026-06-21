// Audit the weakest matches in the "drop your CV" result set — a FAITHFUL replica
// of lib/search.worker.ts (OR mode, token-level), so numbers match production.
// Ranks like the UI (matches desc, then date desc), takes the bottom N, and shows
// which skill dragged each job in + the matching context.
//
// Usage: node scripts/cv-tail-audit.mjs [N]   (default N=200)
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import init, { MiniSearchWasm } from "minisearch-wasm";
import { tokenize, processTerm } from "../lib/searchConfig.mjs";
import { isShortAlphaTerm } from "../lib/termMatch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const N = Number(process.argv[2] ?? 200);
const [indexBin, wasmBin, jobsRaw, descRaw] = await Promise.all([
  readFile(path.resolve(ROOT, "public", "search-index.bin")),
  readFile(path.resolve(ROOT, "node_modules", "minisearch-wasm", "minisearch_wasm_bg.wasm")),
  readFile(path.resolve(ROOT, "public", "jobs.json"), "utf8"),
  readFile(path.resolve(ROOT, "public", "descriptions.json"), "utf8"),
]);
await init({ module_or_path: wasmBin });
const mini = MiniSearchWasm.loadBytes(new Uint8Array(indexBin));
const byId = new Map(JSON.parse(jobsRaw).map((j) => [j.id, j]));
const desc = JSON.parse(descRaw);
const skills = ["R","Azure","Kubernetes","Next.js","TypeScript","C#","Flask",".NET","CI/CD","Python","Terraform","C","Docker","GitHub Actions","PostgreSQL","Scrum","Agile","Go","Java","MySQL","Node.js","React","REST APIs"];

// --- faithful worker replica (OR mode) ----------------------------------------
const decodeJoined = (r) => { const m = new Map(); if (!r.count) return m; const ids = r.ids.split("\n"); const rows = r.terms.split("\n"); for (let i = 0; i < r.count; i++) m.set(ids[i], rows[i] ? rows[i].split(" ") : []); return m; };
const termClauses = skills.filter((s) => !/\s/.test(s)).map((s) => ({ label: s, toks: tokenize(s).map(processTerm).filter(Boolean) }));
const phraseClauses = skills.filter((s) => /\s/.test(s)).map((s) => ({ label: s }));
const freeToks = termClauses.flatMap((c) => c.toks);
const shortQ = [...new Set(freeToks.filter(isShortAlphaTerm))];
const normalQ = freeToks.filter((t) => !isShortAlphaTerm(t));
const hasLong = normalQ.length > 0 || phraseClauses.length > 0;

const wasmHits = normalQ.length ? decodeJoined(mini.searchJoined(normalQ.join(" "), true)) : new Map();
const exactIds = new Map(shortQ.map((t) => [t, new Set(mini.search(t, { prefix: false, fuzzy: false, combineWith: "OR" }).map((r) => r.id))]));
const phraseHits = new Map(phraseClauses.map((c) => [c.label, new Set(mini.search(c.label, { prefix: false, fuzzy: false, combineWith: "AND" }).map((r) => r.id))]));
const shortMatch = (id, t) => exactIds.get(t)?.has(id) ?? false;

const universe = new Set(wasmHits.keys());
for (const s of phraseHits.values()) for (const id of s) universe.add(id);
if (!hasLong) for (const s of exactIds.values()) for (const id of s) universe.add(id);

const rows = [];
for (const id of universe) {
  const inWasm = wasmHits.has(id);
  const ts = new Set(wasmHits.get(id) ?? []);
  const corroborated = inWasm || phraseClauses.some((c) => phraseHits.get(c.label).has(id));
  const qualifies = corroborated || (!hasLong && shortQ.some((t) => shortMatch(id, t)));
  if (!qualifies) continue;
  const matched = [];
  for (const c of termClauses) if (c.toks.length && c.toks.every((t) => (isShortAlphaTerm(t) ? shortMatch(id, t) : ts.has(t)))) matched.push(c.label);
  for (const c of phraseClauses) if (phraseHits.get(c.label).has(id)) matched.push(c.label);
  const j = byId.get(id);
  rows.push({ id, matched, title: j?.title ?? "", company: j?.company ?? j?.org ?? "", date: (j?.datePosted && j.datePosted !== "null") ? j.datePosted : "" });
}
rows.sort((a, b) => b.matched.length - a.matched.length || b.date.localeCompare(a.date));
const withChip = rows.filter((r) => r.matched.length > 0).length;
console.log(`TRUE qualifying total (current, prefix+fuzzy): ${rows.length}`);
console.log(`  jobs with ZERO skill chips (prefix/fuzzy only): ${rows.length - withChip}`);
console.log(`  projected total if skills match EXACT tokens (≥1 chip): ${withChip}  (${(withChip / 22003 * 100).toFixed(1)}%)`);

const tail = rows.slice(-N);
const cnt = new Map();
for (const r of tail) cnt.set(r.matched.length, (cnt.get(r.matched.length) ?? 0) + 1);
console.log(`auditing LAST ${tail.length} | match-count: ` + [...cnt.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}-skill:${v}`).join("  "));

// 0-chip jobs qualified via a normal skill's prefix/fuzzy expansion. Attribute
// each to the causing skill: an index term x is a prefix hit on token t if
// x.startsWith(t); otherwise it's a fuzzy hit (no query token is its prefix).
const tokToSkill = new Map();
for (const c of termClauses) for (const t of c.toks) if (!isShortAlphaTerm(t)) tokToSkill.set(t, c.label);
const reasonsOf = (id) => {
  const causes = new Set();
  for (const x of new Set(wasmHits.get(id) ?? [])) {
    const t = normalQ.find((t) => x.startsWith(t));
    causes.add(t ? `${tokToSkill.get(t)} (prefix)` : "(fuzzy)");
  }
  return causes;
};
const reasonCount = new Map();
const samplesByReason = new Map();
for (const r of tail) {
  const keys = r.matched.length ? new Set(["(has chip)"]) : reasonsOf(r.id);
  for (const k of keys) {
    reasonCount.set(k, (reasonCount.get(k) ?? 0) + 1);
    if (!samplesByReason.has(k)) samplesByReason.set(k, []);
    if (samplesByReason.get(k).length < 8) samplesByReason.get(k).push(r);
  }
}
console.log("\n0-chip tail jobs by causing skill (prefix/fuzzy expansion, no exact chip):");
for (const [k, n] of [...reasonCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(18)} ${n}`);

const ctxFor = (id) => {
  const text = `${byId.get(id)?.title ?? ""}. ${desc[id] ?? ""}`;
  const low = text.toLowerCase();
  for (const x of new Set(wasmHits.get(id) ?? [])) { const i = low.indexOf(x); if (i >= 0) return `[${x}] …` + text.slice(Math.max(0, i - 25), Math.min(text.length, i + x.length + 30)).replace(/\s+/g, " ").trim() + "…"; }
  return "(no context)";
};
console.log("\nsamples per causing skill (title — [matched index term] context):");
for (const [k] of [...reasonCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`\n### ${k}`);
  for (const r of (samplesByReason.get(k) ?? []).slice(0, 8)) {
    console.log(`  • ${r.title}  [${r.company}]`);
    console.log(`      ${ctxFor(r.id)}`);
  }
}
await writeFile(path.resolve(ROOT, "private", "cv-tail.txt"), tail.map((r) => `${String(r.matched.length).padStart(2)}  ${r.matched.join(", ").padEnd(36)}  ${r.title}  [${r.company}]`).join("\n"));
console.log(`\nfull bottom-${N} → private/cv-tail.txt`);
