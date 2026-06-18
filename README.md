# keyword-search

A fully local, instant keyword search over scraped company job postings — like
[HN Algolia search](https://hn.algolia.com/), but with **no web API**. The data,
the index, and the search all live in the browser; the only network requests are
static files from `public/`.

## How it works

1. **Indexing** (`npm run index`) — `scripts/build-index.mjs` walks
   `../jobboard-data/details/<Company>/*.html`, parses the embedded
   `application/ld+json` JobPosting block (falling back to OpenGraph meta tags),
   repairs the encoding (mojibake + HTML entities), strips tags, dedupes, and
   writes three files: `public/jobs.json` (the doc store), a **prebuilt
   serialized [MiniSearch](https://github.com/lucaong/minisearch) index**
   (`public/search-index.json`), and a tiny `public/search-meta.json`
   (filter stats + a content-hash version).

2. **Search** (`lib/search.worker.ts`) — a **Web Worker** fetches the doc store
   + prebuilt index and deserializes via `MiniSearch.loadJSON` (much cheaper
   than rebuilding), then answers queries off the main thread, so the page never
   freezes. The big assets are fetched with a `?v=<hash>` query and served
   `immutable`, so repeat visits load from cache with no re-download.
   `lib/searchConfig.mjs` holds the tokenizer shared by build and runtime so the
   two stay in lockstep. Queries resolve in well under a millisecond.

3. **UI** (`app/page.tsx`) — search-as-you-type with matched-term highlighting,
   context snippets, sort by relevance / matches / date, company /
   employment-type / recency filters, matched-skill tags, a live result count +
   timing, and "show more" pagination. The query, sort, and filters are synced
   to the URL so any search is shareable. An empty query browses everything
   (newest first).

## Search syntax

| Syntax | Meaning |
|---|---|
| `a b` | AND — both terms must match (default) |
| `a OR b` | OR — either term matches |
| `"machine learning"` | exact phrase |
| `-intern` / `NOT intern` | exclude |
| `title:engineer` | scope to a field: `title`, `company`, `location`, `type`, `desc` |
| `company:"Insel Gruppe"` | scoped exact phrase |

The tokenizer preserves `C#`, `.NET`, `node.js`, `C++`. Combine freely, e.g.
`react OR vue -senior` or `company:Roche python`.

## Usage

```bash
npm install
npm run index   # build public/jobs.json from the scraped HTML (re-run when data changes)
npm run dev     # http://localhost:3000
```

For a production build: `npm run build && npm start`.

## Notes

- The index is regenerated only by `npm run index`, so the search UI never
  touches the raw HTML at runtime.
- Postings without a canonical URL render as plain (non-linked) titles;
  postings without a date sort last.
