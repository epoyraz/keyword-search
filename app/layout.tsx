import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { readFileSync } from "node:fs";
import path from "node:path";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "keyword-search",
  description: "Local keyword search over scraped company job postings.",
};

// Color the mobile browser chrome to match the app header, and let content
// extend under the notch (the sticky header/sheet add safe-area insets).
export const viewport: Viewport = {
  themeColor: "#ff6600",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// The search assets (docs + prebuilt wasm index) are otherwise fetched late —
// only after the app JS downloads, the page hydrates, the worker is spawned,
// and the worker posts back. Preload them here, keyed by the same content-hash
// version baked into search-meta.json at build time, so the browser starts
// both downloads during initial HTML parse (in parallel with the JS bundles).
// By the time the worker calls fetch() the bytes are already in flight or
// cached. crossOrigin="anonymous" matches the worker's default `fetch()`
// (CORS mode, same-origin credentials) so the request is reused, not repeated.
function SearchAssetPreloads() {
  let version: string | null = null;
  try {
    const meta = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "public", "search-meta.json"),
        "utf8",
      ),
    );
    version = typeof meta.version === "string" ? meta.version : null;
  } catch {
    version = null;
  }
  if (!version) return null;
  const v = encodeURIComponent(version);
  return (
    <>
      <link
        rel="preload"
        href={`/dl/search-index.bin?v=${v}`}
        as="fetch"
        crossOrigin="anonymous"
      />
      <link
        rel="preload"
        href={`/dl/jobs.json?v=${v}`}
        as="fetch"
        crossOrigin="anonymous"
      />
    </>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SearchAssetPreloads />
        {children}
      </body>
    </html>
  );
}
