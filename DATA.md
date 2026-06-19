# Data pipeline

keyword-search is a fully static, client-side search over a baked dataset. The
data comes from the **jobboard-data detail scraper**, not from this repo.

## Source

`https://storage.googleapis.com/jobboard-data-exports/latest/job_details.json`
— a minified, gzip array of job-detail rows produced daily by
`jobboard-data/detail_runner.py` (the `jobboard-details` Cloud Run Job, 03:00 UTC).
Each row: `jobId, company, title, url, city, description, employment_type,
date_posted, valid_through, hiring_organization`.

## Build (`npm run index`, at image-build time)

`scripts/build-index.mjs`:

1. Fetches `job_details.json` (override with `JOB_DETAILS_URL`).
2. Maps each row to the search `Job` shape and **cleans** the text
   (`lib/textClean.mjs`: mojibake repair, HTML-entity decode, tag strip).
3. **Drops junk**: some detail pages are PDFs/binary, so their scraped text is
   undecoded binary. `isGarbage()` blanks binary descriptions and excludes
   content-less entries (no real title and no description).
4. Writes `public/jobs.json` (+ `.gz`/`.br`) and `public/search-meta.json`
   (`total`, `companies`, ordered `cities` + `topCityCount`, content `version`).

No prebuilt search index is shipped — the Web Worker builds the wasm index in the
browser from `jobs.json` via `minisearch-wasm` `addAllJSON`.

## Serving

- `app/dl/[file]/route.ts` serves `public/jobs.json` with brotli/gzip negotiation
  (immutable; fetched with `?v=<version>`).
- `public/search-meta.json` is served fresh (no-cache) as the version pointer.

## Daily refresh (no manual step)

The dataset is baked into the image, so fresh data needs a rebuild. The
`keyword-search-deploy` Cloud Run Job (scheduler `keyword-search-daily-deploy`,
**`0 5 * * *` UTC**, 2h after the details scrape) rebuilds + redeploys:

- runs `deploy/cloudbuild-app.yaml`, which pulls the source snapshot
  `gs://jobboard-data-exports/deploy/keyword-search-src.tgz`, builds the image
  (the Dockerfile runs `npm run index`, pulling the latest `job_details.json`),
  and `gcloud run deploy`s it.

> **On code changes:** re-upload the source snapshot so the daily build picks
> them up (or point the build at a fresh `git clone` instead):
> ```bash
> tar czf src.tgz --exclude=node_modules --exclude=.next --exclude=.git \
>   --exclude='public/jobs.json*' --exclude=public/search-meta.json . && \
> gcloud storage cp src.tgz gs://jobboard-data-exports/deploy/keyword-search-src.tgz
> ```

## Manual deploy

```bash
gcloud run deploy keyword-search --source=. --region=europe-west1 \
  --project=poyraz-digital --allow-unauthenticated --port=8080 --memory=512Mi --cpu=1
```
