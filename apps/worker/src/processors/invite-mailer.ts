import type { Logger } from '@cbi/config';
import {
  CampaignInviteModel,
  CampaignModel,
  inviteTokenContext,
  type CampaignInviteRecord,
  type CampaignRecord,
} from '@cbi/db';
import type { EmailProvider } from '@cbi/provider-adapters';
import { INVITE_REMINDER_MAX } from '@cbi/shared-types';
import { inviteEmail } from './invite-messages.js';

/**
 * Emails organisations' campaign invites and their reminders. Each invite
 * carries `nextSendAt`: the API sets it to "now" for a new invite; after
 * the invite and each reminder the worker sets the next reminder time, or
 * null when nothing more is due (at most two reminders; none once the
 * candidate has joined, the invite is revoked or the campaign is over).
 */

/** Send attempts before an invite is marked FAILED (reminders are simply dropped). */
export const INVITE_SEND_ATTEMPTS = 3;
/** Wait after a failed send before trying again. */
export const INVITE_RETRY_MS = 10 * 60_000;
/** Draft and paused campaigns are checked again after this. */
export const INVITE_DEFER_MS = 15 * 60_000;
/** A claimed invite is left alone by other workers this long. */
const CLAIM_MS = 5 * 60_000;

export type InviteStep =
  | { kind: 'invite' }
  | { kind: 'reminder'; number: number }
  | { kind: 'defer'; until: Date }
  | { kind: 'stop' };

type InviteState = Pick<
  CampaignInviteRecord,
  'status' | 'sentAt' | 'remindersSent' | 'lastReminderAt'
>;
type CampaignState = Pick<CampaignRecord, 'status' | 'window' | 'reminders'> | null;

/** What to do with a due invite now (pure; unit-tested). */
export function nextInviteStep(
  invite: InviteState,
  campaign: CampaignState,
  now: Date,
): InviteStep {
  if (!['PENDING', 'SENT', 'OPENED'].includes(invite.status)) return { kind: 'stop' };
  if (!campaign || campaign.status === 'CLOSED') return { kind: 'stop' };
  if (campaign.window.endAt && now >= campaign.window.endAt) return { kind: 'stop' };
  // Draft links do not work yet, and a paused campaign cannot be joined: wait.
  if (campaign.status === 'DRAFT' || campaign.status === 'PAUSED') {
    return { kind: 'defer', until: new Date(now.getTime() + INVITE_DEFER_MS) };
  }
  if (!invite.sentAt) return { kind: 'invite' };
  const reminders = campaign.reminders;
  const max = Math.min(reminders?.max ?? 0, INVITE_REMINDER_MAX);
  if (!reminders?.enabled || invite.remindersSent >= max) return { kind: 'stop' };
  const due = new Date(
    (invite.lastReminderAt ?? invite.sentAt).getTime() + reminders.intervalHours * 3600_000,
  );
  if (now < due) return { kind: 'defer', until: due };
  return { kind: 'reminder', number: invite.remindersSent + 1 };
}

/** When the next reminder is due after a send, or null when none is left. */
export function nextReminderAt(
  campaign: Pick<CampaignRecord, 'reminders'>,
  remindersSent: number,
  now: Date,
): Date | null {
  const r = campaign.reminders;
  if (!r?.enabled || remindersSent >= Math.min(r.max, INVITE_REMINDER_MAX)) return null;
  return new Date(now.getTime() + r.intervalHours * 3600_000);
}

export interface InviteMailerDeps {
  email: EmailProvider;
  /** Live check (admin-managed integrations); without email nothing is sent and invites wait. */
  emailEnabled?: () => boolean;
  secrets: { decrypt(secret: CampaignInviteRecord['tokenEnc'], context: string): string };
  candidateUrl: string;
  logger: Logger;
  batch?: number;
  now?: () => Date;
}

