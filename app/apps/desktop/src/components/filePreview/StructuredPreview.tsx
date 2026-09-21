import { useEffect, useState } from "react";

const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_ROWS = 500;
const MAX_COLUMNS = 50;

async function readBoundedText(src: string): Promise<{ text: string; truncated: boolean }> {
  const response = await fetch(src);
  if (!response.ok || !response.body) throw new Error("read failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_PREVIEW_BYTES - size;
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, Math.max(0, remaining)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(joined), truncated };
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length && rows.length < MAX_ROWS; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row.slice(0, MAX_COLUMNS));
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row.slice(0, MAX_COLUMNS));
  }
  return rows;
}

export function StructuredPreview({ src, kind, onOpenExternal }: {
  src: string;
  kind: "text" | "json" | "csv";
  onOpenExternal: () => void;
}) {
  const [result, setResult] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    setError(null);
    void readBoundedText(src)
      .then((loaded) => active && setResult(loaded))
      .catch(() => active && setError("Noam couldn't read this file."));
    return () => { active = false; };
  }, [src]);

  if (error) return <div className="preview-state"><p>{error}</p><button onClick={onOpenExternal}>Open externally</button></div>;
  if (!result) return <div className="preview-state"><p>Loading preview…</p></div>;

  if (kind === "text" || kind === "json") {
    let formatted = result.text;
    let invalid = false;
    if (kind === "json" && !result.truncated) {
      try { formatted = JSON.stringify(JSON.parse(result.text), null, 2); }
      catch { invalid = true; }
    }
    return (
      <div className="structured-preview">
        {(result.truncated || invalid) && <p className="preview-notice">{result.truncated ? "Preview limited to 1 MB." : "Invalid JSON. Showing source."}</p>}
        <pre>{formatted}</pre>
        <button onClick={onOpenExternal}>Open externally</button>
      </div>
    );
  }

  const rows = parseCsv(result.text);
  return (
    <div className="structured-preview">
      {(result.truncated || rows.length >= MAX_ROWS) && <p className="preview-notice">Preview limited to 500 rows and 1 MB.</p>}
      <div className="csv-scroll"><table><tbody>{rows.map((row, rowIndex) => (
        <tr key={rowIndex}>{row.map((cell, columnIndex) => rowIndex === 0
          ? <th key={columnIndex}>{cell}</th>
          : <td key={columnIndex}>{cell}</td>)}</tr>
      ))}</tbody></table></div>
      <button onClick={onOpenExternal}>Open externally</button>
    </div>
  );
}

export const structuredPreviewTest = { readBoundedText };
