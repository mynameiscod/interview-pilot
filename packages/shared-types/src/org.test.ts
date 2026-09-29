import { describe, expect, it } from 'vitest';
import { CreateCampaignBody, DEFAULT_INVITE_REMINDERS, InviteReminders } from './campaign.js';
import { consentRequirements } from './consent.js';
import { parseCsvRows, previewInviteCsv } from './invite-csv.js';
import {
  CreateInvitesBody,
  MAX_INVITES_PER_REQUEST,
  ScorecardBody,
  StageChangeBody,
  UpdateScorecardCriteriaBody,
} from './org.js';
import {
  hasOrgPermission,
  ORG_ROLE_PERMISSIONS,
  OrgPermission,
  OrgRole,
  orgPermissionsFor,
} from './permissions.js';

describe('org permission matrix', () => {
  it('defines every role and gives owners everything', () => {
    expect(Object.keys(ORG_ROLE_PERMISSIONS).sort()).toEqual([...OrgRole.options].sort());
    expect(orgPermissionsFor('ORG_OWNER').sort()).toEqual([...OrgPermission.options].sort());
  });

  it('reserves members and integrations to owners', () => {
    for (const role of ['ORG_RECRUITER', 'ORG_VIEWER'] as const) {
      expect(hasOrgPermission(role, 'org.members.manage')).toBe(false);
      expect(hasOrgPermission(role, 'org.integrations.manage')).toBe(false);
    }
  });

  it('keeps viewers read-only apart from notes and scorecards', () => {
    expect(orgPermissionsFor('ORG_VIEWER').sort()).toEqual(['org.read', 'org.review']);
    expect(hasOrgPermission('ORG_VIEWER', 'org.export')).toBe(false);
    expect(hasOrgPermission('ORG_RECRUITER', 'org.pipeline.manage')).toBe(true);
  });
});

describe('org campaign options', () => {
  it('defaults keep campaigns created before the portal unchanged', () => {
    const parsed = CreateCampaignBody.parse({
      name: 'Backend hiring',
      companyId: null,
      companyName: 'Acme',
      roleId: 'r1',
      templateKey: 'standard-practice',
      jobDescription: null,
      modes: ['TEXT'],
      languages: ['en'],
      window: { startAt: '2026-09-01T00:00:00.000Z', endAt: null },
      maxCandidates: null,
      proctoring: { recording: 'OFF', tabSwitchTracking: false },
      candidateSeesReport: true,
      sponsoredCredits: null,
    });
    expect(parsed).toMatchObject({
      requireInvite: false,
      employerView: 'FULL_REPORT',
      idCapture: false,
      reminders: DEFAULT_INVITE_REMINDERS,
    });
  });

  it('allows at most two reminders', () => {
    expect(InviteReminders.safeParse({ enabled: true, max: 3, intervalHours: 48 }).success).toBe(
      false,
    );
    expect(InviteReminders.safeParse({ enabled: true, max: 2, intervalHours: 6 }).success).toBe(
      false,
    );
  });

  it('asks for identity-capture consent only in campaigns that capture identity', () => {
    const policy = { recording: 'OFF' as const, tabSwitchTracking: false };
    expect(consentRequirements('TEXT', policy, { campaign: true, idCapture: true })).toEqual([
      { type: 'CAMPAIGN_SHARING', required: true },
      { type: 'IDENTITY_CAPTURE', required: true },
    ]);
    expect(consentRequirements('TEXT', policy, { idCapture: true })).toEqual([]);
  });
});

describe('pipeline and scorecards', () => {
  it('parses stage changes and rejects unknown stages', () => {
    expect(StageChangeBody.parse({ stage: 'SHORTLISTED' })).toEqual({
      stage: 'SHORTLISTED',
      note: null,
    });
    expect(StageChangeBody.safeParse({ stage: 'INTERVIEWING' }).success).toBe(false);
  });

  it('keeps ratings between 1 and 5', () => {
    expect(
      ScorecardBody.safeParse({ ratings: { communication: 6 }, recommendation: 'YES' }).success,
    ).toBe(false);
    expect(
      ScorecardBody.parse({ ratings: { communication: 4 }, recommendation: 'YES' }).comment,
    ).toBeNull();
  });

  it('requires unique criterion keys', () => {
    const criteria = [
      { key: 'fit', label: 'Fit' },
      { key: 'fit', label: 'Fit again' },
    ];
    expect(UpdateScorecardCriteriaBody.safeParse({ criteria }).success).toBe(false);
  });
});

describe('invite CSV', () => {
  it('splits quoted cells, CRLF lines and a BOM', () => {
    expect(
      parseCsvRows('﻿email,name\r\na@x.com,"Rao, Asha"\r\n"b@x.com","He said ""hi"""'),
    ).toEqual([
      ['email', 'name'],
      ['a@x.com', 'Rao, Asha'],
      ['b@x.com', 'He said "hi"'],
    ]);
  });

  it('validates rows, reports errors by line and drops duplicates', () => {
    const csv = [
      'Email,Name,Language,Batch,Branch,Year',
      'asha@example.com,Asha,hi,2026,CSE,2026',
      'not-an-email,Ravi,,,,',
      'ASHA@example.com,Asha again,,,,',
      'kiran@example.com,Kiran,fr,,,',
      'lata@example.com,Lata,,,,20x6',
      '',
      'old@example.com,Old,,,,',
      'meena@example.com,,te,B2,ECE,',
    ].join('\n');
    const preview = previewInviteCsv(csv, new Set(['old@example.com']));
    expect(preview.valid).toEqual([
      {
        email: 'asha@example.com',
        name: 'Asha',
        language: 'hi',
        tags: { batch: '2026', branch: 'CSE', year: 2026 },
      },
      {
        email: 'meena@example.com',
        name: null,
        language: 'te',
        tags: { batch: 'B2', branch: 'ECE', year: null },
      },
    ]);
    expect(preview.errors.map((e) => e.line)).toEqual([3, 5, 6]);
    expect(preview.errors[0]!.message).toContain('not-an-email');
    expect(preview.errors[1]!.message).toContain('en, hi or te');
    expect(preview.duplicates.sort()).toEqual(['asha@example.com', 'old@example.com']);
  });

  it('needs an email column', () => {
    expect(previewInviteCsv('name\nAsha').errors).toEqual([
      { line: 1, message: 'The first row must be a header with an "email" column.' },
    ]);
  });

  it('caps a request at the bulk limit', () => {
    const rows = Array.from({ length: MAX_INVITES_PER_REQUEST + 2 }, (_, i) => `u${i}@x.com`);
    const preview = previewInviteCsv(['email', ...rows].join('\n'));
    expect(preview.valid).toHaveLength(MAX_INVITES_PER_REQUEST);
    expect(preview.errors).toHaveLength(1);
    expect(CreateInvitesBody.safeParse({ invites: preview.valid }).success).toBe(true);
  });
});
