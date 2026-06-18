# keyword-search

A fully local, instant keyword search over scraped company job postings — like
[HN Algolia search](https://hn.algolia.com/), but with **no web API**. The data,
the index, and the search all live on your machine; the only network request is
fetching a single static JSON file from `public/`.

## How it works

1. **Indexing** (`npm run index`) — `scripts/build-index.mjs` walks
   `../jobboard-data/details/<Company>/*.html`, parses the embedded
   `application/ld+json` JobPosting block (falling back to OpenGraph meta tags),
   repairs the mojibake text encoding, dedupes, and writes a compact
   `public/jobs.json` (~19 MB for ~10.5k postings across 50 companies).

2. **Search** (`lib/search.ts`) — in the browser, the app loads `jobs.json` once
   and builds an in-memory [MiniSearch](https://github.com/lucaong/minisearch)
   full-text index over title / description / company / location. Queries run
   client-side in well under a millisecond. No server, no external API.

3. **UI** (`app/page.tsx`) — search-as-you-type with matched-term highlighting,
   context snippets, sort by relevance or date, company / employment-type
   filters, a live result count + timing, and "show more" pagination. An empty
   query browses everything (newest first).

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
