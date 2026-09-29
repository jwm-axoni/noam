import { useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "../../store";
import { toast } from "../../lib/toast";
import {
  answerGuide,
  dismissGuideForever,
  guideVersion,
  planAgentGuide,
  readGuideState,
  subscribeGuide,
  writeAgentGuide,
  type GuidePlan,
} from "../../lib/terminal/agentGuide";

/**
 * A one-line offer above a running terminal: add an AGENTS.md that keeps
 * coding agents out of `.context/`. Shown only while the vault has none, its
 * root is not frozen, and nobody answered for this vault yet.
 */
export function AgentGuideOffer() {
  const vault = useStore((s) => s.vault);
  const rootFrozen = useStore((s) => s.rootFrozen);
  const answeredVersion = useSyncExternalStore(subscribeGuide, guideVersion, guideVersion);
  const [plan, setPlan] = useState<GuidePlan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPlan(null);
    if (!vault) return;
    let cancelled = false;
    void readGuideState(vault.path, rootFrozen, vault.epoch)
      .then((state) => {
        if (!cancelled) setPlan(planAgentGuide(state));
      })
      .catch(() => {
        // Could not tell whether the files exist: offering blind risks a
        // duplicate-name surprise, so say nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [vault?.path, vault?.epoch, rootFrozen, answeredVersion]);

  if (!vault || !plan?.offer) return null;

  const add = async () => {
    setBusy(true);
    try {
      const created = await writeAgentGuide(plan.files, vault.epoch);
      answerGuide(vault.path);
      await useStore.getState().refreshTree();
      if (created.length === 0) {
        toast("AGENTS.md already exists — left it as it was", "neutral");
      } else if (plan.claudeLeftAlone) {
        toast("Added AGENTS.md. Your CLAUDE.md is unchanged: add the line @AGENTS.md to it so Claude Code reads it.", "neutral");
      } else {
        toast(`Added ${created.join(" and ")} to the vault root`);
      }
    } catch (err) {
      toast(`Couldn't add AGENTS.md: ${String(err)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="terminal-guide" role="region" aria-label="Agent guidelines">
      <span className="terminal-guide-text">
        Coding agents here can change anything in the vault, including Noam's hidden{" "}
        <code>.context/</code> folder. Add an <code>AGENTS.md</code> telling them to stay out?
        It becomes a note your teammates can see.
      </span>
      <div className="terminal-guide-actions">
        <button type="button" className="terminal-restart" disabled={busy} onClick={() => void add()}>
          Add it
        </button>
        <button type="button" className="terminal-guide-link" disabled={busy} onClick={() => answerGuide(vault.path)}>
          Not now
        </button>
        <button
          type="button"
          className="terminal-guide-link"
          disabled={busy}
          onClick={() => {
            dismissGuideForever(vault.path);
            answerGuide(vault.path);
          }}
        >
          Don't ask again
        </button>
      </div>
    </div>
  );
}
