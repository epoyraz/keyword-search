# Skill matching — how "drop your CV" search works, and *why*

This document explains the keyword/skill matching system end to end so you can
work on it without reading every file. It is heavy on **rationale**: most of the
rules look arbitrary until you know the corpus they were tuned against.

> TL;DR — A CV (or typed tags) becomes a set of skills, OR-combined into a search
> over ~22k Swiss job postings. The hard part is **precision**: naïve matching
> made a real CV match **22% of the corpus**. A stack of deliberate rules
> (exact-token matching, short-skill and high-frequency "refine-only", multiword
> phrases, boundary-aware highlighting) brought that to **~3%** while keeping the
> top results relevant. Each rule below exists to kill a specific, measured class
> of false positive.

---

## 1. The corpus (read this first — it explains everything)

The index is **~22,003 Swiss job postings**, scraped from company career pages.
Two properties drive every design decision:

1. **Multilingual.** Postings are in **German, French, Italian, and English**,
   often mixed within one ad. A token that's a tech skill in one language is a
   common word in another.
2. **Gender-inclusive German.** Swiss German job ads use forms like
   `Mitarbeiter:in`, `Lernende:r`, `medizinische:r`. After tokenization these
   leave **stray single letters** (`r`, `in`) as standalone tokens.

Consequences you must internalize:

| Skill | Looks like | Actually matches in this corpus |
|---|---|---|
| `R` (language) | 1,332 jobs | German gender suffix: `medizinische ␣r␣ praxisassistent` |
| `C` (language) | 611 jobs | French elision `␣c'est`, driving licence `Kat.␣C`, permit `Bewilligung␣C`, `C-level` |
| `Go` (language) | 234 jobs | English verb `or ␣go␣ to`, `go-live` |
| `REST APIs` | 2,504 jobs | the token `rest` prefix-matches German **Restaurant** / `Rest` / `restlich` |
| `EFZ` (a real cert) | 2,642 jobs | the standard Swiss vocational certificate — on most ads, useless as a filter |
| `Betreuung` / `Verkauf` | 2,307 / 1,656 | generic German words spanning every sector |

None of these are bugs you can fix by "matching better" — they're genuine token
occurrences. The system's job is to decide which skills are *specific enough to
include a job* vs. only *refine ranking*.

---

## 2. The pipeline (end to end)

```
PDF CV ──readPdfText──▶ raw text ──extractSkills──▶ skill tags ─┐
                                                                ├─buildSkillQuery──▶ query string
typed input / "Add skill" ─────────────────────────────────────┘
                                                                       │
                                                                       ▼
                          UI (app/page.tsx) ──postMessage──▶ Web Worker (lib/search.worker.ts)
                                                                       │  runs minisearch-wasm
                                                                       ▼
                                              SearchOutcome { hits, total, ms, refineOnly }
                                                                       │
                                  app/page.tsx renders results + highlights (lib/highlight.tsx)
```

- **`lib/readPdfText.ts`** — pdf.js in the browser → plain text (lines grouped by
  y-coordinate to keep reading order).
- **`lib/skillExtraction.ts`** — `extractSkills(text)` matches a hardcoded
  **catalog** (≈130 entries, *tech-heavy*) plus free-form "Skills:" sections.
  Returns up to 40 scored `{name, category, score}`. **Caveat:** the catalog is
  tech-focused, so a Pflege/Bau CV extracts little — non-tech personas are tested
  by feeding skills directly (see §11), not by dropping a PDF.
- **`app/page.tsx::buildSkillQuery(skills)`** — joins tags into the worker query.
  Single-word → bare term; multiword → quoted phrase; multiple → `OR`-joined.
  Example: `["Python","Machine Learning","C"]` → `Python OR "Machine Learning" OR C`.
- **`lib/search.worker.ts::search()`** — all matching logic. Runs in a Web Worker
  so the main thread never blocks.
- **`lib/highlight.tsx`** — wraps matched terms in `<mark>` and builds snippets.

---

## 3. The engine: minisearch-wasm

`minisearch-wasm` (authored in-house; sibling repo) is a Rust/WASM full-text
engine, API-compatible with [MiniSearch]. The index is **prebuilt at image-build
time** (`npm run index`) and loaded in the worker via `loadBytes`.

Two query methods, and the difference is load-bearing:

