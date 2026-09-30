import { describe, expect, it } from 'vitest';
import { BOX, clampToBoard, edgePoint, nextId, nextPosition } from './board';

describe('whiteboard geometry', () => {
  it('gives new items the next free id', () => {
    expect(nextId('n', [])).toBe('n1');
    expect(nextId('n', [{ id: 'n1' }, { id: 'n7' }, { id: 'e9' }, { id: 'custom' }])).toBe('n8');
  });

  it('places new boxes on a grid inside the board and keeps moved boxes inside', () => {
    expect(nextPosition(0)).toEqual({ x: 24, y: 24 });
    expect(nextPosition(7)).toEqual({ x: 214, y: 134 });
    expect(clampToBoard(-50, 10_000)).toEqual({ x: 0, y: 800 - BOX.h });
  });

  it('starts arrows at the edge of the box they leave', () => {
    const a = { id: 'a', label: 'A', kind: 'service' as const, x: 0, y: 0 };
    const right = { ...a, id: 'b', x: 400 };
    expect(edgePoint(a, right)).toEqual({ x: BOX.w, y: BOX.h / 2 });
    const below = { ...a, id: 'c', y: 400 };
    expect(edgePoint(a, below)).toEqual({ x: BOX.w / 2, y: BOX.h });
    expect(edgePoint(a, a)).toEqual({ x: BOX.w / 2, y: BOX.h / 2 });
  });
});
