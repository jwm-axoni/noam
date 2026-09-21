import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readPdfText } from "./pdfText";

// A real, synthetic PDF avoids a mocked stream API hiding native WebKit gaps.
function fixture() {
  const stream = "BT /F1 18 Tf 20 80 Td (quiet garden) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe("native PDF text compatibility", () => {
  it("reads a real PDF without ReadableStream async iteration", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);
    Reflect.deleteProperty(ReadableStream.prototype, Symbol.asyncIterator);
    const task = getDocument({ data: fixture(), useSystemFonts: true });
    try {
      const pdf = await task.promise;
      const content = await readPdfText(await pdf.getPage(1));
      expect(content.items.map((item) => "str" in item ? item.str : "").join(" ")).toContain("quiet garden");
    } finally {
      await task.destroy();
      if (descriptor) Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, descriptor);
    }
  });
});
