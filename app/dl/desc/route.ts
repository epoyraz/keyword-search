import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  gzipSync,
  brotliCompressSync,
  constants as zlibConstants,
} from "node:zlib";
import type { NextRequest } from "next/server";

// Serves raw job descriptions by id, sliced from the baked descriptions.json.
// The metadata-only jobs.json no longer ships description text, so clients fetch
// just the descriptions they need:
//   GET  /dl/desc?ids=a,b,c&v=<version>   — small sets (previews); cacheable.
//   POST /dl/desc   { "ids": [...] }      — large sets (advanced-query filter).
// Both return a { id: description } map (ids with no stored text are omitted).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Parse descriptions.json once and keep it resident (~80 MB) — re-reading 32 MB
// from disk per request would be far slower. Concurrent first-hits share the
// one in-flight parse via the cached promise.
let descriptionsPromise: Promise<Record<string, string>> | null = null;
function loadDescriptions(): Promise<Record<string, string>> {
  if (!descriptionsPromise) {
    descriptionsPromise = readFile(
      path.join(process.cwd(), "public", "descriptions.json"),
      "utf8",
    ).then((text) => JSON.parse(text) as Record<string, string>);
  }
  return descriptionsPromise;
}

function pick(
  all: Record<string, string>,
  ids: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const d = all[id];
    if (d) out[id] = d;
  }
  return out;
}

function respond(req: NextRequest, body: Record<string, string>): Response {
  const raw = Buffer.from(JSON.stringify(body));
  const accept = req.headers.get("accept-encoding") ?? "";

  let payload: Buffer = raw;
  let encoding = "";
  // Modest compression levels: these responses are dynamic (no precompressed
  // sibling) and usually tiny, so favour speed over ratio.
  if (/\bbr\b/.test(accept)) {
    encoding = "br";
    payload = brotliCompressSync(raw, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
    });
  } else if (/\bgzip\b/.test(accept)) {
    encoding = "gzip";
    payload = gzipSync(raw, { level: 6 });
  }

  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    // Keyed by ?v=<version> (immutable per build) — safe to cache forever. Only
    // the GET form is cacheable by browsers; harmless on the POST response.
    "Cache-Control": "public, max-age=31536000, immutable",
    Vary: "Accept-Encoding",
  });
  if (encoding) headers.set("Content-Encoding", encoding);

  return new Response(new Uint8Array(payload), { headers });
}

function parseIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function GET(req: NextRequest): Promise<Response> {
  const ids = parseIds(req.nextUrl.searchParams.get("ids"));
  const all = await loadDescriptions();
  return respond(req, pick(all, ids));
}

export async function POST(req: NextRequest): Promise<Response> {
  let ids: string[] = [];
  try {
    const body = (await req.json()) as { ids?: unknown };
    if (Array.isArray(body.ids)) ids = body.ids.map(String);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const all = await loadDescriptions();
  return respond(req, pick(all, ids));
}
