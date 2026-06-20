// Extract plain text from a PDF entirely in the browser via pdf.js. Ported from
// cv-skill-extractor: items are grouped into lines by their y-coordinate (then
// ordered left-to-right) so the reconstructed text keeps the CV's reading order,
// which the section-aware skill extractor relies on.
//
// pdf.js touches browser-only globals (DOMMatrix, etc.) at module-eval time, so
// it must NEVER be imported during SSR. It's loaded with a dynamic import inside
// the function below, which only ever runs in the browser on a user action.

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      // Resolve the worker as a bundled asset URL (Turbopack emits it) so
      // there's no manual /public copy to keep in sync.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

export async function readPdfText(file: File): Promise<string> {
  const pdfjs = await getPdfjs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: true,
    useWorkerFetch: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const rows = content.items
      .flatMap((item) => {
        if (!("str" in item) || typeof item.str !== "string" || item.str.trim().length === 0) {
          return [];
        }
        const transform = Array.isArray(item.transform) ? item.transform : [];
        return [{ text: item.str, x: transform[4] ?? 0, y: Math.round(transform[5] ?? 0) }];
      })
      .sort((a, b) => b.y - a.y || a.x - b.x);

    const lines: string[] = [];
    let currentY: number | null = null;
    for (const row of rows) {
      const lastLine = lines.at(-1);
      if (!lastLine || currentY === null || Math.abs(currentY - row.y) > 2) {
        lines.push(row.text);
        currentY = row.y;
      } else {
        lines[lines.length - 1] = `${lastLine} ${row.text}`;
      }
    }
    pages.push(lines.join("\n"));
  }

  return pages.join("\n");
}
