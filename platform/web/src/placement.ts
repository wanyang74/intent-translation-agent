// Where the overlay's panel sits: the box the user dragged and resized it to, and whether it's folded down to its
// header. The overlay (overlay.ts) applies it and reports changes; the host keeps it per site (the extension in its
// local storage), so the next page puts the panel back. Pure arithmetic, no DOM, so it's tested in Node. The rule it
// keeps: a box is always wholly inside the window and no smaller than the minimum, unless the window itself is smaller.
// Platform code: nothing here names a site.

/** The panel's box, in CSS pixels from the window's top left. */
export interface PanelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What's kept between pages. With no box, the panel sits in its default place at the window's right edge. */
export interface PanelPlacement {
  box: PanelBox | null;
  folded: boolean;
}

/** The window's inner size. */
export interface Viewport {
  width: number;
  height: number;
}

/** The smallest the panel can be resized to: room for a card and the message box. */
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 360;
/** The gap kept between the panel and the window's edges. */
export const EDGE_GAP = 8;

/** The edges a resize grip moves. */
export type ResizeEdge = 'left' | 'top' | 'bottom-left';

/** A number between low and high; when the range is empty (a tiny window), low gives way to high. */
const clamp = (value: number, low: number, high: number) => Math.max(Math.min(value, high), Math.min(low, high));

/** The box made to fit the window: at least the minimum size, at most the window, and wholly inside it. */
export function fitBox(box: PanelBox, viewport: Viewport): PanelBox {
  const width = clamp(box.width, MIN_WIDTH, viewport.width - 2 * EDGE_GAP);
  const height = clamp(box.height, MIN_HEIGHT, viewport.height - 2 * EDGE_GAP);
  return {
    left: clamp(box.left, EDGE_GAP, viewport.width - width - EDGE_GAP),
    top: clamp(box.top, EDGE_GAP, viewport.height - height - EDGE_GAP),
    width,
    height,
  };
}

/** The box moved by a drag, kept inside the window. */
export function movedBox(start: PanelBox, deltaX: number, deltaY: number, viewport: Viewport): PanelBox {
  return fitBox({ ...start, left: start.left + deltaX, top: start.top + deltaY }, viewport);
}

/**
 * The box resized by dragging one of its grips.
 *   1. Left edge: the right edge stays put; the width grows as the grip moves left, down to the minimum and up to
 *      the window's left gap.
 *   2. Top edge: the bottom stays put, the same way.
 *   3. Bottom-left corner: the left edge as in 1, and the bottom follows the grip down to the window's bottom gap.
 */
export function resizedBox(start: PanelBox, edge: ResizeEdge, deltaX: number, deltaY: number, viewport: Viewport): PanelBox {
  const box = { ...start };
  // 1. and 3. The left edge.
  if (edge === 'left' || edge === 'bottom-left') {
    const right = start.left + start.width;
    box.width = clamp(start.width - deltaX, MIN_WIDTH, right - EDGE_GAP);
    box.left = right - box.width;
  }
  // 2. The top edge.
  if (edge === 'top') {
    const bottom = start.top + start.height;
    box.height = clamp(start.height - deltaY, MIN_HEIGHT, bottom - EDGE_GAP);
    box.top = bottom - box.height;
  }
  // 3. The bottom edge.
  if (edge === 'bottom-left') box.height = clamp(start.height + deltaY, MIN_HEIGHT, viewport.height - EDGE_GAP - start.top);
  return fitBox(box, viewport);
}

/** A placement read back from storage, if it has the right shape; anything else is dropped. */
export function placementOf(value: unknown): PanelPlacement | null {
  if (!value || typeof value !== 'object') return null;
  const { box, folded } = value as { box?: unknown; folded?: unknown };
  if (typeof folded !== 'boolean') return null;
  if (box === null) return { box: null, folded };
  const sides = box as Partial<Record<keyof PanelBox, unknown>> | undefined;
  const numbers = sides && [sides.left, sides.top, sides.width, sides.height].every((side) => typeof side === 'number' && Number.isFinite(side));
  return numbers ? { box: { left: sides.left as number, top: sides.top as number, width: sides.width as number, height: sides.height as number }, folded } : null;
}
