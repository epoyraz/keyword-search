import { readFile } from "node:fs/promises";
import path from "node:path";

// Shared by the benchmark scripts. jobs.json is metadata-only now (descriptions
// were split out to shrink the app's cold-start download), but the engines index
// the FULL text — the prebuilt wasm snapshot was built from full docs. So merge
// descriptions.json back in, giving every script an identical document set to
// build its in-process JS index from.
export async function loadFullDocs(publicDir) {
  const [metaJobsJson, descJson] = await Promise.all([
    readFile(path.join(publicDir, "jobs.json"), "utf8"),
    readFile(path.join(publicDir, "descriptions.json"), "utf8"),
  ]);
  const jobs = JSON.parse(metaJobsJson);
  const descriptions = JSON.parse(descJson);
  for (const j of jobs) j.description = descriptions[j.id] ?? "";
  return { jobs, fullJobsJson: JSON.stringify(jobs), metaJobsJson };
}
