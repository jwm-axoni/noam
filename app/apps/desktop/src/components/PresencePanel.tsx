// People panel (Phase 1 presence): who is online in this vault, who is in the
// open note, and the (empty until Phase 3) agents section. Data comes from the
// store's decayed vault roster; nothing here talks to the network.

import { useState, type CSSProperties, type ReactNode } from "react";
import "./presence.css";
import type { PanelBodyProps } from "../layout/panelRegistry";
import { useLayoutStore } from "../layout/store";
import { BRAND_DOMAIN } from "../lib/brand";
import { PRESENCE_OFFLINE, ringShowsColor, statusTone } from "../lib/presence/color";
import type { VaultPeer } from "../lib/presence/roster";
import {
  PRESENCE_NARROW_QUERY,
  useMediaQuery,
  useOpenNoteDocId,
} from "../lib/presence/usePresence";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";

export const PRESENCE_CHANGELOG_URL = `https://${BRAND_DOMAIN}/changelog`;

type SectionKey = "online" | "agents" | "note";
type Collapsed = Partial<Record<SectionKey, boolean>>;

function readCollapsed(instanceId: string): Collapsed {
  const raw = useLayoutStore.getState().layout.panels[instanceId]?.state.collapsed;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Collapsed) : {};
}

/** Write the collapsed flags into the panel instance so the layout persists them. */
function writeCollapsed(instanceId: string, collapsed: Collapsed): void {
  const { layout, replace } = useLayoutStore.getState();
  const panel = layout.panels[instanceId];
  if (!panel) return;
  replace({
    ...layout,
    panels: { ...layout.panels, [instanceId]: { ...panel, state: { ...panel.state, collapsed } } },
  });
}

function Section({
  id,
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  id: SectionKey;
  title: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = `presence-section-${id}`;
  return (
    <section className="presence-section" data-section={id}>
      <button
        type="button"
        className="presence-section-header"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="presence-chevron" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        <span className="presence-section-title">{title}</span>
        {count != null && <span className="presence-count">{count}</span>}
      </button>
      {!collapsed && (
        <div className="presence-section-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}

function PeerRow({ peer }: { peer: VaultPeer }) {
  const tone = statusTone(peer.status);
  const color = ringShowsColor(tone) ? peer.color : PRESENCE_OFFLINE;
  return (
    <li
      className={`presence-peer tone-${tone}${peer.stale ? " stale" : ""}`}
      data-user-id={peer.userId}
      title={peer.stale ? `${peer.name}: no signal for 30 s` : peer.name}
    >
      <span className="presence-chip" style={{ "--peer-color": color } as CSSProperties} aria-hidden="true" />
      <span className="presence-name">{peer.name}</span>
      {peer.stale && <span className="presence-hint">no signal for 30 s</span>}
    </li>
  );
}

function PeerList({ peers, empty }: { peers: VaultPeer[]; empty: string }) {
  if (peers.length === 0) return <p className="presence-empty">{empty}</p>;
  return (
    <ul className="presence-list">
      {peers.map((p) => (
        <PeerRow key={p.userId} peer={p} />
      ))}
    </ul>
  );
}

const byName = (a: VaultPeer, b: VaultPeer) =>
  Number(a.stale) - Number(b.stale) || a.name.localeCompare(b.name);

export function PresencePanel({ instanceId }: PanelBodyProps) {
  const narrow = useMediaQuery(PRESENCE_NARROW_QUERY);
  const peers = useStore((s) => s.vaultPresence);
  const lastLeave = useStore((s) => s.presenceLastLeave);
  const noteDocId = useOpenNoteDocId();
  const [collapsed, setCollapsed] = useState<Collapsed>(() => readCollapsed(instanceId));

  if (narrow) return null;

  const toggle = (key: SectionKey) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    writeCollapsed(instanceId, next);
  };

  const online = [...peers].sort(byName);
  const inNote = noteDocId ? online.filter((p) => p.docId === noteDocId) : [];

  return (
    <div className="presence-panel">
      <Section
        id="online"
        title="Online now"
        count={online.length}
        collapsed={!!collapsed.online}
        onToggle={() => toggle("online")}
      >
        <PeerList peers={online} empty="Nobody else is here right now." />
      </Section>
      {lastLeave && <p className="presence-leave-note">{lastLeave.text}</p>}
      <Section
        id="note"
        title="In this note"
        count={inNote.length}
        collapsed={!!collapsed.note}
        onToggle={() => toggle("note")}
      >
        <PeerList
          peers={inNote}
          empty={noteDocId ? "Only you are in this note." : "Open a note to see who is in it."}
        />
      </Section>
      <Section
        id="agents"
        title="Agents active"
        collapsed={!!collapsed.agents}
        onToggle={() => toggle("agents")}
      >
        <p className="presence-empty">No agents yet. Agents arrive in Phase 3.</p>
        <button
          type="button"
          className="presence-link"
          onClick={() =>
            void ipc.openExternal(PRESENCE_CHANGELOG_URL).catch((e) => console.error("open changelog failed", e))
          }
        >
          What's coming
        </button>
      </Section>
    </div>
  );
}