- **`searchJoined(query, orMode)`** — the fast path. Everything (tokenize,
  prefix/fuzzy, BM25) runs in WASM; results come back **columnar**
  (`{count, ids, scores, terms}`). Uses the index's **baked-in search options**:
  `prefix: true, fuzzy: 0.2, combineWith: "AND"` (see `lib/searchConfig.mjs`).
  You **cannot** override prefix/fuzzy per call here.
- **`search(query, options)`** — MiniSearch-compatible; accepts a **per-call
  options object** (`{prefix, fuzzy, combineWith}`) and returns full objects.
  Slower per the README, but it's the only way to get **exact** (prefix-off,
  fuzzy-off) matching. We use it for short tokens and phrases.

### The single most important fact: `ts` = matched **index** terms

`searchJoined` returns, per job, the list of **index terms that actually
matched** — *not* the query token. For query `java` with `prefix:true`:

- a job containing `java` → its `terms` (we call it `ts`) includes `"java"`
- a job containing only `javascript` → `ts` includes `"javascript"`, **not** `"java"`
- a fuzzy hit `react`→`reach` → `ts` includes `"reach"`

This is what makes exact matching **free**: `ts.has("java")` is true *only* for
jobs with the exact token. We never pay for an extra search to get exactness — we
just read it off the prefix/fuzzy result we already have. The same trick gives us
**document frequency for free** (§6.4).

---

## 4. Tokenization & boundaries (the shared vocabulary)

`lib/searchConfig.mjs`:

```js
const TOKEN_SEPARATOR = /[^\p{L}\p{N}+#.]+/u;   // split on non-token chars
tokenize(text)   // → array of tokens
processTerm(t)   // lowercase; strip trailing dots; keep leading "." (.NET) and #,+
```

A **token char** is a unicode letter/digit or one of `+ # .` — chosen so `C#`,
`C++`, `.NET`, `node.js` survive as single tokens. Everything else (space, comma,
hyphen, colon, apostrophe, slash…) is a separator. This is why `C#`→`c#`,
`CI/CD`→`ci`+`cd`, `c'est`→`c`+`est`.

`lib/termMatch.mjs` is the **shared boundary helper** (imported by the worker, the
highlighter, and the test scripts so they can never drift):

```js
isShortAlphaTerm(t)  // /^\p{L}{1,2}$/u — purely 1–2 letters (C, R, Go, AI)
buildBoundaryRegex(terms)  // (?<![\p{L}\p{N}+#.])(term)(?![…])  — whole-token match
boundedMatch(text, term)   // boolean, case-insensitive whole-token test
```

The boundary regex mirrors `TOKEN_SEPARATOR` exactly: a term matches only when the
chars around it are **not** token chars (so `C` matches `␣C,` but not `Cruise`).

---

## 5. AND vs OR (worker query modes)

`parseAdvanced()` in the worker turns the query string into clauses and a mode:

- **OR mode** — set when the query contains an `OR` token. This is the **CV / multi
  skill** path (`buildSkillQuery` OR-joins ≥2 skills). "Match *any* skill."
- **AND mode** — the default (no `OR`). A single skill, or an advanced typed query
  like `python kubernetes`. "Match *all* clauses."

Clause kinds (the `Clause` interface):
- **term** — a bare word (e.g. `Python`, `C`).
- **phrase** — quoted, i.e. a multiword skill (e.g. `"Machine Learning"`).
- **prefix** — a term ending in `*`; this is the **live, in-progress typed term**
  (§6.6). Everything else matches exactly.
- plus `field:value`, `-exclude`, `NOT` (advanced operators, unchanged).

---

## 6. The matching rules (what, why, where)

All of these live in `lib/search.worker.ts::search()`. Read them as a stack of
filters that decide, for the OR (CV) case, **which skills broaden the result set**
vs. **only refine it**, and then which jobs qualify.

### 6.1 Committed skills match as EXACT tokens

**What.** A committed skill matches a job only if the job contains its exact
token: `committedOk(toks) = toks.every(t => ts.has(t))` (short tokens use an exact
set instead — §6.2). No prefix, no fuzzy.

**Why.** With the index's baked-in `prefix:true, fuzzy:0.2`, naïve matching pulled
in the wrong skill or pure noise:
- `java` → **javascript** (prefix) — JS jobs polluting a Java search
- `agile` → **agilen** (prefix, German declension) — chocolatiers, geology interns
- `react` → **reach** (fuzzy) — "reach new heights" in sales ads
- `java` → **JVA** (fuzzy) — Swiss prison administration

