/**
 * The board's public surface. UI code imports from HERE.
 *
 * The frozen shapes (`BoardDocument`, `BoardLane`, `BoardCard`,
 * `BoardSettings`) live in `src/lib/tasks/contracts.ts` and are re-exported by
 * nobody: import them from the contracts, and take the `Parsed*` types below
 * when you need the spans a write is planned against.
 */

export {
  isBoardDocument,
  kanbanPluginValue,
  parseBoard,
  type LaneBlock,
  type ParseOptions,
  type ParsedBoard,
  type ParsedCard,
  type ParsedLane,
  type Span,
} from "./parse";

export { applyChanges, serializeBoard } from "./serialize";

export {
  planUpdateSettings,
  readSettings,
  SETTING_KEYS,
  type RecognisedSettings,
  type SettingsPatch,
} from "./settings";

export {
  planMove,
  planMoveLive,
  type BoardMoveHost,
  type LiveMoveResult,
  type CardRef,
  type MoveFailure,
  type MoveInput,
  type MoveResult,
} from "./move";

export {
  exportKanban,
  importKanban,
  type KanbanIssue,
  type KanbanReport,
} from "./kanban";
