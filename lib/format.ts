// Small presentational helpers shared by the benchmark result panels. These
// mirror the inline helpers in app/page.tsx (kept separate so the benchmark can
// render hits identically to the main UI without depending on the page module).

// Some scraped fields arrive as the literal string "null"/"undefined" or blank;
// treat all of those as absent so they never render in the UI.
export function clean(v?: string | null): string {
  const s = (v ?? "").trim();
  return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined" ? s : "";
}

export function fmtDate(d: string): string {
  const c = clean(d);
  if (!c) return "";
  const dt = new Date(c);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Relative "3 days ago"-style label + whether it counts as recent (<= 7 days).
// `now` is captured once after mount (Date.now() is impure in render). Garbage
// epoch dates (year < 2000) are dropped rather than shown as "56 years ago".
export function fmtPosted(d: string, now: number | null): { label: string; isNew: boolean } {
  const c = clean(d);
  if (!c) return { label: "", isNew: false };
  const t = new Date(c).getTime();
  if (Number.isNaN(t) || new Date(t).getFullYear() < 2000) {
    return { label: "", isNew: false };
  }
  if (now == null) return { label: fmtDate(c), isNew: false };
  const days = Math.floor((now - t) / 86_400_000);
  let label: string;
  if (days < 0) label = fmtDate(c);
  else if (days === 0) label = "Today";
  else if (days === 1) label = "Yesterday";
  else if (days < 7) label = `${days} days ago`;
  else if (days < 14) label = "Last week";
  else if (days < 30) label = `${Math.floor(days / 7)} weeks ago`;
  else if (days < 60) label = "Last month";
  else if (days < 365) label = `${Math.floor(days / 30)} months ago`;
  else label = fmtDate(c);
  return { label, isNew: days >= 0 && days <= 7 };
}

export function fmtType(t: string): string {
  const c = clean(t);
  if (!c) return "";
  const s = c.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
