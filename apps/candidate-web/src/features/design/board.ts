import { DESIGN_LIMITS, type DiagramNode } from '@cbi/shared-types';

/** Box size on the whiteboard (SVG units). */
export const BOX = { w: 150, h: 56 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keeps a box inside the board. */
export const clampToBoard = (x: number, y: number) => ({
  x: Math.round(clamp(x, 0, DESIGN_LIMITS.boardWidth - BOX.w)),
  y: Math.round(clamp(y, 0, DESIGN_LIMITS.boardHeight - BOX.h)),
});

/** The next free id with a prefix (`n3`, `e7`). */
export function nextId(prefix: string, used: readonly { id: string }[]): string {
  const n = used.reduce((max, x) => {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(x.id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `${prefix}${n + 1}`;
}

/** Where a new box goes: the next cell of a loose grid. */
export function nextPosition(count: number): { x: number; y: number } {
  const perRow = 6;
  return clampToBoard(24 + (count % perRow) * 190, 24 + Math.floor(count / perRow) * 110);
}

/** Where the line between two box centres meets the edge of the first box. */
export function edgePoint(from: DiagramNode, to: DiagramNode) {
  const cx = from.x + BOX.w / 2;
  const cy = from.y + BOX.h / 2;
  const dx = to.x + BOX.w / 2 - cx;
  const dy = to.y + BOX.h / 2 - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Infinity : BOX.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : BOX.h / 2 / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}
