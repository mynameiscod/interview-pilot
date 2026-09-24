import { renderPrompt, untrusted, type PromptValue } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import type { Logger } from '@cbi/config';
import {
  CompanyModel,
  contentHash,
  InterviewSessionModel,
  InterviewTemplateModel,
  JobTargetModel,
  mongoose,
  ResumeModel,
  CampaignModel,
  RoleBlueprintModel,
  RoleModel,
  transitionSession,
  type InterviewSessionRecord,
  type RoleBlueprintRecord,
  type RoleRecord,
} from '@cbi/db';
import {
  BlueprintDraftAi,
  RoleAnalysisAi,
  templateDurationSec,
  type AiFeature,
  type AnalysisFailureCode,
  type BlueprintContent,
  type RoleAnalysis,
} from '@cbi/shared-types';
import type { z } from 'zod';
import {
  analysisFromBlueprint,
  matchRoleByTitle,
  normalizeBlueprintDraft,
  planRounds,
} from '../analysis/blueprint.js';

export interface AnalysisProcessorDeps {
  ai: AiRuntime;
  logger: Logger;
  /** How long analysis waits for inputs that are still being extracted. */
  inputWaitMs?: number;
  now?: () => Date;
}

/** Input text sent to analysis prompts (cost control). */
export const ANALYSIS_INPUT_CHARS = 12_000;
export const DEFAULT_INPUT_WAIT_MS = 3 * 60_000;

export type AnalysisOutcome = { status: 'done' } | { status: 'wait'; retryInMs: number };

const IN_PROGRESS = new Set(['PENDING', 'PROCESSING']);

async function runPrompt<T>(
  deps: AnalysisProcessorDeps,
  feature: AiFeature,
  schema: z.ZodType<T>,
  values: Record<string, PromptValue>,
  ctx: { userId: string; sessionId: string },
): Promise<{ data: T; model: string; promptVersion: number } | null> {
  const prompt = await deps.ai.prompts.getActive(feature);
  if (!prompt) {
    deps.logger.error({ feature }, 'no active prompt');
    return null;
  }
  try {
    const result = await deps.ai.router.run<T>(
      feature,
      {
        messages: renderPrompt(prompt, values),
        output: { name: feature.replace('.', '_'), schema },
      },
      { ...ctx, prompt: { key: prompt.key, version: prompt.version } },
    );
    return { data: result.data, model: result.model.modelId, promptVersion: prompt.version };
  } catch (err) {
    deps.logger.warn({ err, feature, sessionId: ctx.sessionId }, 'ai step failed');
    return null;
  }
}

async function fail(session: InterviewSessionRecord, code: AnalysisFailureCode, now: Date) {
  await transitionSession({
    sessionId: session._id,
    from: 'ROLE_ANALYSIS',
    to: 'FAILED',
    expectedVersion: session.stateVersion,
    set: { failure: { code, at: now } },
    reason: code,
    now,
  });
}

/** Verified company notes only: unverified notes never influence interviews. */
async function companyNotes(companyId: unknown): Promise<string[]> {
  if (!companyId) return [];
  const company = await CompanyModel.findOne({ _id: companyId, active: true }).lean();
  return (company?.verifiedPatterns ?? []).filter((p) => p.verifiedAt).map((p) => p.note);
}

async function activeBlueprint(role: RoleRecord | null): Promise<RoleBlueprintRecord | null> {
  if (!role?.activeBlueprintId) return null;
  return RoleBlueprintModel.findOne({ _id: role.activeBlueprintId, status: 'ACTIVE' }).lean();
}

/**
 * ROLE_ANALYSIS → READY (or FAILED). Idempotent: a session that already
 * left ROLE_ANALYSIS is ignored, and the final transition is conditional on
 * the stateVersion read at the start.
 */
