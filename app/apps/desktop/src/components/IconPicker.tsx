import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  pickPresentationSource,
  savePresentationAsset,
  type PresentationAssetSource,
  type PresentationAssetTarget,
} from "../lib/presentation/assets";
import {
  parsePresentationIcon,
  type PresentationIcon,
} from "../lib/presentation/types";
import { PresentationIcon as PresentationIconView } from "./PresentationIcon";
import "./presentation.css";

const LEGACY_RECENTS_KEY = "noam:recent-icons:v1";
const RECENTS_KEY = "noam:recent-icons:v2";
const ASSET_RECENTS_PREFIX = "noam:recent-icon-assets:v1:";
const PAGE_SIZE = 360;

const EMOJI = [
  "🌿", "🌱", "🌲", "🌳", "🌵", "🌻", "🌸", "🍄", "🍎", "🍋", "🥑", "☕",
  "🏠", "🏡", "🏢", "🏫", "🏥", "🏕️", "🗺️", "🧭", "🚲", "🚗", "✈️", "🚀",
  "❤️", "⭐", "✨", "🔥", "💧", "☀️", "🌙", "☁️", "⚡", "🌈", "🎯", "🏆",
  "📌", "📎", "✏️", "🖊️", "📚", "📖", "📝", "📅", "🗓️", "📦", "🧰", "🔖",
  "💡", "🔍", "🔒", "🔑", "🔔", "⏰", "⌛", "✅", "⚠️", "❓", "💬", "📣",
  "👤", "👥", "🤝", "💼", "🧑‍💻", "🎓", "🧠", "💭", "🎨", "🎵", "🎬", "📷",
  "🐶", "🐱", "🐻", "🦊", "🦉", "🐝", "🦋", "🐳", "🐙", "🦖", "🦄", "🐾",
  "⚙️", "🛠️", "🧪", "🔬", "💻", "📱", "🌐", "🗂️", "📊", "📈", "💰", "🎁",
] as const;

const SYNONYMS: Record<string, string> = {
  home: "house building residence",
  settings: "gear cog preferences",
  search: "find magnify",
  file: "document note page",
  folder: "directory collection",
  heart: "love favorite",
  star: "favorite rating",
  user: "person profile account",
  users: "people team group",
  calendar: "date schedule event",
  check: "done complete success",
  x: "close remove cancel",
  trash: "delete bin remove",
  pencil: "edit write",
  mail: "email envelope",
  message: "chat comment conversation",
  image: "photo picture",
  camera: "photo picture",
  briefcase: "work business job",
};

type Tab = "icons" | "emoji" | "upload";

function readStringList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function assetRecentsKey(vaultScope: string): string {
  return `${ASSET_RECENTS_PREFIX}${encodeURIComponent(vaultScope)}`;
}

function readRecents(): string[] {
  const current = readStringList(RECENTS_KEY);
  const source = current.length > 0 ? current : readStringList(LEGACY_RECENTS_KEY);
  return source.filter((item) => {
    const icon = parsePresentationIcon(item);
    return icon?.kind === "lucide" || icon?.kind === "emoji";
  });
}

function readAssetRecents(vaultScope: string): string[] {
  return readStringList(assetRecentsKey(vaultScope)).filter(
    (item) => parsePresentationIcon(item)?.kind === "asset",
  );
}

function writeRecents(key: string, values: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values.slice(0, 20)));
  } catch {
    // The choice still applies when browser storage is unavailable.
  }
}

function remember(value: PresentationIcon, vaultScope: string): void {
  const encoded = value.kind === "lucide" ? `lucide:${value.id}` : value.kind === "emoji" ? `emoji:${value.value}` : `asset:${value.path}`;
  const key = value.kind === "asset" ? assetRecentsKey(vaultScope) : RECENTS_KEY;
  const current = value.kind === "asset" ? readAssetRecents(vaultScope) : readRecents();
  writeRecents(key, [encoded, ...current.filter((item) => item !== encoded)]);
}

