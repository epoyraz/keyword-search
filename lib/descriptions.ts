// Fetch raw job descriptions on demand from /dl/desc. The metadata-only
// jobs.json no longer carries description text (it's ~32 MB of the old 38 MB),
// so the UI fetches descriptions for the previews it actually shows, and the
// worker fetches them only for the few advanced operators that scan raw text.
//
// Used from BOTH the main thread (preview rendering) and the search Web Worker
// (advanced-query filtering), so this module stays free of any DOM/worker-only
// API — just `fetch`, which both contexts provide.

// Small id sets go over a cacheable GET (?ids=…), so repeated previews — and
// reloads — are served straight from the browser's immutable HTTP cache. Larger
// sets (a broad advanced query's candidate universe) go over a single POST,
// which has no URL-length limit; the caller caches those in memory itself.
const GET_MAX_IDS = 100;

/**
 * Resolve `ids` to a `{ id: description }` map. Ids with no stored description
 * (blank/garbage postings) are simply absent from the result — callers should
 * treat a missing id as a known-empty description, not "still loading".
 */
export async function fetchDescriptions(
  ids: string[],
  version: string,
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const v = encodeURIComponent(version);

  const res =
    ids.length <= GET_MAX_IDS
      ? await fetch(`/dl/desc?v=${v}&ids=${ids.map(encodeURIComponent).join(",")}`)
      : await fetch(`/dl/desc?v=${v}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });

  if (!res.ok) throw new Error(`description fetch failed: ${res.status}`);
  return (await res.json()) as Record<string, string>;
}