Requiring `ts.has(exactToken)` drops all of these at once: a fuzzy `reach` or a
prefix `javascript` is simply not the token `java`. Measured: the bottom 200 of a
CV's results were **100% prefix/fuzzy expansions with no exact match** ("chip-less"
jobs); exact matching removed ~290 of them (1,021 → 730 on the test CV) and
guarantees **every result shows at least one skill chip**.

**Cost.** Free — `ts.has` reads the existing `searchJoined` output (§3). The only
recall trade-off is spelling variants (a job that writes `ReactJS` but never
`React`); acceptable, and the catalog already stores such aliases if needed.

### 6.2 Short skills (1–2 letters) are refine-only

**What.** `isShortAlphaTerm` skills (`C`, `R`, `Go`, `AI`, and any all-short skill
like `CI/CD`→`ci`+`cd`) **never broaden** the result set. They still **label and
rank** a job that some longer skill already matched. Short tokens are resolved to
their exact doc set via `mini.search(t, {prefix:false, fuzzy:false})` (because
`prefix:true` would make a one-letter token flood ~14k jobs — and that prefix
traversal also dominated search time).

**Why.** Per §1, in this corpus a lone `R`/`C`/`Go` is almost always a gender
suffix / French elision / English verb — **lexically indistinguishable** from the
language. A boundary rule can't separate `experience in C and Python` from
`medizinische r` (both are `space-letter-space`). Data: `R`=1,332, `C`=611,
`Go`=234 matches, virtually all false. The signal that *does* separate them is
**corroboration**: a real C/R/Go job also mentions other tech, so we let short
skills refine but not include.

> A boundary rule **is** still applied (whole-token), so `Client`/`Cruise` never
> match `C`. The refine-only rule is on top of that, for the *real* standalone
> tokens a boundary rule can't filter.

### 6.3 Multiword skills match as a unit (phrases)

**What.** A multiword skill (quoted → phrase clause) is resolved via
`mini.search(value, {prefix:false, fuzzy:false, combineWith:"AND"})` →
`phraseHits` (jobs containing **all** its tokens, exactly). Its tokens are kept
**out** of the `searchJoined` query. (In AND mode it additionally confirms
adjacency via substring, preserving quoted-phrase semantics for advanced users.)

**Why.** `REST APIs` was OR-split into `rest`+`apis`, and `rest` prefix-matched
German **Restaurant** — **2,504 jobs**. (OR mode never enforced phrase adjacency,
and the tokens prefix-flooded.) Matching the phrase as exact co-occurring tokens:
**2,504 → 20**. Same fix took `GitHub Actions` (via `actions`) from 448 → 7.

### 6.4 Specificity gate (IDF) — corpus-flooding skills are refine-only

**What.** A skill is also refine-only if its **document frequency** exceeds a
threshold: `maxBroadDf = floor(totalJobs * 0.06)` (≈6%, ~1,320 jobs). DF is read
straight off the matched-terms:

```js
const df = new Map();
for (const { terms } of wasmHits.values())
  for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
tokenBroadens(t)  = !isShortAlphaTerm(t) && (df.get(t) ?? 0) <= maxBroadDf
phraseBroadens(v) = (phraseHits.get(v)?.size ?? 0)        <= maxBroadDf
```

**Why.** The short-skill rule is *length*-based; some flooders are long. The Swiss
credential `EFZ` (2,642 / 12%), `Betreuung` (2,307 / 10.5%), `Verkauf` (1,656 /
7.5%) sit on a huge share of postings and are the non-tech twin of "Agile" in
tech. Measured on the personas: **Pflege 23% → 4.7%, Bau 12.7% → 1.1%,
Detailhandel ~10% → ~5%**, while every persona keeps a spot-on #1 result. Tech CVs
are unaffected (no tech skill exceeds 6%). **Free** — DF comes from the same WASM
result. `0.06` is a tunable knob (§9).

### 6.5 `someBroadens` — at least one clause must broaden (monotonicity)

**What.** A job can only qualify if **≥1 clause broadens** (a non-short,
non-flooding token; a non-flooding phrase; or the live term). Enforced in both AND
and OR.

**Why.** Two reasons:
1. **Consistency.** Without it, a *single* refine-only skill (single skill →
   AND mode) skipped the gate: `EFZ` alone returned 2,642 while `Go` alone
   returned 0. Now both return 0 + the hint.
2. **Monotonicity.** Earlier, a short skill broadened when it was the *only* skill
   (a fallback), so adding a normal skill could **drop** the count
   (`Go` 234 → `Go`+`Docker` 64). Removing that fallback + `someBroadens` means
   **adding a skill never reduces results** — the intuitive OR behavior.