export async function runInviteMailer(deps: InviteMailerDeps) {
  const counts = { invites: 0, reminders: 0, deferred: 0, stopped: 0, failed: 0 };
  if (deps.emailEnabled && !deps.emailEnabled()) return counts;
  const now = deps.now ?? (() => new Date());
  const due = await CampaignInviteModel.find({ nextSendAt: { $lte: now() } }, { _id: 1 })
    .sort({ nextSendAt: 1 })
    .limit(deps.batch ?? 200)
    .lean();
  const campaigns = new Map<string, CampaignRecord | null>();
  for (const { _id } of due) {
    const at = now();
    // Claim it, so a parallel run (another replica) skips it.
    const invite = await CampaignInviteModel.findOneAndUpdate(
      { _id, nextSendAt: { $lte: at } },
      { $set: { nextSendAt: new Date(at.getTime() + CLAIM_MS) } },
      { returnDocument: 'after' },
    ).lean<CampaignInviteRecord>();
    if (!invite) continue;
    const key = String(invite.campaignId);
    if (!campaigns.has(key)) {
      campaigns.set(key, await CampaignModel.findById(invite.campaignId).lean<CampaignRecord>());
    }
    const campaign = campaigns.get(key) ?? null;
    const step = nextInviteStep(invite, campaign, at);
    if (step.kind === 'stop' || step.kind === 'defer') {
      await CampaignInviteModel.updateOne(
        { _id: invite._id },
        { $set: { nextSendAt: step.kind === 'defer' ? step.until : null } },
      );
      counts[step.kind === 'defer' ? 'deferred' : 'stopped']++;
      continue;
    }
    const token = deps.secrets.decrypt(invite.tokenEnc, inviteTokenContext(String(invite._id)));
    const message = inviteEmail(invite.language, {
      name: invite.name,
      companyName: campaign!.companyName,
      roleTitle: campaign!.roleTitle,
      link: `${deps.candidateUrl.replace(/\/$/, '')}/campaign/i/${token}`,
      endAt: campaign!.window.endAt,
      reminder: step.kind === 'reminder' ? step.number : undefined,
    });
    try {
      await deps.email.send({ to: invite.email, ...message });
    } catch (err) {
      const attempts = invite.sendAttempts + 1;
      const giveUp = attempts >= INVITE_SEND_ATTEMPTS;
      deps.logger.warn({ err, inviteId: String(invite._id), attempts }, 'invite email failed');
      await CampaignInviteModel.updateOne(
        { _id: invite._id },
        {
          $set: {
            sendAttempts: giveUp ? 0 : attempts,
            lastError: 'The email could not be sent.',
            nextSendAt: giveUp ? null : new Date(at.getTime() + INVITE_RETRY_MS),
            // A first invite that cannot be sent is FAILED; a missed reminder is only dropped.
            ...(giveUp && step.kind === 'invite' ? { status: 'FAILED' } : {}),
          },
        },
      );
      counts.failed++;
      continue;
    }
    if (step.kind === 'invite') {
      await CampaignInviteModel.updateOne(
        { _id: invite._id },
        {
          $set: {
            sentAt: at,
            sendAttempts: 0,
            lastError: null,
            nextSendAt: nextReminderAt(campaign!, 0, at),
          },
        },
      );
      // Opened or joined meanwhile stays as it is.
      await CampaignInviteModel.updateOne(
        { _id: invite._id, status: 'PENDING' },
        { $set: { status: 'SENT' } },
      );
      counts.invites++;
    } else {
      await CampaignInviteModel.updateOne(
        { _id: invite._id },
        {
          $set: {
            remindersSent: step.number,
            lastReminderAt: at,
            sendAttempts: 0,
            lastError: null,
            nextSendAt: nextReminderAt(campaign!, step.number, at),
          },
        },
      );
      counts.reminders++;
    }
  }
  if (counts.invites + counts.reminders + counts.failed > 0) {
    deps.logger.info(counts, 'campaign invites emailed');
  }
  return counts;
}
