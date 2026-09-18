// Public surface of the file↔CRDT bridge (spec 03 §5).
export { NoteBridge } from "./noteBridge";
export {
  BridgeManager,
  bridgeManager,
  createTauriBridgeIO,
  sha256Hex,
} from "./adapter";
export {
  DEFAULT_CONFIG,
  ORIGIN_DISK,
  ORIGIN_EDITOR,
  ORIGIN_REMOTE,
} from "./types";
export type {
  BridgeConfig,
  BridgeIO,
  CrdtPersistence,
  NoteBridgeOptions,
  Origin,
  YjsPersistedState,
} from "./types";
