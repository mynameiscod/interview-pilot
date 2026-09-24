import type { ConsentType } from '@cbi/shared-types';
import { ConsentTextModel } from '../models/consent.js';

/**
 * Version 1 of each consent text (English). Hindi and Telugu fall back to
 * English until reviewed translations are added in Admin → Consent texts.
 * LEGAL REVIEW REQUIRED before launch (design §18, DPDP Act 2023).
 */
export const SEED_CONSENT_TEXTS: { type: ConsentType; title: string; body: string }[] = [
  {
    type: 'VOICE_PROCESSING',
    title: 'Speaking your answers',
    body: [
      'In a voice or video interview, each answer you record is sent to our speech-recognition provider to turn it into text, and each question is read aloud by a speech-synthesis provider.',
      'The audio of your answers is used only to create the transcript and is not kept by CareerPilot Interview afterwards (unless you also agree to recording).',
      'The transcript becomes part of your interview and is used to prepare your readiness report.',
    ].join('\n\n'),
  },
  {
    type: 'RECORDING',
    title: 'Recording this interview',
    body: [
      'Your camera and microphone are recorded during this video interview and stored securely.',
      'The recording is deleted automatically after the retention period (90 days unless stated otherwise). You can delete it sooner from the interview page.',
      'Only you and authorised CodeBegun staff, for support and quality review, can watch it, and every viewing by staff is logged.',
      'Where recording is optional you can decline, and the interview then runs without recording.',
    ].join('\n\n'),
  },
  {
    type: 'CAMPAIGN_SHARING',
    title: 'Sharing your results with the company',
    body: [
      'You joined this interview through an invitation from a company. Your interview transcript, scores and report are shared with the people at that company who run this campaign, and with authorised CodeBegun staff.',
      'Every candidate in the campaign is assessed on the same role, questions format and rules. The company decides whether you can see your own report.',
      'If you do not agree, do not start the interview. You can still practise on your own without sharing anything.',
    ].join('\n\n'),
  },
  {
    type: 'INTEGRITY',
    title: 'Session observations',
    body: [
      'During this interview your browser notes when you switch tabs or windows, leave full screen, paste text, or when the camera or microphone stops.',
      'These are observations only. They often have ordinary explanations, are shown neutrally in your report, and never change your score.',
    ].join('\n\n'),
  },
];

/** Inserts version 1 (English, active) of each consent type that has no versions yet. */
export async function ensureConsentTexts(): Promise<number> {
  let created = 0;
  for (const seed of SEED_CONSENT_TEXTS) {
    if (await ConsentTextModel.exists({ type: seed.type })) continue;
    try {
      await ConsentTextModel.create({
        ...seed,
        locale: 'en',
        version: 1,
        active: true,
        reason: 'Seeded default (legal review required)',
      });
      created++;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return created;
}
