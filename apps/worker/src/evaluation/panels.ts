import { untrusted } from '@cbi/ai-core';
import type { InterviewTurnRecord } from '@cbi/db';
import {
  CODING_LANGUAGE_LABELS,
  diagramText,
  notesText,
  PANEL_DIMENSIONS,
  PanelScoresAi,
  toAssessmentPanel,
  type AssessmentPanel,
  type PanelKind,
} from '@cbi/shared-types';
import { runAiStep, type AiCallContext, type AiStepDeps } from './ai-steps.js';
import type { CodingContext } from './coding.js';
import { hasDesign, type DesignContext } from './design.js';

/**
 * Assessment panels: fixed dimensions scored from one kind of work, beside
 * the role's dimensions and never part of the weighted overall score. When
 * the model is unavailable the panel is kept with nothing scored.
 */

const dimensionList = (kind: PanelKind) =>
  PANEL_DIMENSIONS[kind].map((d) => `${d.key}: ${d.name}`).join('\n');

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n…` : s);

/** The conversation with the coding assistant, as the model and the quote check read it. */
export function assistantTranscript(coding: CodingContext): {
  subjects: string[];
  conversation: string;
  final: string;
} | null {
  const used = coding.attempts.filter((a) => (a.assistant?.messages.length ?? 0) > 0);
  if (used.length === 0) return null;
  const subjects: string[] = [];
  const conversation: string[] = [];
  const final: string[] = [];
  for (const a of used) {
    const title = coding.problems.get(String(a.problemId))?.content.title ?? 'Coding problem';
    subjects.push(title);
    conversation.push(`## ${title}`);
    for (const m of a.assistant!.messages) {
      if (m.role === 'CANDIDATE') {
        conversation.push(`Candidate: ${m.text}`);
        if (m.codeSnapshot) {
          conversation.push(`(Candidate's code when asking)\n${clip(m.codeSnapshot, 1500)}`);
        }
      } else {
        conversation.push(
          m.unavailable
            ? 'Assistant: (unavailable, no answer)'
            : `Assistant${m.redacted ? ' (long code removed)' : ''}: ${m.text}`,
        );
      }
    }
    const sub = a.submission;
    final.push(
      `## ${title} (${CODING_LANGUAGE_LABELS[sub?.language ?? a.language]})\n${
        sub?.result
          ? `${sub.result.passed} of ${sub.result.total} tests passed.`
          : sub
            ? 'The code was not run (judge unavailable).'
            : 'Not submitted.'
      }\n${clip(sub?.code ?? a.code, 4000)}`,
    );
  }
  return { subjects, conversation: conversation.join('\n\n'), final: final.join('\n\n') };
}

/**
 * The system design material of a session: per design, the prompt and its
 * rubric, the notes, the diagram as text, and the round's probes with the
 * candidate's answers. Null when the interview had no design with content.
 */
export function designMaterial(
  design: DesignContext,
  turns: readonly Pick<InterviewTurnRecord, 'roundIdx' | 'question' | 'answer' | 'seq'>[],
): {
  subjects: string[];
  prompt: string;
  rubric: string;
  notes: string;
  diagram: string;
  answers: string;
} | null {
  const used = design.attempts.filter(hasDesign);
  if (used.length === 0) return null;
  const parts = { prompt: [] as string[], rubric: [] as string[], notes: [] as string[] };
  const diagrams: string[] = [];
  const answers: string[] = [];
  const subjects: string[] = [];
  for (const a of used) {
    const p = design.prompts.get(String(a.promptId));
    const title = p?.content.title ?? 'System design';
    subjects.push(title);
    parts.prompt.push(`## ${title}\n${p?.content.prompt ?? ''}`);
    parts.rubric.push(...(p?.content.considerations ?? []).map((c) => `- ${c}`));
    parts.notes.push(`## ${title}\n${notesText(a.notes)}`);
    diagrams.push(`## ${title}\n${diagramText(a.diagram)}`);
    for (const t of [...turns].sort((x, y) => x.seq - y.seq)) {
      if (t.roundIdx !== a.roundIdx || t.question.design) continue;
      answers.push(`Question: ${t.question.text}\nAnswer: ${t.answer?.text ?? '(no answer)'}`);
    }
  }
  return {
    subjects,
    prompt: parts.prompt.join('\n\n'),
    rubric: parts.rubric.join('\n') || '-',
    notes: parts.notes.join('\n\n'),
    diagram: diagrams.join('\n\n'),
    answers: answers.join('\n\n') || '(no follow-up questions)',
  };
}

/** The system design dimensions, from the notes, the diagram and the answers to the probes. */
export async function systemDesignPanel(
  deps: AiStepDeps,
  input: { role: string; design: DesignContext; turns: Parameters<typeof designMaterial>[1] },
  ctx?: AiCallContext,
): Promise<AssessmentPanel | null> {
  const m = designMaterial(input.design, input.turns);
  if (!m) return null;
  const result = await runAiStep(
    deps,
    'evaluation.systemDesign',
    PanelScoresAi,
    {
      role: input.role,
      dimensions: dimensionList('systemDesign'),
      prompt: m.prompt,
      rubric: m.rubric,
      notes: untrusted(clip(m.notes, 16_000)),
      diagram: untrusted(clip(m.diagram, 6_000)),
      answers: untrusted(clip(m.answers, 12_000)),
    },
    ctx,
  );
  return toAssessmentPanel(
    'systemDesign',
    m.subjects,
    result,
    `${m.notes}\n${m.diagram}\n${m.answers}`,
  );
}

/** How the candidate worked with the assistant of AI-allowed rounds; null when it was not used. */
export async function aiCollaborationPanel(
  deps: AiStepDeps,
  coding: CodingContext,
  ctx?: AiCallContext,
): Promise<AssessmentPanel | null> {
  const t = assistantTranscript(coding);
  if (!t) return null;
  const result = await runAiStep(
    deps,
    'evaluation.aiCollaboration',
    PanelScoresAi,
    {
      dimensions: dimensionList('aiCollaboration'),
      problems: t.subjects.map((s) => `- ${s}`).join('\n'),
      conversation: untrusted(clip(t.conversation, 24_000)),
      final: untrusted(t.final),
    },
    ctx,
  );
  // Quotes must come from what the candidate wrote (their messages and code).
  return toAssessmentPanel('aiCollaboration', t.subjects, result, `${t.conversation}\n${t.final}`);
}