export async function processInterviewAnalyze(
  deps: AnalysisProcessorDeps,
  sessionId: string,
  finalAttempt: boolean,
): Promise<AnalysisOutcome> {
  const now = deps.now?.() ?? new Date();
  const session = await InterviewSessionModel.findOne({
    _id: sessionId,
    state: 'ROLE_ANALYSIS',
  }).lean();
  if (!session) return { status: 'done' };

  try {
    return await analyze(deps, session, now);
  } catch (err) {
    if (finalAttempt) await fail(session, 'INTERNAL', now);
    throw err;
  }
}

async function analyze(
  deps: AnalysisProcessorDeps,
  session: InterviewSessionRecord,
  now: Date,
): Promise<AnalysisOutcome> {
  const ctx = { userId: String(session.userId), sessionId: String(session._id) };
  const [target, resume, template] = await Promise.all([
    JobTargetModel.findOne({ _id: session.jobTargetId, userId: session.userId }).lean(),
    session.resumeId
      ? ResumeModel.findOne({ _id: session.resumeId, userId: session.userId }).lean()
      : null,
    InterviewTemplateModel.findById(session.templateId).lean(),
  ]);
  if (!target || !template || (session.resumeId && !resume)) {
    await fail(session, 'INPUT_FAILED', now);
    return { status: 'done' };
  }

  // Wait for extraction, bounded by the time spent in ROLE_ANALYSIS.
  const inputs = [target.extraction.status, resume?.extraction.status];
  if (inputs.some((s) => s && IN_PROGRESS.has(s))) {
    const enteredAt =
      session.stateHistory.findLast((h) => h.to === 'ROLE_ANALYSIS')?.at ?? session.updatedAt;
    if (
      now.getTime() - new Date(enteredAt).getTime() >
      (deps.inputWaitMs ?? DEFAULT_INPUT_WAIT_MS)
    ) {
      await fail(session, 'INPUT_TIMEOUT', now);
      return { status: 'done' };
    }
    return { status: 'wait', retryInMs: 2000 };
  }
  if (inputs.includes('FAILED')) {
    await fail(session, 'INPUT_FAILED', now);
    return { status: 'done' };
  }

  const jdText = target.rawText?.slice(0, ANALYSIS_INPUT_CHARS) ?? '';
  const resumeText = resume?.rawText?.slice(0, ANALYSIS_INPUT_CHARS) ?? '';
  const [roles, notes, chosenRole] = await Promise.all([
    RoleModel.find({ active: true }).lean(),
    companyNotes(target.companyId),
    target.roleId ? RoleModel.findOne({ _id: target.roleId, active: true }).lean() : null,
  ]);
  const roleTitle = target.roleTitle?.trim() || chosenRole?.title || target.structured?.title || '';
  const notesText = notes.map((n) => `- ${n}`).join('\n');

  // ---- Role analysis -----------------------------------------------------------
  const analyzed = await runPrompt(
    deps,
    'role.analyze',
    RoleAnalysisAi,
    {
      libraryRoles: roles.map((r) => `${r.slug}: ${r.title}`).join('\n'),
      roleTitle: untrusted(roleTitle),
      jd: untrusted(jdText),
      resume: untrusted(resumeText),
      companyNotes: notesText,
    },
    ctx,
  );
  const chosenCanonical = await activeBlueprint(chosenRole);
  let ai: RoleAnalysisAi;
  if (analyzed) {
    ai = analyzed.data;
  } else if (chosenCanonical) {
    ai = analysisFromBlueprint(chosenCanonical.content);
  } else {
    await fail(session, 'AI_UNAVAILABLE', now);
    return { status: 'done' };
  }
  if (!resumeText) {
    // The model cannot have seen resume evidence that was never sent.
    ai = { ...ai, resumeHighlights: [], skills: ai.skills.map((s) => ({ ...s, inResume: false })) };
  }

  const matchedRole =
    chosenRole ??
    roles.find((r) => r.slug === ai.matchedRoleSlug) ??
    roles.find((r) => r.slug === matchRoleByTitle(ai.roleTitle, roles)) ??
    null;
  const canonical = chosenRole ? chosenCanonical : await activeBlueprint(matchedRole);

  // ---- Blueprint: canonical as-is for a bare role, generated when there is context ----
  let blueprint: {
    id: string;
    origin: 'CANONICAL' | 'AI_GENERATED';
    version: number;
    content: BlueprintContent;
  };
  const promptVersions: Record<string, number> = { ...session.promptVersions };
  if (analyzed) promptVersions['role.analyze'] = analyzed.promptVersion;

  // A campaign pins one blueprint so every candidate is assessed on the same competencies.
  const pinned = session.campaignId
    ? await CampaignModel.findById(session.campaignId, { blueprintId: 1 })
        .lean()
        .then((c) => (c ? RoleBlueprintModel.findById(c.blueprintId).lean() : null))
    : null;
  const hasContext = Boolean(jdText || resumeText);
  const generated =
    !pinned && (hasContext || !canonical)
      ? await runPrompt(
          deps,
          'blueprint.generate',
          BlueprintDraftAi,
          {
            analysis: untrusted(JSON.stringify(ai)),
            jd: untrusted(jdText),
            resume: untrusted(resumeText),
            companyNotes: notesText,
          },
          ctx,
        )
      : null;
  let generatedContent: BlueprintContent | null = null;
  if (generated) {
    try {
      generatedContent = normalizeBlueprintDraft(generated.data);
    } catch (err) {
      deps.logger.warn({ err, sessionId: ctx.sessionId }, 'generated blueprint rejected');
    }
  }

  if (pinned) {
    blueprint = {
      id: String(pinned._id),
      origin: pinned.origin === 'AI_GENERATED' ? 'AI_GENERATED' : 'CANONICAL',
      version: pinned.version,
      content: pinned.content,
    };
  } else if (generated && generatedContent) {
    const [doc] = await RoleBlueprintModel.create([
      {
        roleId: null,
        origin: 'AI_GENERATED',
        version: 1,
        status: 'ACTIVE',
        content: generatedContent,
        contentHash: contentHash(generatedContent),
        generatedBy: { model: generated.model, promptVersion: generated.promptVersion },
        sourceJobTargetId: target._id,
        userId: session.userId,
        activatedAt: now,
      },
    ]);
    promptVersions['blueprint.generate'] = generated.promptVersion;
    blueprint = {
      id: String(doc!._id),
      origin: 'AI_GENERATED',
      version: 1,
      content: generatedContent,
    };
  } else if (canonical) {
    blueprint = {
      id: String(canonical._id),
      origin: 'CANONICAL',
      version: canonical.version,
      content: canonical.content,
    };
  } else {
    await fail(session, 'AI_UNAVAILABLE', now);
    return { status: 'done' };
  }

  const analysis: RoleAnalysis = {
    detectedRole: {
      title: ai.roleTitle,
      family: ai.family,
      seniority: ai.seniority,
      confidence: ai.confidence,
    },
    matchedRole: matchedRole ? { id: String(matchedRole._id), title: matchedRole.title } : null,
    blueprint: { id: blueprint.id, origin: blueprint.origin, version: blueprint.version },
    skills: ai.skills,
    resumeHighlights: ai.resumeHighlights,
    gaps: ai.gaps,
    inputs: { resume: Boolean(resumeText), jd: Boolean(jdText), companyPatterns: notes.length > 0 },
    plannedRounds: planRounds(template.content, blueprint.content),
    totalDurationSec: templateDurationSec(template.content),
    analyzedAt: now.toISOString(),
  };

  const updated = await transitionSession({
    sessionId: session._id,
    from: 'ROLE_ANALYSIS',
    to: 'READY',
    expectedVersion: session.stateVersion,
    set: {
      blueprintId: new mongoose.Types.ObjectId(blueprint.id),
      analysis,
      failure: null,
      promptVersions,
    },
    reason: 'analysis complete',
    now,
  });
  deps.logger.info(
    { sessionId: ctx.sessionId, origin: blueprint.origin, applied: Boolean(updated) },
    'interview analysed',
  );
  return { status: 'done' };
}
