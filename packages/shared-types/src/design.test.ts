import { describe, expect, it } from 'vitest';
import {
  designAnswerText,
  Diagram,
  diagramText,
  EMPTY_NOTES,
  notesText,
  SaveDesignBody,
} from './design.js';
import { ANSWER_LIMITS } from './interview-runtime.js';

const diagram = {
  nodes: [
    { id: 'web', label: 'Web app', kind: 'client' as const, x: 10, y: 10 },
    { id: 'api', label: 'Links API', kind: 'service' as const, x: 200, y: 10 },
    { id: 'db', label: 'Links DB', kind: 'database' as const, x: 400, y: 10 },
    { id: 'q', label: 'Clicks queue', kind: 'queue' as const, x: 400, y: 200 },
  ],
  edges: [
    { id: 'e1', from: 'web', to: 'api', label: 'HTTPS' },
    { id: 'e2', from: 'api', to: 'db', label: '' },
  ],
};

describe('diagram', () => {
  it('describes boxes and arrows as text, naming unconnected boxes', () => {
    expect(diagramText(diagram)).toBe(
      [
        'Components:',
        '- Web app (client)',
        '- Links API (service)',
        '- Links DB (database)',
        '- Clicks queue (queue)',
        'Connections:',
        '- Web app -> Links API: HTTPS',
        '- Links API -> Links DB',
        'Not connected: Clicks queue',
      ].join('\n'),
    );
    expect(diagramText({ nodes: [], edges: [] })).toBe('(empty diagram)');
  });

  it('refuses arrows to missing boxes, self-loops and duplicate ids', () => {
    expect(Diagram.safeParse(diagram).success).toBe(true);
    const bad = (d: unknown) => Diagram.safeParse(d).success;
    expect(bad({ ...diagram, edges: [{ id: 'x', from: 'api', to: 'nope', label: '' }] })).toBe(
      false,
    );
    expect(bad({ ...diagram, edges: [{ id: 'x', from: 'api', to: 'api', label: '' }] })).toBe(
      false,
    );
    expect(bad({ nodes: [diagram.nodes[0], diagram.nodes[0]], edges: [] })).toBe(false);
    expect(bad({ nodes: [{ ...diagram.nodes[0]!, x: 99_999 }], edges: [] })).toBe(false);
  });
});

describe('design answer', () => {
  it('writes the notes by section and the diagram, within the answer limit', () => {
    const notes = {
      ...EMPTY_NOTES,
      requirements: 'Redirect in 50 ms.',
      tradeOffs: '302 for counts',
    };
    expect(notesText(notes)).toContain('Requirements:\nRedirect in 50 ms.');
    expect(notesText(notes)).toContain('API:\n(not written)');
    const text = designAnswerText(notes, diagram);
    expect(text.startsWith('Submitted a system design (notes and diagram).')).toBe(true);
    expect(text).toContain('Web app -> Links API: HTTPS');
    const long = designAnswerText(
      { ...notes, api: 'x'.repeat(4000), dataModel: 'y'.repeat(4000) },
      diagram,
    );
    expect(long.length).toBeLessThanOrEqual(ANSWER_LIMITS.maxChars);
    expect(SaveDesignBody.safeParse({ notes, diagram }).success).toBe(true);
  });
});
