import { useState } from "react";
import { resolveVaultAsset } from "../lib/fileTypes/assetResolver";
import { useStore } from "../store";
import { previewKind } from "../lib/preview";
import { openFileExternally } from "../lib/ipc";
import { ImageViewer } from "./filePreview/ImageViewer";
import { LazyPdfViewer as PdfViewer } from "./filePreview/LazyPdfViewer";
import { StructuredPreview } from "./filePreview/StructuredPreview";

function MediaPreview({ kind, src, name, onOpenExternal }: {
  kind: "audio" | "video";
  src: string;
  name: string;
  onOpenExternal: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="preview-state" role="alert">
        <p>Noam's media engine can't play {name}. The codec may not be available on this computer.</p>
        <button onClick={onOpenExternal}>Open externally</button>
      </div>
    );
  }
  return (
    <div className={`media-preview media-preview-${kind}`}>
      {kind === "audio"
        ? <audio src={src} controls preload="metadata" onError={() => setFailed(true)} />
        : <video src={src} controls preload="metadata" onError={() => setFailed(true)} />}
      <button onClick={onOpenExternal}>Open externally</button>
    </div>
  );
}

export function FilePreview({ path }: { path: string }) {
  const vaultPath = useStore((state) => state.vault?.path ?? null);
  const kind = previewKind(path);
  const name = path.split("/").pop() ?? path;

  if (!vaultPath || !kind) {
    return <div className="preview-state"><p>Can't preview this file.</p></div>;
  }

  const absolute = `${vaultPath.replace(/\/$/, "")}/${path}`;
  const src = resolveVaultAsset({ vaultPath, documentPath: "", source: path, sourceKind: "path" });
  const openExternally = () => { void openFileExternally(absolute); };

  return (
    <div className={`file-preview file-preview-${kind}`}>
      {kind === "image" && <ImageViewer src={src} name={name} />}
      {kind === "pdf" && <PdfViewer src={src} name={name} onOpenExternal={openExternally} />}
      {(kind === "audio" || kind === "video") && (
        <MediaPreview key={src} kind={kind} src={src} name={name} onOpenExternal={openExternally} />
      )}
      {(kind === "text" || kind === "json" || kind === "csv") && (
        <StructuredPreview src={src} kind={kind} onOpenExternal={openExternally} />
      )}
      {kind === "external" && (
        <div className="preview-state">
          <p>Noam doesn't render {name}. Open it with its usual app.</p>
          <button onClick={openExternally}>Open externally</button>
        </div>
      )}
    </div>
  );
}
