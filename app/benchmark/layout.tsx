import { headers } from "next/headers";
import { notFound } from "next/navigation";

// Dev-only gate: the benchmark route is for local comparison work and must never
// be reachable on a deployed host. Reading the request Host header (a
// request-time API) opts this segment into dynamic rendering, so the check runs
// per request; any host other than localhost/loopback gets a 404 — including
// production, even if this code ships in the image.
function isLocalHost(host: string): boolean {
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export default async function BenchmarkLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const host = (await headers()).get("host") ?? "";
  if (!isLocalHost(host)) notFound();
  return <>{children}</>;
}
