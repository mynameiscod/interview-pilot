import { keyedHash } from '@cbi/auth-core';
import {
  CampaignModel,
  ConsentModel,
  ConsentTextModel,
  InterviewSessionModel,
  InterviewTemplateModel,
  type ConsentTextRecord,
  type InterviewSessionRecord,
} from '@cbi/db';
import {
  consentRequirements,
  deviceCheckPassed,
  isSpokenMode,
  VOICE_LIMITS,
  type ConsentDecisionBody,
  type ConsentLocale,
  type ConsentTextSummary,
  type ConsentType,
  type CreateConsentTextBody,
  type SessionConsents,
  type UserConsentEntry,
  type VoiceReadiness,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';

type Session = InterviewSessionRecord;

const PRE_START = new Set(['READY', 'DEVICE_CHECK', 'CONSENT_REQUIRED', 'READY_TO_START']);

export const consentTextSummary = (t: ConsentTextRecord): ConsentTextSummary => ({
  id: String(t._id),
  type: t.type,
  version: t.version,
  locale: t.locale,
  title: t.title,
  body: t.body,
  active: t.active,
  reason: t.reason,
  createdAt: iso(t.createdAt),
});

/** The interview's language as a consent locale (auto → English). */
const localeOf = (s: Pick<Session, 'language'>): ConsentLocale =>
  s.language === 'hi' || s.language === 'te' ? s.language : 'en';

export function createConsentService(deps: { audit: AuditService; hashSecret: string }) {
  const { audit } = deps;

  /** The active text for a type in the locale, falling back to English. */
  async function activeText(type: ConsentType, locale: ConsentLocale) {
    return (
      (await ConsentTextModel.findOne({ type, locale, active: true }).lean<ConsentTextRecord>()) ??
      (locale === 'en'
        ? null
        : await ConsentTextModel.findOne({
            type,
            locale: 'en',
            active: true,
          }).lean<ConsentTextRecord>())
    );
  }

  /** A campaign's proctoring rules replace the template's for its interviews. */
  async function policyOf(s: Session) {
    if (s.campaignId) {
      const campaign = await CampaignModel.findById(s.campaignId, { proctoring: 1 }).lean();
      if (campaign) return campaign.proctoring;
    }
    const template = await InterviewTemplateModel.findById(s.templateId, {
      'content.proctoringPolicy': 1,
    }).lean();
    return (
      template?.content.proctoringPolicy ?? { recording: 'OFF' as const, tabSwitchTracking: false }
    );
  }

  async function sessionConsents(s: Session): Promise<SessionConsents> {
    const requirements = consentRequirements(s.mode, await policyOf(s), {
      campaign: Boolean(s.campaignId),
    });
    const items: SessionConsents['items'] = [];
    for (const r of requirements) {
      const text = await activeText(r.type, localeOf(s));
      if (!text) throw new Error(`no active consent text for ${r.type}`);
      const decision = (s.consents ?? []).find(
        (c) => c.type === r.type && String(c.consentTextId) === String(text._id),
      );
      items.push({
        type: r.type,
        required: r.required,
        text: {
          id: String(text._id),
          version: text.version,
          locale: text.locale,
          title: text.title,
          body: text.body,
        },
        decision: decision ? { accepted: decision.accepted, at: iso(decision.at) } : null,
      });
    }
    return {
      items,
      complete: items.every((i) => i.decision && (i.decision.accepted || !i.required)),
    };
  }

  async function own(userId: string, sessionId: string) {
    const s = await InterviewSessionModel.findOne({
      _id: objectId(sessionId, 'Interview'),
      userId,
    }).lean<Session>();
    if (!s) throw AppError.notFound('Interview not found');
    return s;
  }

  const accepted = (s: Pick<Session, 'consents'>, type: ConsentType) =>
    (s.consents ?? []).some((c) => c.type === type && c.accepted);

  return {
    sessionConsents,
    accepted,

    /** Device check (spoken modes) and consents, for the summary and the start gate. */
    async readiness(s: Session, now = new Date()) {
      const consents = await sessionConsents(s);
      const policy = await policyOf(s);
      const check = s.voice?.deviceCheck ?? null;
      const spoken = isSpokenMode(s.mode);
      const checkOk =
        !spoken ||
        (check !== null &&
          deviceCheckPassed(check, s.mode as 'VOICE' | 'VIDEO') &&
          now.getTime() - new Date(check.at).getTime() <= VOICE_LIMITS.deviceCheckMaxAgeMs);
      const recording =
        s.mode === 'VIDEO' && policy.recording !== 'OFF' && accepted(s, 'RECORDING');
      const voice: VoiceReadiness | null = spoken
        ? {
            deviceCheck: check ? { ...check, at: iso(check.at) } : null,
            consentsComplete: consents.complete,
            recording,
            ready: checkOk && consents.complete,
          }
        : null;
      let blocker: string | null = null;
      if (spoken) {
        if (!check) blocker = 'Run the device check before starting.';
        else if (!deviceCheckPassed(check, s.mode as 'VOICE' | 'VIDEO'))
          blocker =
            s.mode === 'VIDEO'
              ? 'Your camera or microphone check did not pass. Fix it or choose another mode.'
              : 'Your microphone check did not pass. Fix it or switch to a text interview.';
        else if (!checkOk) blocker = 'Your device check has expired. Please run it again.';
      }
      if (!blocker && !consents.complete) {
        blocker = 'Please review and respond to the consent notices before starting.';
      }
      return {
        voice,
        consentsPending: !consents.complete,
        recording,
        integrityTracking: policy.tabSwitchTracking && accepted(s, 'INTEGRITY'),
        blocker,
      };
    },

    async forSession(userId: string, sessionId: string) {
      return sessionConsents(await own(userId, sessionId));
    },

    /**
     * Records the candidate's decisions on the interview's current consent
     * texts. Every decision is kept in `consents`; the session holds the
     * latest one per type.
     */
    async decide(userId: string, sessionId: string, body: ConsentDecisionBody, ctx: ClientContext) {
      const s = await own(userId, sessionId);
      if (!PRE_START.has(s.state))
        throw new AppError(409, 'INVALID_STATE', 'Consent is given before the interview starts.');
      const current = await sessionConsents(s);
      const byText = new Map(current.items.map((i) => [i.text.id, i]));
      const now = new Date();
      const decided = body.decisions.map((d) => {
        const item = byText.get(d.consentTextId);
        if (!item)
          throw AppError.validation('That consent text is not current for this interview.');
        // Declining a required consent is recorded too; the interview then cannot start in this mode.
        return { item, accepted: d.accepted };
      });
      await transaction(async (tx) => {
        await ConsentModel.create(
          decided.map(({ item, accepted: ok }) => ({
            userId,
            sessionId: s._id,
            type: item.type,
            consentTextId: item.text.id,
            version: item.text.version,
            locale: item.text.locale,
            accepted: ok,
            at: now,
            ipHash: ctx.ip ? keyedHash(deps.hashSecret, `ip:${ctx.ip}`) : null,
            userAgent: ctx.userAgent || null,
          })),
          { session: tx, ordered: true },
        );
        const kept = (s.consents ?? []).filter((c) => !decided.some((d) => d.item.type === c.type));
        await InterviewSessionModel.updateOne(
          { _id: s._id },
          {
            $set: {
              consents: [
                ...kept,
                ...decided.map(({ item, accepted: ok }) => ({
                  type: item.type,
                  consentTextId: item.text.id,
                  version: item.text.version,
                  accepted: ok,
                  at: now,
                })),
              ],
            },
          },
          { session: tx },
        );
        await audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'interview.consent',
            resourceType: 'interviewSession',
            resourceId: sessionId,
            details: {
              decisions: decided.map((d) => ({
                type: d.item.type,
                version: d.item.text.version,
                accepted: d.accepted,
              })),
            },
          },
          ctx,
          tx,
        );
      });
      return sessionConsents((await InterviewSessionModel.findById(s._id).lean<Session>())!);
    },

    /** The candidate's consent history (privacy page). */
    async history(userId: string): Promise<UserConsentEntry[]> {
      const rows = await ConsentModel.find({ userId }).sort({ at: -1 }).limit(200).lean();
      const texts = new Map(
        (
          await ConsentTextModel.find(
            { _id: { $in: [...new Set(rows.map((r) => String(r.consentTextId)))] } },
            { title: 1 },
          ).lean()
        ).map((t) => [String(t._id), t.title]),
      );
      return rows.map((r) => ({
        id: String(r._id),
        type: r.type,
        version: r.version,
        locale: r.locale,
        title: texts.get(String(r.consentTextId)) ?? r.type,
        accepted: r.accepted,
        at: iso(r.at),
        sessionId: r.sessionId ? String(r.sessionId) : null,
      }));
    },

    // ---- Admin ----------------------------------------------------------------------------

    async listTexts(): Promise<ConsentTextSummary[]> {
      const rows = await ConsentTextModel.find()
        .sort({ type: 1, locale: 1, version: -1 })
        .lean<ConsentTextRecord[]>();
      return rows.map(consentTextSummary);
    },

    /** Adds the next version (inactive) for a type and locale. */
    async createText(body: CreateConsentTextBody, actorId: string, ctx: ClientContext) {
      return transaction(async (tx) => {
        const latest = await ConsentTextModel.findOne(
          { type: body.type, locale: body.locale },
          { version: 1 },
          { session: tx },
        )
          .sort({ version: -1 })
          .lean();
        const [text] = await ConsentTextModel.create(
          [
            {
              ...body,
              version: (latest?.version ?? 0) + 1,
              active: false,
              createdBy: actorId,
            },
          ],
          { session: tx },
        );
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'consent.text_created',
            resourceType: 'consentText',
            resourceId: String(text!._id),
            details: {
              type: body.type,
              locale: body.locale,
              version: text!.version,
              reason: body.reason,
            },
          },
          ctx,
          tx,
        );
        return consentTextSummary(text!.toObject());
      });
    },

    /**
     * Makes a version the one shown for its type and locale. Candidates who
     * accepted an older version are asked again before their next start.
     */
    async activateText(id: string, reason: string, actorId: string, ctx: ClientContext) {
      const textId = objectId(id, 'Consent text');
      return transaction(async (tx) => {
        const text = await ConsentTextModel.findById(textId, null, {
          session: tx,
        }).lean<ConsentTextRecord>();
        if (!text) throw AppError.notFound('Consent text not found');
        await ConsentTextModel.updateMany(
          { type: text.type, locale: text.locale, active: true, _id: { $ne: textId } },
          { $set: { active: false } },
          { session: tx },
        );
        await ConsentTextModel.updateOne(
          { _id: textId },
          { $set: { active: true } },
          { session: tx },
        );
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'consent.text_activated',
            resourceType: 'consentText',
            resourceId: id,
            details: { type: text.type, locale: text.locale, version: text.version, reason },
          },
          ctx,
          tx,
        );
        return consentTextSummary({ ...text, active: true });
      });
    },
  };
}

export type ConsentService = ReturnType<typeof createConsentService>;
