# Deploy to Google Cloud Run

Source-deploy this Next.js app to Cloud Run in the `poyraz-digital` project
(region `europe-west1`) and map it to `keyword-search.poyraz.digital`. Same
pattern as `ingredients-search` (npm + Next.js `standalone` + `public/`).

## Files in the repo

- `Dockerfile` — multi-stage `deps` → `builder` → `runner`, all
  `node:22-alpine`. Builds the Next.js `standalone` output and runs
  `node server.js` on port 8080. Copies `public/` so `jobs.json` (the
  client-fetched search index) ships in the image.
- `next.config.ts` — `output: "standalone"` plus `outputFileTracingRoot`
  pinned to this dir (parent dirs contain other lockfiles).
- `.gcloudignore` — keeps `node_modules`, `.next`, VCS, and env files out of
  the upload; `public/jobs.json` is kept.

## Regenerate the index (when the source data changes)

```bash
npm run index   # parses ../jobboard-data/details/**/*.html -> public/jobs.json
```

## Deploy

```bash
gcloud config set project poyraz-digital
gcloud run deploy keyword-search \
  --source=. \
  --region=europe-west1 \
  --project=poyraz-digital \
  --allow-unauthenticated \
  --port=8080 \
  --memory=512Mi \
  --cpu=1
```

> **Memory:** `512Mi`. The `/dl/desc` route parses `public/descriptions.json`
> once and keeps it resident (~50–80 MB) to serve per-id description slices
> without re-reading 31 MB from disk per request. Estimated peak (~250–300 MB)
> fits in 512Mi; bump to `1Gi` if the instance OOM-kills under load.

Default service URL: `https://keyword-search-30518421759.europe-west1.run.app`.

## Custom domain: keyword-search.poyraz.digital

```bash
gcloud beta run domain-mappings create \
  --service=keyword-search \
  --domain=keyword-search.poyraz.digital \
  --region=europe-west1 \
  --project=poyraz-digital
```

Then add this record at the `poyraz.digital` registrar (DNS is **not** in
Cloud DNS for this project — it's managed externally, like the other
subdomains):

| Name           | Type  | Value                 |
|----------------|-------|-----------------------|
| keyword-search | CNAME | ghs.googlehosted.com. |

Google provisions a managed TLS cert within a few minutes of the DNS
resolving. Check status with:

```bash
gcloud beta run domain-mappings describe \
  --domain=keyword-search.poyraz.digital \
  --region=europe-west1 \
  --project=poyraz-digital
```
