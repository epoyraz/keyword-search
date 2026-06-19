// Build the filter metadata (company list + ordered city list) from a Job[].
// Cities are ordered: the top `topCityCount` by posting count first, then the
// rest alphabetically (the UI draws a separator at topCityCount).

export function buildCompanies(jobs) {
  return Array.from(new Set(jobs.map((j) => j.company)))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export function buildCityMeta(jobs, topN = 10) {
  const count = new Map();
  for (const j of jobs) {
    if (!j.location) continue;
    for (const part of String(j.location).split(/;\s*/)) {
      const c = part.trim();
      if (c) count.set(c, (count.get(c) || 0) + 1);
    }
  }
  const top = Array.from(count.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([c]) => c);
  const topSet = new Set(top);
  const rest = Array.from(count.keys())
    .filter((c) => !topSet.has(c))
    .sort((a, b) => a.localeCompare(b));
  return { cities: [...top, ...rest], topCityCount: top.length };
}