A query of only refine-only skills (a lone `EFZ`, or `C R`) therefore returns
nothing **by design**, which is surfaced (§6.8) rather than shown as a bare "no
matches".

### 6.6 Live search-as-you-type (the trailing `*`)

**What.** `app/page.tsx` folds the **debounced** (120 ms) in-progress input into
the query as one more term, marked with a trailing `*`:
`buildSkillQuery([...skills, liveTerm + "*"])`. `parseAdvanced` strips the `*` and
flags the clause `prefix`. The worker matches a prefix clause by **prefix**
(`ts.some(x => x.startsWith(t))`, fuzzy off) so typing `kube` finds Kubernetes
*before* the word is complete. Pressing Enter "pins" the term as an exact
committed tag.

**Why.** A prior "skill-tag" rewrite (commit `276ba4e`, before this work) deleted
the original `useDebounced` live search; results only updated on Enter. This
restores live filtering **without** reintroducing the precision problems —
committed skills stay exact, only the single in-progress term is prefix-matched
(and it's transient). Verified: typing `kube` → 89, `pyth` → 217 live.

### 6.7 Highlighting is boundary-aware whole-token

**What.** `lib/highlight.tsx::highlight()` builds a boundary regex
(`buildBoundaryRegex`) and only `<mark>`s whole-token matches. `snippet()` centres
the excerpt on the first bounded occurrence.

**Why.** The old highlighter was plain substring (`/(C|R)/gi`) — it marked *every*
`c` and `r` on the page (inside `Cruise`, `JavaScript`, …). Boundary-aware
highlighting marks a standalone `C` but never the `c` in `Cruise`, and `Java`
never lights up inside `JavaScript`. (Browser note: uses regex look-behind, so
Safari ≥16.4.)

### 6.8 `refineOnly` in the outcome + empty-state hint

**What.** `SearchOutcome.refineOnly: string[]` lists the committed skills the
worker treated as refine-only (short or high-DF). `app/page.tsx` uses it: when all
committed skills are refine-only and nothing is typed, the empty state shows
*"X only refine ranking — add a more specific skill to see matches"* instead of a
bare "no matches".

**Why.** §6.5 means some queries legitimately return 0; without an explanation it
looks broken. The worker is the source of truth (it knows DF), so it reports the
list rather than the UI re-deriving it (the UI has no corpus frequencies).

---

## 7. The qualification algorithm (pseudocode)

For each candidate job (OR mode is the CV case):

```
ts            = matched index terms for this job (from searchJoined)
committedOk(clause) = every token exact: short→exactSet, normal→ts.has(token)
broadeningClauseMatched =
      some committed clause whose token BROADENS (not short, df ≤ 6%) AND committedOk
   || some phrase that BROADENS (phraseHits size ≤ 6%) AND job ∈ phraseHits
   || liveTerm matches by prefix
qualifies = someBroadens (query-level guard) AND
            (OR:  broadeningClauseMatched)
            (AND: every clause committedOk AND liveOk)
            combined with field clauses, minus NOT/exclusions
labels (chips) = every committed clause / phrase that matched (incl. refine-only)
```

Key invariants:
- **Every shown result has ≥1 skill chip.**
- **Adding a skill never lowers the count** (monotonic OR).
- **Refine-only skills label & rank but never include a job alone.**

---

## 8. File map

| File | Responsibility |
|---|---|
| `lib/searchConfig.mjs` | tokenizer + baked search options (`prefix/fuzzy/boost`); shared build+runtime |
| `lib/termMatch.mjs` | `isShortAlphaTerm`, boundary regex, `boundedMatch` (shared everywhere) |
| `lib/search.worker.ts` | **all** matching logic: parse, exact/short/phrase/DF gates, qualify, rank |
| `lib/highlight.tsx` | boundary-aware `<mark>` + snippet |
| `lib/types.ts` | `SearchOutcome` (incl. `refineOnly`), `Job`, `Hit`, worker protocol |
| `lib/skillExtraction.ts` | CV text → catalog skill tags |
| `lib/searchClient.ts` | main-thread ↔ worker bridge |
| `app/page.tsx` | tags, `buildSkillQuery`, live `*` term, debounce, empty-state hint, render |
| `scripts/*` | diagnostics + tests (§11) |

---

## 9. Tuning knobs

- **`lib/search.worker.ts` `maxBroadDf = floor(jobs.length * 0.06)`** — the
  specificity threshold. Lower → more skills become refine-only (tighter). The one
  outlier persona (Sofia, 7.1%) drops if you go to 5%. Could be promoted to an env
  var if you want to experiment.
- **`lib/searchConfig.mjs` `fuzzy: 0.2`** — baked into the index, so it only
  affects `searchJoined`. Committed/short/phrase matching ignores it (exact). It
  still benefits the live prefix term indirectly; leaving it is fine.
- **`isShortAlphaTerm` = 1–2 letters** — the length cutoff for refine-only.
- **Debounce `120` ms** in `app/page.tsx`.

---

## 10. The journey (what each rule bought, on the real test CV)

| State | Result count | % of corpus |
|---|---:|---:|
| Naïve (substring highlight + prefix/fuzzy OR) | 4,843 | 22.0% |
| + multiword phrases (REST APIs fix) | 2,965 | 13.5% |
| + short skills refine-only | 1,021 | 4.6% |
| + exact-token committed matching | 730 | 3.3% |
| + specificity (IDF) gate | ~673 | ~3.1% |

Non-tech personas validated the generalization (every profession surfaces a
correct #1 match): see §11.

---

## 11. Diagnostics & tests (run these, don't guess)

- **`npm run test:match`** — `scripts/test-term-matching.mjs`, 33 deterministic
  cases for the boundary/short-term helpers (C, R, C#, Go, Java vs JavaScript,
  Cruise, …). No data files needed.
- **`node scripts/cv-search-sim.mjs [pdf]`** — headless "drop your CV" simulator:
  full pipeline + per-skill breakdown + ≥N-skill histogram. Defaults to
  `private/cv.pdf` (gitignored).
- **`node scripts/cv-tail-audit.mjs [N]`** — faithful worker replica; ranks the
  result set like the UI, dumps the weakest N with the skill that dragged each in.
  How the prefix/fuzzy false positives were found.
- **`node scripts/personas-test.mjs`** — 18 synthetic personas (`scripts/personas.mjs`,
  3 each across Pflege/Bau/Ärzte/Detailhandel/Sachbearbeiter/Elektrotechnik) with
  realistic Swiss-German skills; reports match counts + top titles per profession.
  Use this to regression-check any matching change against non-tech sectors.

> The `scripts/*` diagnostics each re-implement the worker's OR-mode qualification
> (exact + short-refine + DF gate). **If you change the worker's matching, update
> the scripts too** or they'll silently disagree (there's a comment in each).

---

## 12. Gotchas & edge cases

- **`searchJoined` cannot disable prefix/fuzzy** — it's baked into the index.
  Exactness comes from `mini.search(..., {prefix:false, fuzzy:false})` or from
  filtering `ts` (the free trick). Don't try to "turn off prefix" on `searchJoined`.
- **`ts` holds index terms, not query terms.** This is the crux; re-read §3 if a
  matched/labeling/DF change behaves oddly.
- **`CI/CD` is two short tokens** (`ci`+`cd`) → all-short → refine-only. A
  per-skill classifier that only checks "single token" mis-handles it; classify by
  *tokens*, not by skill string (this bit the sim twice).
- **Single skill = AND mode.** `buildSkillQuery` can't `OR` one term, so a lone
  skill goes through AND. `someBroadens` (§6.5) is what keeps a lone refine-only
  skill consistent with the multi-skill case.
- **Description text is lazy.** `jobs.json` is metadata-only; descriptions load on
  demand (`/dl/desc`). Phrase adjacency (AND mode) is the main path that fetches
  them — OR-mode skill search stays fetch-free and fast.
- **Catalog is tech-heavy.** `extractSkills` won't pull Pflege/Bau skills from a
  PDF. That's a known gap, separate from matching; the personas test the matcher
  by feeding skills directly.

---

## 13. Glossary

- **broaden** — a skill that can *include* a job in the result set on its own.
- **refine-only** — a skill that only affects ranking/highlighting (chips), never
  inclusion. Short skills + high-DF skills.
- **`ts`** — the set of index terms `searchJoined` reports as matched for a job.
- **DF (document frequency)** — how many jobs contain a token exactly.
- **chip** — a matched-skill tag shown on a result; `Hit.matched`.
- **live term** — the in-progress typed text, prefix-matched (trailing `*`), not
  yet pinned as a committed tag.

[MiniSearch]: https://github.com/lucaong/minisearch
