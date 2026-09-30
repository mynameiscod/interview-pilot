import { z } from 'zod';
import { ANSWER_LIMITS } from './interview-runtime.js';
import { Difficulty } from './library.js';

/**
 * System design rounds. The round opens with a design prompt from the
 * design bank; the candidate sketches the design on a whiteboard (boxes and
 * arrows) and fills in structured notes, then submits. The interviewer then
 * asks follow-up probes about that design in the ordinary question flow.
 */

export const DESIGN_LIMITS = {
  maxNoteChars: 4000,
  maxNodes: 40,
  maxEdges: 80,
  maxLabelChars: 60,
  /** Board size in SVG units (nodes are placed inside it). */
  boardWidth: 1200,
  boardHeight: 800,
  autosaveMs: 5_000,
} as const;

const text = (max: number) => z.string().trim().max(max);

// ---- Design prompts (the bank) ------------------------------------------------------------

export const DesignPromptContent = z.object({
  title: text(120).min(3),
  /** What to design (plain text; blank-line paragraphs). */
  prompt: text(4000).min(20),
  difficulty: Difficulty,
  tags: z.array(text(40).min(2)).max(10),
  /** Shown to the candidate: what to think about (scale numbers, constraints). */
  focusAreas: z.array(text(200).min(3)).max(8),
  /** Never shown to the candidate: what a strong design considers (the evaluation rubric). */
  considerations: z.array(text(300).min(3)).min(1).max(12),
});
export type DesignPromptContent = z.infer<typeof DesignPromptContent>;

export const DesignPromptSummary = DesignPromptContent.extend({
  id: z.string(),
  key: z.string(),
  version: z.number().int(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type DesignPromptSummary = z.infer<typeof DesignPromptSummary>;

export const CreateDesignPromptVersionBody = z.object({
  key: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and - only'),
  content: DesignPromptContent,
  reason: text(300).min(3),
});
export type CreateDesignPromptVersionBody = z.infer<typeof CreateDesignPromptVersionBody>;

/** What the candidate sees of a prompt (no considerations). */
export const PublicDesignPrompt = DesignPromptContent.pick({
  title: true,
  prompt: true,
  difficulty: true,
  focusAreas: true,
}).extend({ id: z.string() });
export type PublicDesignPrompt = z.infer<typeof PublicDesignPrompt>;

// ---- The candidate's design ---------------------------------------------------------------

export const DesignNotes = z.object({
  requirements: z.string().max(DESIGN_LIMITS.maxNoteChars),
  api: z.string().max(DESIGN_LIMITS.maxNoteChars),
  dataModel: z.string().max(DESIGN_LIMITS.maxNoteChars),
  scaling: z.string().max(DESIGN_LIMITS.maxNoteChars),
  tradeOffs: z.string().max(DESIGN_LIMITS.maxNoteChars),
});
export type DesignNotes = z.infer<typeof DesignNotes>;
export const DESIGN_NOTE_SECTIONS = DesignNotes.keyof().options;

export const EMPTY_NOTES: DesignNotes = {
  requirements: '',
  api: '',
  dataModel: '',
  scaling: '',
  tradeOffs: '',
};

export const DiagramNodeKind = z.enum([
  'client',
  'service',
  'database',
  'cache',
  'queue',
  'storage',
  'external',
  'other',
]);
export type DiagramNodeKind = z.infer<typeof DiagramNodeKind>;

const itemId = z.string().regex(/^[a-z0-9-]{1,24}$/i);

export const DiagramNode = z.object({
  id: itemId,
  label: text(DESIGN_LIMITS.maxLabelChars).min(1),
  kind: DiagramNodeKind,
  x: z.number().min(0).max(DESIGN_LIMITS.boardWidth),
  y: z.number().min(0).max(DESIGN_LIMITS.boardHeight),
});
export type DiagramNode = z.infer<typeof DiagramNode>;

export const DiagramEdge = z.object({
  id: itemId,
  from: itemId,
  to: itemId,
  label: text(DESIGN_LIMITS.maxLabelChars),
});
export type DiagramEdge = z.infer<typeof DiagramEdge>;

export const Diagram = z
  .object({
    nodes: z.array(DiagramNode).max(DESIGN_LIMITS.maxNodes),
    edges: z.array(DiagramEdge).max(DESIGN_LIMITS.maxEdges),
  })
  .superRefine((d, ctx) => {
    const ids = new Set(d.nodes.map((n) => n.id));
    if (ids.size !== d.nodes.length) {
      ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'node ids must be unique' });
    }
    d.edges.forEach((e, i) => {
      if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) {
        ctx.addIssue({
          code: 'custom',
          path: ['edges', i],
          message: 'an arrow joins two different boxes',
        });
      }
    });
  });
