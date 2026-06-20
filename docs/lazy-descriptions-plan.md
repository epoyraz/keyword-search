# Lazy descriptions — smaller download / faster cold start

> Status: **planned, not implemented** (deferred to a later session).
> Decision locked in: advanced operators stay **exact**, fetching descriptions **on demand**.

## Context — why do this
`public/jobs.json` is **38 MB raw** and is fetched + `JSON.parse`-d by the search worker on every page load. Measured: **22,028 entries, avg description 1,445 chars, max 196,423 chars — ~32 MB of the 38 MB is descriptions.** Everything else (title/company/org/location/url/dates) is tiny.

The browser only ever shows ~30 previews at a time, yet it downloads and parses all 22k full descriptions up front. Goal: **smaller download + faster cold start**, with **search correctness fully preserved** (including the advertised advanced operators).

Key fact that makes this safe: **the wasm index (`search-index.bin`) already tokenizes the full description** (`SEARCH_FIELDS` in `lib/searchConfig.mjs` includes `"description"`). So term/BM25 search over descriptions works **without shipping raw text** — the raw text is only needed for *display* and a few *advanced operators*.

## Where raw `description` is read at runtime (verified)
- **Preview snippets** — `app/page.tsx` (~line 603) and `app/benchmark/ResultPanel.tsx` (~line 97): `highlight(snippet(hit.description, hit.terms), …)`, only for the displayed slice `hits.slice(0, limit)`. `hit.description` comes from the `...job` spread in the worker.
- **Advanced operators in `lib/search.worker.ts`:**
  - quoted-phrase adjacency: `searchableText(job)` (includes description), `~line 272`, runs only when the query has quoted phrases in AND mode.
  - field clauses `desc:`/`description:` and negation/unscoped clauses: `clauseMatches()` over `ALL_TEXT_FIELDS` (includes description).
- **Plain multi-word term queries do NOT read raw description** (handled entirely by the wasm index). This is the common case.

## Build + serve pipeline (verified)
- `scripts/build-index.mjs` → `toJob()` includes `description`; `writeVariants()` writes `jobs.json` + `.gz`/`.br`; `buildRustIndex()` (in `scripts/build-rust-index.mjs`) builds `search-index.bin` from the **full** docs and computes `version = sha1(bytes).slice(0,12)`; writes `search-meta.json` `{total, companies, cities, topCityCount, version}`.
- `app/dl/[file]/route.ts` → `CONTENT_TYPES` map, brotli/gzip negotiation from precompressed siblings, `Cache-Control: public, max-age=31536000, immutable`. New files just need a `CONTENT_TYPES` entry + variants.
- Versioning: `?v=<version>` from `search-meta.json`, read in `app/layout.tsx` (preloads) and passed to the worker via `searchClient.ts`.

## Design (decision: exact behavior, fetch descriptions on demand)
1. **Build (`scripts/build-index.mjs`)**
   - Keep building the index from FULL docs → `search-index.bin` unchanged (still fully searchable, incl. descriptions).
   - Write `jobs.json` **without** `description` (metadata only): `id, title, company, org, location, employmentType, datePosted, validThrough, url`. Expect ~3–4 MB raw / ~0.5 MB br.
   - Write descriptions separately for id-keyed serving — recommended `public/descriptions.json` as `{ id: description }`. (Still publicly reachable as a whole file — acceptable, the data was public before; clients fetch slices.)
   - `search-meta.json` unchanged; reuse `version` to cache-bust description fetches.
2. **Serve descriptions — new `app/dl/desc/route.ts`**
   - `GET /dl/desc?ids=a,b,c&v=<version>` → `{ "a": "…", "b": "…" }`.
   - Load `descriptions.json` once into a module-scope cache (same pattern as `layout.tsx` reading `search-meta.json`).
   - gzip/br the response per `accept-encoding`; `Cache-Control: public, max-age=31536000, immutable`.
   - Memory: ~80 MB parsed in the Node server → bump Cloud Run `--memory` to `1Gi` if needed.
3. **Types (`lib/types.ts`)** — make `Job.description` optional; `Hit.description` optional.
4. **Worker (`lib/search.worker.ts`) — preserve EXACT semantics, lazy-provide text**
   - `jobs`/`byId` no longer carry `description`.
   - Add a worker description cache `Map<id,string>` + `async fetchDescriptions(ids)` that batches `GET /dl/desc`.
   - Detect when a query needs raw description (any quoted free-text phrase, any negative clause, any clause targeting description, OR-mode unscoped field clauses). When needed: compute the candidate `universe` (as today), fetch missing descriptions for it (batched), populate the cache, then run the **existing** post-filter logic unchanged. `search()` becomes staged/async for those queries; keep stale-response cancellation working.
   - Common path (plain/empty/term, no advanced op) fetches **no** descriptions in the worker.
   - Return hits **without** `description` (UI fetches for display).
5. **UI (`app/page.tsx`)**
   - For the displayed slice, batch-fetch descriptions (`/dl/desc`) for ids missing text, cache in a `Map`, render snippet; show a 1-line skeleton until loaded. Re-fetch for new ids on "Show more".
   - Reuse `lib/highlight.tsx` `snippet()`/`highlight()` unchanged once text is present.
6. **Shared fetch (`lib/searchClient.ts`)** — a `fetchDescriptions(ids)` helper shared by UI + worker (or via the worker protocol).
7. **Benchmark (dev/localhost only — `app/benchmark/*`, `lib/benchEngine.ts`)** — the in-browser JS MiniSearch (`addAll(jobs)`) needs full descriptions to index. Have `loadEngines()` fetch the full `descriptions.json` and merge before `addAll`, so JS-vs-wasm parity holds. Not a production concern (route is localhost-gated).
8. **Deploy (`Dockerfile` / `DEPLOY.md`)** — ensure the descriptions file ships; bump memory if needed.

## Expected result
- Cold download ~8 MB br → **~3.8 MB br** (index 3.3 MB + metadata ~0.5 MB).
- `JSON.parse` 38 MB → ~4 MB. Much faster cold start.
- Previews: **+~42 KB/page** lazy (30 × ~1.4 KB).
- Advanced queries: identical results, with an on-demand (cached) description fetch.

## Verification
- `npm run index` → confirm `jobs.json` has no descriptions; `descriptions.json` exists.
- `npm run build && npm run dev` → load `/`; Network shows small `jobs.json` + lazy `/dl/desc` for previews; "Show more" fetches the next page.
- Compare advanced queries (`"exact phrase"`, `-exclude`, `desc:term`) against the current full-desc build — results must match.
- `/benchmark` (localhost) still shows identical JS-vs-wasm results.
- Deploy; `/` loads fast; `/benchmark` 404s in prod.

## Risks / notes
- Worker `search()` becomes async for advanced queries — keep stale-request cancellation intact.
- `descriptions.json` in server memory (~80 MB) — watch Cloud Run memory (→ `1Gi`).
- Broad advanced queries (e.g. `term -exclude`) may fetch many descriptions (cached for the session) — accepted per the "exact, fetch on demand" decision.
- The proper long-term fix for phrases without any fetch is a **positional wasm index** (bigger engine change, future `minisearch-wasm` version) — out of scope here.
