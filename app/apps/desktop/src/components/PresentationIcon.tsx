import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { useEffect, useState } from "react";
import type { PresentationIcon as PresentationIconValue } from "../lib/presentation/types";
import "./presentation.css";

const KNOWN_ICONS = new Set<string>(iconNames);

export function PresentationIcon({
  icon,
  assetUrl,
  className,
}: {
  icon: PresentationIconValue;
  assetUrl?: string | null;
  className?: string;
}) {
  const [assetFailed, setAssetFailed] = useState(false);
  useEffect(() => setAssetFailed(false), [assetUrl]);

  if (icon.kind === "emoji") {
    return <span className={className} aria-hidden="true">{icon.value}</span>;
  }
  if (icon.kind === "asset") {
    return assetUrl && !assetFailed ? (
      <img
        className={className}
        src={assetUrl}
        alt=""
        draggable={false}
        onError={() => setAssetFailed(true)}
      />
    ) : (
      <span
        className={`${className ?? ""} presentation-icon-missing`.trim()}
        title="Icon image is missing. Open the icon picker to replace it."
        aria-hidden="true"
      >
        ?
      </span>
    );
  }
  if (!KNOWN_ICONS.has(icon.id)) return null;
  return <DynamicIcon className={className} name={icon.id as IconName} aria-hidden="true" />;
}
