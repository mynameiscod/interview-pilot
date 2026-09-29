import { untrusted } from '@cbi/ai-core';
import {
  CODING_LANGUAGE_LABELS,
  PANEL_DIMENSIONS,
  PanelScoresAi,
  toAssessmentPanel,
  type AssessmentPanel,
  type PanelKind,
} from '@cbi/shared-types';
import { runAiStep, type AiCallContext, type AiStepDeps } from './ai-steps.js';
import type { CodingContext } from './coding.js';

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
