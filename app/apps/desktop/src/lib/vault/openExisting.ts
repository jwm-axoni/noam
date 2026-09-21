import * as ipc from "../ipc";
import { useStore } from "../../store";

/** Pick an existing folder and adopt the vault Rust opened for it. */
export async function openExistingVault(): Promise<boolean> {
  const vault = await ipc.pickVault();
  if (!vault) return false;
  // No seed flag: a folder the user picked stays exactly as it is.
  await useStore.getState().adoptOpenedVault(vault);
  return true;
}
