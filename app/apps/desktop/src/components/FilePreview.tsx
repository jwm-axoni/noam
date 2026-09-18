// In-place viewer for previewable non-note files (images, PDFs). The bytes live
// on disk under the vault; we stream them through the asset: protocol (the vault
// dir is granted to the asset-protocol scope on open, Rust side) rather than
// reading them into JS. Notes and HTML pages never reach here — the editor and
// HtmlView own those.

import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { previewKind } from "../lib/preview";

export function FilePreview({ path }: { path: string }) {
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const [failed, setFailed] = useState(false);
  const kind = previewKind(path);
  const name = path.split("/").pop() ?? path;

  if (!vaultPath || !kind) {
    return (
      <div className="editor-empty">
        <p>Can't preview this file.</p>
      </div>
    );
  }

  const abs = `${vaultPath.replace(/\/$/, "")}/${path}`;
  const src = convertFileSrc(abs);

  return (
    <div className={`file-preview file-preview-${kind}`}>
      <div className="file-preview-body">
        {failed ? (
          <div className="editor-empty">
            <p>Couldn't load {name}.</p>
          </div>
        ) : kind === "image" ? (
          <img
            className="file-preview-img"
            src={src}
            alt={name}
            onError={() => setFailed(true)}
          />
        ) : (
          <iframe className="file-preview-frame" src={src} title={name} />
        )}
      </div>
    </div>
  );
}