function category(name: string): string {
  if (/(arrow|chevron|move|navigation|route|compass)/.test(name)) return "Navigation";
  if (/(file|folder|archive|book|notebook|clipboard)/.test(name)) return "Files";
  if (/(user|person|contact|baby)/.test(name)) return "People";
  if (/(message|mail|phone|send|rss)/.test(name)) return "Communication";
  if (/(calendar|clock|timer|alarm|hourglass)/.test(name)) return "Time";
  if (/(chart|banknote|wallet|briefcase|building)/.test(name)) return "Work";
  if (/(heart|star|smile|party|gift|sparkle)/.test(name)) return "Symbols";
  return "General";
}

export function IconPicker({
  captureAssetTarget,
  vaultScope,
  assetExists,
  onChoose,
  onReset,
  onClose,
  returnFocus,
  resolveAsset,
}: {
  captureAssetTarget: () => PresentationAssetTarget | null;
  vaultScope: string;
  assetExists: (path: string) => Promise<boolean>;
  onChoose: (icon: PresentationIcon) => boolean | void | Promise<boolean | void>;
  onReset: () => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  /** Resolved before close so callers can return focus to a control that survives unmounting. */
  returnFocus?: () => HTMLElement | null;
  resolveAsset?: (
    source: string,
    sourceKind?: "url" | "path",
  ) => string | null;
}) {
  const [tab, setTab] = useState<Tab>("icons");
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cropSource, setCropSource] = useState<PresentationAssetSource | null>(null);
  const [crop, setCrop] = useState({ x: 50, y: 50, zoom: 1 });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusMovedOption = useRef(false);
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined"
      && document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      && document.activeElement !== document.documentElement
      ? document.activeElement
      : null,
  );
  const recents = useMemo(readRecents, []);
  const assetRecentPaths = useMemo(
    () => readAssetRecents(vaultScope).map(parsePresentationIcon).filter(
      (icon): icon is Extract<PresentationIcon, { kind: "asset" }> => icon?.kind === "asset",
    ),
    [vaultScope],
  );
  const [uploadedRecents, setUploadedRecents] = useState<
    Array<Extract<PresentationIcon, { kind: "asset" }>>
  >([]);

  const categories = useMemo(() => ["All", ...new Set(iconNames.map(category))], []);
  const icons = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return iconNames.filter((name) => {
      if (activeCategory !== "All" && category(name) !== activeCategory) return false;
      if (!needle) return true;
      const words = `${name} ${SYNONYMS[name] ?? ""}`;
      return words.includes(needle);
    }).slice(0, PAGE_SIZE);
  }, [activeCategory, query]);
  const emoji = useMemo(() => query.trim() ? EMOJI.filter((value) => value.includes(query.trim())) : EMOJI, [query]);
  const count = tab === "icons" ? icons.length : tab === "emoji" ? emoji.length : 0;

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(
    () => () => {
      if (cropSource) URL.revokeObjectURL(cropSource.previewUrl);
    },
    [cropSource],
  );
  useEffect(() => setActive(0), [tab, query, activeCategory]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      assetRecentPaths.map(async (icon) => ({ icon, exists: await assetExists(icon.path) })),
    ).then((checked) => {
      if (cancelled) return;
      const existing = checked.filter(({ exists }) => exists).map(({ icon }) => icon).slice(0, 8);
      setUploadedRecents(existing);
      if (existing.length !== assetRecentPaths.length) {
        writeRecents(assetRecentsKey(vaultScope), existing.map((icon) => `asset:${icon.path}`));
      }
    }).catch(() => {
      if (!cancelled) setUploadedRecents([]);
    });
    return () => { cancelled = true; };
  }, [assetExists, assetRecentPaths, vaultScope]);
  useEffect(() => {
    if (!focusMovedOption.current) return;
    focusMovedOption.current = false;
    const option = optionRefs.current[active];
    option?.focus({ preventScroll: true });
    option?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tab, icons, emoji]);
  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (pickerRef.current?.contains(target) || openerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress, true);
  }, [onClose]);
  const closeAndRestoreFocus = useCallback(() => {
    const target = returnFocus?.() ?? openerRef.current;
    onClose();
    queueMicrotask(() => target?.focus());
  }, [onClose, returnFocus]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [closeAndRestoreFocus]);

  const choose = async (icon: PresentationIcon) => {
    if (icon.kind === "asset") {
      const target = captureAssetTarget();
      if (!target || !target.isCurrent() || target.vaultScope !== vaultScope) return;
    }
    if (await onChoose(icon) === false) return;
    remember(icon, vaultScope);
    closeAndRestoreFocus();
  };
  const reset = async () => {
    if (await onReset() === false) return;
    closeAndRestoreFocus();
  };
  const move = (event: React.KeyboardEvent, columns = 8) => {
    if (tab === "upload" || count === 0) return;
    let next = active;
    if (event.key === "ArrowRight") next++;
    else if (event.key === "ArrowLeft") next--;
    else if (event.key === "ArrowDown") next += columns;
    else if (event.key === "ArrowUp") next -= columns;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === "Enter") {
      event.preventDefault();
      if (tab === "icons" && icons[active]) void choose({ kind: "lucide", id: icons[active] });
      if (tab === "emoji" && emoji[active]) void choose({ kind: "emoji", value: emoji[active] });
      return;
    } else return;
    event.preventDefault();
    focusMovedOption.current = true;
    setActive(Math.max(0, Math.min(count - 1, next)));
  };

  return (
    <div ref={pickerRef} className="icon-picker" role="dialog" aria-label="Choose an icon">
      <div className="icon-picker-header">
        <span>Choose an icon</span>
        <button
          type="button"
          className="icon-picker-close"
          aria-label="Close icon picker"
          title="Close (Esc)"
          onClick={closeAndRestoreFocus}
        >
          <X aria-hidden="true" size={16} strokeWidth={1.8} />
        </button>
      </div>
      <div className="icon-picker-tabs" role="tablist">
        {(["icons", "emoji", "upload"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {id[0]!.toUpperCase() + id.slice(1)}
          </button>
        ))}
      </div>
      {tab !== "upload" && (
        <input ref={inputRef} className="icon-picker-search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={move} placeholder={`Search ${tab}`} aria-label={`Search ${tab}`} />
      )}
      {!query && recents.some((value) => value.startsWith(tab === "icons" ? "lucide:" : "emoji:")) && tab !== "upload" && (
        <div className="icon-picker-recents" aria-label="Recent choices">
          <span>Recent</span>
          {recents.filter((value) => value.startsWith(tab === "icons" ? "lucide:" : "emoji:")).slice(0, 8).map((value) => {
            if (value.startsWith("emoji:")) {
              const emojiValue = value.slice(6);
              return <button key={value} type="button" aria-label={`Recent emoji ${emojiValue}`} onClick={() => void choose({ kind: "emoji", value: emojiValue })}>{emojiValue}</button>;
            }
            const name = value.slice(7) as IconName;
            return <button key={value} type="button" aria-label={`Recent icon ${name.replace(/-/g, " ")}`} title={name} onClick={() => void choose({ kind: "lucide", id: name })}><DynamicIcon name={name} /></button>;
          })}
        </div>
      )}
      {tab === "icons" && (
        <>
          <div className="icon-picker-categories" aria-label="Icon categories">
            {categories.map((name) => <button key={name} type="button" className={name === activeCategory ? "active" : ""} onClick={() => setActiveCategory(name)}>{name}</button>)}
          </div>
          <div className="icon-picker-grid" role="listbox" aria-label={`${icons.length} matching icons`} onKeyDown={move}>
            {icons.map((name, index) => (
              <button key={name} ref={(node) => { optionRefs.current[index] = node; }} type="button" role="option" aria-label={name.replace(/-/g, " ")} aria-selected={index === active} tabIndex={index === active ? 0 : -1} className={index === active ? "active" : ""} title={name.replace(/-/g, " ")} onMouseEnter={() => setActive(index)} onClick={() => void choose({ kind: "lucide", id: name })}>
                <DynamicIcon name={name as IconName} />
              </button>
            ))}
          </div>
        </>
      )}
      {tab === "emoji" && (
        <div className="icon-picker-grid emoji" role="listbox" aria-label="Emoji choices" onKeyDown={move}>
          {emoji.map((value, index) => <button key={`${value}-${index}`} ref={(node) => { optionRefs.current[index] = node; }} type="button" role="option" aria-label={`Emoji ${value}`} aria-selected={index === active} tabIndex={index === active ? 0 : -1} className={index === active ? "active" : ""} onMouseEnter={() => setActive(index)} onClick={() => void choose({ kind: "emoji", value })}>{value}</button>)}
        </div>
      )}
      {tab === "upload" && (
        <div className="icon-picker-upload">
          {!cropSource ? (
            <>
              <p>PNG, JPEG, WebP or safe SVG. Maximum 5 MB.</p>
              {uploadedRecents.length > 0 && (
                <div className="icon-picker-recents uploaded" aria-label="Recent uploaded icons">
                  <span>Recent</span>
                  {uploadedRecents.map((icon) => (
                    <button
                      key={icon.path}
                      type="button"
                      aria-label={`Recent uploaded icon ${icon.path.split("/").pop() ?? icon.path}`}
                      title={icon.path}
                      onClick={() => void choose(icon)}
                    >
                      <PresentationIconView
                        icon={icon}
                        assetUrl={resolveAsset?.(icon.path, "path")}
                        className="presentation-icon"
                      />
                    </button>
                  ))}
                </div>
              )}
              <button type="button" onClick={() => {
                const target = captureAssetTarget();
                if (!target) return;
                void pickPresentationSource("icon", target).then((result) => {
                  if (!result) return;
                  if ("error" in result) setError(result.error);
                  else {
                    setError(null);
                    setCropSource(result);
                    setCrop({ x: 50, y: 50, zoom: 1 });
                  }
                });
              }}>Choose image…</button>
            </>
          ) : (
            <div className="icon-cropper">
              <div className="icon-crop-preview">
                <img src={cropSource.previewUrl} alt="Icon crop preview" style={{ objectPosition: `${crop.x}% ${crop.y}%`, transform: `scale(${crop.zoom})` }} />
              </div>
              <label>Horizontal <input type="range" min="0" max="100" value={crop.x} onChange={(event) => setCrop((value) => ({ ...value, x: Number(event.target.value) }))} /></label>
              <label>Vertical <input type="range" min="0" max="100" value={crop.y} onChange={(event) => setCrop((value) => ({ ...value, y: Number(event.target.value) }))} /></label>
              <label>Zoom <input type="range" min="1" max="3" step="0.05" value={crop.zoom} onChange={(event) => setCrop((value) => ({ ...value, zoom: Number(event.target.value) }))} /></label>
              <div className="icon-crop-actions">
                <button type="button" onClick={() => setCropSource(null)}>Choose another</button>
                <button type="button" onClick={() => void savePresentationAsset(cropSource.name, cropSource.bytes, "icon", cropSource.target, crop).then((result) => {
                  if ("error" in result) setError(result.error);
                  else void choose({ kind: "asset", path: result.path });
                })}>Use icon</button>
              </div>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
      <div className="icon-picker-footer">
        <button type="button" onClick={() => void reset()}>Reset to default</button>
        <span>{iconNames.length.toLocaleString()} bundled icons</span>
      </div>
    </div>
  );
}
