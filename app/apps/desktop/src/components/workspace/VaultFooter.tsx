import { AccountMenu } from "../AccountMenu";
import * as ipc from "../../lib/ipc";
import { useStore } from "../../store";

const dispatchWindowEvent = (name: string) => window.dispatchEvent(new Event(name));

export function VaultFooter() {
  const vault = useStore((state) => state.vault);
  return (
    <div className="workspace-vault-footer">
      <button
        type="button"
        className="activity-button"
        title={vault ? `Switch vault — ${vault.name}` : "Switch vault"}
        aria-label="Switch vault"
        onClick={() => dispatchWindowEvent("noam:open-account-menu")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6c0-2 3.6-3 8-3s8 1 8 3-3.6 3-8 3-8-1-8-3Z" />
          <path d="M4 6v6c0 2 3.6 3 8 3s8-1 8-3V6M4 12v6c0 2 3.6 3 8 3s8-1 8-3v-6" />
        </svg>
      </button>
      <button
        type="button"
        className="activity-button"
        title="Help"
        aria-label="Help"
        onClick={() => void ipc.openExternal("https://noam.io").catch((error) => console.error("open help failed", error))}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.4 2.4 0 1 1 3.6 2.1c-.9.5-1.4 1.1-1.4 2.2" /><path d="M12 17h.01" />
        </svg>
      </button>
      <button
        type="button"
        className="activity-button"
        title="Settings"
        aria-label="Settings"
        onClick={() => dispatchWindowEvent("noam:open-settings")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7L10.5 2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7L0 10.5v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2.3h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7Z" transform="translate(1.5 0) scale(.88)" />
        </svg>
      </button>
      <div className="workspace-account-entry" title="Account">
        <AccountMenu compact />
      </div>
    </div>
  );
}