export type Diagram = z.infer<typeof Diagram>;

export const EMPTY_DIAGRAM: Diagram = { nodes: [], edges: [] };

export const SaveDesignBody = z.object({ notes: DesignNotes, diagram: Diagram });
export type SaveDesignBody = z.infer<typeof SaveDesignBody>;

/** The design workspace for one design question. */
export const DesignWorkspace = z.object({
  questionId: z.string(),
  prompt: PublicDesignPrompt,
  notes: DesignNotes,
  diagram: Diagram,
  autosavedAt: z.iso.datetime().nullable(),
  /** Set once submitted: the design is then read-only (the probes follow). */
  submittedAt: z.iso.datetime().nullable(),
});
export type DesignWorkspace = z.infer<typeof DesignWorkspace>;

// ---- Text versions (prompts, evaluation, the transcript) -------------------------------------

const KIND_LABELS: Record<DiagramNodeKind, string> = {
  client: 'client',
  service: 'service',
  database: 'database',
  cache: 'cache',
  queue: 'queue',
  storage: 'object storage',
  external: 'external system',
  other: 'component',
};

/** The diagram as text: its boxes and its arrows, e.g. `API (service) -> Orders DB (database): writes`. */
export function diagramText(d: Diagram): string {
  if (d.nodes.length === 0) return '(empty diagram)';
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const name = (id: string) => byId.get(id)?.label ?? id;
  const boxes = d.nodes.map((n) => `- ${n.label} (${KIND_LABELS[n.kind]})`);
  const arrows = d.edges.map(
    (e) => `- ${name(e.from)} -> ${name(e.to)}${e.label.trim() ? `: ${e.label.trim()}` : ''}`,
  );
  const linked = new Set(d.edges.flatMap((e) => [e.from, e.to]));
  const alone = d.nodes.filter((n) => !linked.has(n.id)).map((n) => n.label);
  return [
    'Components:',
    ...boxes,
    'Connections:',
    ...(arrows.length ? arrows : ['- (none)']),
    ...(alone.length && arrows.length ? [`Not connected: ${alone.join(', ')}`] : []),
  ].join('\n');
}

export const NOTE_TITLES: Record<keyof DesignNotes, string> = {
  requirements: 'Requirements',
  api: 'API',
  dataModel: 'Data model',
  scaling: 'Scaling',
  tradeOffs: 'Trade-offs',
};

/** The notes as text, one titled section each (empty sections say so). */
export function notesText(n: DesignNotes): string {
  return DESIGN_NOTE_SECTIONS.map(
    (k) => `${NOTE_TITLES[k]}:\n${n[k].trim() || '(not written)'}`,
  ).join('\n\n');
}

/** The answer recorded for a submitted design (fits the answer limit). */
export function designAnswerText(notes: DesignNotes, diagram: Diagram): string {
  const head = 'Submitted a system design (notes and diagram).';
  const body = `${notesText(notes)}\n\nDiagram:\n${diagramText(diagram)}`;
  const room = ANSWER_LIMITS.maxChars - head.length - 4;
  return `${head}\n\n${body.length > room ? `${body.slice(0, room - 1)}…` : body}`;
}
