import {
  DEFAULT_LEFT_WIDTH,
  DEFAULT_RIGHT_WIDTH,
  type SplitAxis,
} from "./types";

export const ACTIVITY_BAR_WIDTH = 40;
export const PANE_SEPARATOR_SIZE = 6;
export const SIDE_DOCK_MAX = 560;
export const LEFT_DOCK_MIN = 220;
export const RIGHT_DOCK_MIN = 260;
export const CENTER_NOTE_MIN = 480;
export const TOOL_GROUP_MIN = 220;
export const GRAPH_GROUP_MIN = 240;
export const GROUP_HEIGHT_MIN = 180;

export interface WorkspaceFitInput {
  viewportWidth: number;
  leftOpen: boolean;
  rightOpen: boolean;
  preferredLeft?: number;
  preferredRight?: number;
  /** The right dock loses a tie, matching the documented pressure policy. */
  leastRecentlyUsed?: "left" | "right";
}

export interface WorkspaceFit {
  leftWidth: number;
  centerWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

const finite = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;

export function clampPreferredDockWidth(side: "left" | "right", width: number): number {
  const minimum = side === "left" ? LEFT_DOCK_MIN : RIGHT_DOCK_MIN;
  const fallback = side === "left" ? DEFAULT_LEFT_WIDTH : DEFAULT_RIGHT_WIDTH;
  return Math.round(Math.min(SIDE_DOCK_MAX, Math.max(minimum, finite(width, fallback))));
}

function requiredWidth(left: number, right: number): number {
  const openCount = Number(left > 0) + Number(right > 0);
  return left + right + CENTER_NOTE_MIN + openCount * PANE_SEPARATOR_SIZE;
}

/**
 * Fits preferred dock widths without mutating them. Under pressure docks first
 * shrink to their minimums, then the LRU dock collapses (right on ties).
 */
export function fitWorkspace(input: WorkspaceFitInput): WorkspaceFit {
  const usable = Math.max(0, finite(input.viewportWidth, 0) - ACTIVITY_BAR_WIDTH * 2);
  let left = input.leftOpen
    ? clampPreferredDockWidth("left", input.preferredLeft ?? DEFAULT_LEFT_WIDTH)
    : 0;
  let right = input.rightOpen
    ? clampPreferredDockWidth("right", input.preferredRight ?? DEFAULT_RIGHT_WIDTH)
    : 0;

  const leftMin = left > 0 ? LEFT_DOCK_MIN : 0;
  const rightMin = right > 0 ? RIGHT_DOCK_MIN : 0;
  if (requiredWidth(leftMin, rightMin) <= usable) {
    let spare = usable - requiredWidth(leftMin, rightMin);
    const leftWant = left - leftMin;
    const leftExtra = Math.min(leftWant, spare);
    left = leftMin + leftExtra;
    spare -= leftExtra;
    right = rightMin + Math.min(right - rightMin, spare);
  } else if (left > 0 && right > 0) {
    const collapseFirst = input.leastRecentlyUsed ?? "right";
    if (collapseFirst === "right") right = 0;
    else left = 0;

    if (requiredWidth(left > 0 ? LEFT_DOCK_MIN : 0, right > 0 ? RIGHT_DOCK_MIN : 0) > usable) {
      left = 0;
      right = 0;
    } else if (left > 0) {
      left = Math.min(left, usable - CENTER_NOTE_MIN - PANE_SEPARATOR_SIZE);
    } else if (right > 0) {
      right = Math.min(right, usable - CENTER_NOTE_MIN - PANE_SEPARATOR_SIZE);
    }
  } else if (requiredWidth(leftMin, rightMin) > usable) {
    left = 0;
    right = 0;
  } else if (left > 0) {
    left = Math.min(left, usable - CENTER_NOTE_MIN - PANE_SEPARATOR_SIZE);
  } else if (right > 0) {
    right = Math.min(right, usable - CENTER_NOTE_MIN - PANE_SEPARATOR_SIZE);
  }

  left = Math.max(0, Math.round(left));
  right = Math.max(0, Math.round(right));
  const separators = (left > 0 ? PANE_SEPARATOR_SIZE : 0) +
    (right > 0 ? PANE_SEPARATOR_SIZE : 0);
  return {
    leftWidth: left,
    centerWidth: Math.max(0, usable - left - right - separators),
    rightWidth: right,
    leftCollapsed: input.leftOpen && left === 0,
    rightCollapsed: input.rightOpen && right === 0,
  };
}

export function dockResizeBounds(
  side: "left" | "right",
  viewportWidth: number,
  oppositeWidth: number,
): { min: number; max: number } {
  const min = side === "left" ? LEFT_DOCK_MIN : RIGHT_DOCK_MIN;
  const activity = ACTIVITY_BAR_WIDTH * 2;
  const separators = PANE_SEPARATOR_SIZE * (oppositeWidth > 0 ? 2 : 1);
  const available = finite(viewportWidth, 0) - activity - oppositeWidth - separators - CENTER_NOTE_MIN;
  return { min, max: Math.max(min, Math.min(SIDE_DOCK_MAX, Math.floor(available))) };
}

export function clampSplitRatio(
  size: number,
  ratio: number,
  firstMinimum: number,
  secondMinimum: number,
): number | null {
  const available = finite(size, 0) - PANE_SEPARATOR_SIZE;
  if (available < firstMinimum + secondMinimum) return null;
  const minRatio = firstMinimum / available;
  const maxRatio = 1 - secondMinimum / available;
  return Math.min(maxRatio, Math.max(minRatio, finite(ratio, 0.5)));
}

export function fitZoneSplit(input: {
  axis: SplitAxis;
  width: number;
  height: number;
  ratio: number;
  firstMinimum?: number;
  secondMinimum?: number;
}): { split: boolean; ratio: number } {
  const size = input.axis === "x" ? input.width : input.height;
  const defaultMinimum = input.axis === "x" ? TOOL_GROUP_MIN : GROUP_HEIGHT_MIN;
  const ratio = clampSplitRatio(
    size,
    input.ratio,
    input.firstMinimum ?? defaultMinimum,
    input.secondMinimum ?? defaultMinimum,
  );
  return ratio == null ? { split: false, ratio: input.ratio } : { split: true, ratio };
}
