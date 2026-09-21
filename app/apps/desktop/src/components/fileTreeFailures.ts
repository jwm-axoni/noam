import {
  computeReorder,
  moveSubtreeOrder,
  narrowPins,
  type ItemOrder,
} from "../lib/ordering";

export interface FileTreeRegistryFailure {
  path: string;
  reason: string;
  code: string | null;
}

export interface FileTreeMoveDeps {
  renameDisk: (
    from: string,
    to: string,
    epoch: number | undefined,
  ) => Promise<unknown>;
  renameServer: (from: string, to: string) => Promise<
    { ok: true } | { ok: false; failure: FileTreeRegistryFailure }
  >;
}

export type FileTreeMoveResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      diskChanged: boolean;
      alreadyNotified: boolean;
    };

export function fileTreeErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The inline-title collision wording, adapted to the kind of tree item. */
export function renameCollisionMessage(name: string, isDir: boolean): string {
  const kind = isDir ? "folder" : "note";
  return `A ${kind} called "${name}" already exists here.`;
}

export function moveFailureMessage(path: string, reason: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  return `Couldn't move "${name}" — ${reason}`;
}

/** Case-insensitive because the supported desktop filesystems may be. */
export function hasRenameCollision(
  paths: Iterable<string>,
  oldPath: string,
  newPath: string,
): boolean {
  const oldKey = oldPath.toLocaleLowerCase();
  const nextKey = newPath.toLocaleLowerCase();
  for (const path of paths) {
    const key = path.toLocaleLowerCase();
    if (key === nextKey && key !== oldKey) return true;
  }
  return false;
}

/**
 * Move on disk, then tell the server. Read the outcome of this specific rename:
 * a concurrent reconcile can replace the registry's shared failure list.
 * If refused, put the local item back before the tree re-renders.
 */
export async function moveFileTreeItem(
  from: string,
  to: string,
  epoch: number | undefined,
  deps: FileTreeMoveDeps,
): Promise<FileTreeMoveResult> {
  try {
    await deps.renameDisk(from, to, epoch);
  } catch (error) {
    return {
      ok: false,
      reason: fileTreeErrorReason(error),
      diskChanged: false,
      alreadyNotified: false,
    };
  }

  let recorded: FileTreeRegistryFailure;
  try {
    const result = await deps.renameServer(from, to);
    if (result.ok) return { ok: true };
    recorded = result.failure;
  } catch (error) {
    recorded = { path: to, reason: fileTreeErrorReason(error), code: null };
  }

  const reason = recorded.reason;
  try {
    await deps.renameDisk(to, from, epoch);
    return {
      ok: false,
      reason,
      diskChanged: false,
      alreadyNotified: recorded.code === "root_frozen",
    };
  } catch (rollbackError) {
    return {
      ok: false,
      reason: `${reason}. Couldn't restore the local item: ${fileTreeErrorReason(rollbackError)}`,
      diskChanged: true,
      alreadyNotified: recorded.code === "root_frozen",
    };
  }
}

/** Apply a drop and persist its arrangement alongside the disk/server moves. */
export async function moveFileTreeItems(
  from: string[],
  to: string[],
  plan: {
    epoch: number | undefined;
    destDir: string;
    siblings: string[];
    index: number;
    isDir: (path: string) => boolean;
    order: ItemOrder;
  },
  deps: FileTreeMoveDeps & {
    setOrder: (order: ItemOrder) => void;
    onMoved: (from: string, to: string) => Promise<void>;
    onFailure: (from: string, result: Extract<FileTreeMoveResult, { ok: false }>) => void;
  },
): Promise<{ movedOnDisk: boolean; refused: boolean }> {
  let order = plan.order;
  const movedFrom: string[] = [];
  const movedTo: string[] = [];
  const persistMove = (oldPath: string, newPath: string) => {
    if (oldPath !== newPath) order = moveSubtreeOrder(order, oldPath, newPath);
    movedFrom.push(oldPath);
    movedTo.push(newPath);
    order = {
      ...order,
      [plan.destDir]: narrowPins(
        computeReorder(plan.siblings, movedFrom, movedTo, plan.index),
        plan.isDir,
        movedTo,
        plan.order[plan.destDir],
      ),
    };
    deps.setOrder(order);
  };
  let movedOnDisk = false;
  let refused = false;
  for (let i = 0; i < from.length; i++) {
    if (from[i] === to[i]) {
      persistMove(from[i], to[i]);
      continue;
    }
    const result = await moveFileTreeItem(from[i], to[i], plan.epoch, deps);
    if (!result.ok) {
      refused = true;
      deps.onFailure(from[i], result);
      movedOnDisk ||= result.diskChanged;
      // If rollback failed, ordering and open tabs must follow the disk path.
      if (result.diskChanged) {
        persistMove(from[i], to[i]);
        await deps.onMoved(from[i], to[i]);
      }
      continue;
    }
    movedOnDisk = true;
    // Save before any tab-opening await or the next item can fail.
    persistMove(from[i], to[i]);
    await deps.onMoved(from[i], to[i]);
  }
  return { movedOnDisk, refused };
}
