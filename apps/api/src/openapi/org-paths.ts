import {
  ApiCampaign,
  ApiKeySummary,
  ApiKeyWithSecret,
  BulkStageChangeBody,
  BulkStageChangeResult,
  CampaignInviteSummary,
  CampaignListQuery,
  CampaignStatusBody,
  CampaignSummary,
  CampaignWithInvite,
  CohortAnalytics,
  CohortQuery,
  CreateApiKeyBody,
  CreateCampaignBody,
  CreateInvitesBody,
  CreateInvitesResult,
  CreateOrgBody,
  CreateWebhookBody,
  IdentityCaptureStatus,
  IdentityReview,
  IdentityReviewBody,
  InviteListPage,
  InviteListQuery,
  InviteOrgMemberBody,
  InviteOrgMemberResponse,
  InvitePreview,
  InvitePreviewBody,
  JoinCampaignBody,
  JoinCampaignResult,
  NoteBody,
  OrgCandidateDetail,
  OrgListPage,
  OrgListQuery,
  OrgMemberSummary,
  OrgMeResponse,
  OrgNote,
  OrgResults,
  OrgResultsExportQuery,
  OrgResultsQuery,
  OrgScorecard,
  OrgStatusBody,
  OrgSummary,
  OrgWalletAdjustBody,
  PublicCampaign,
  RotateInviteBody,
  ScorecardBody,
  StageChangeBody,
  UpdateCampaignBody,
  UpdateOrgBody,
  UpdateOrgMemberBody,
  UpdateScorecardCriteriaBody,
  UpdateWebhookBody,
  WebhookDelivery,
  WebhookSummary,
  WebhookWithSecret,
} from '@cbi/shared-types';
import { z } from 'zod';
import type { Method, RouteSpec } from './document.js';

type Route = (method: Method, path: string, spec: RouteSpec) => void;

/** Organisations (admin), the org portal, the org API (API keys), invites and identity capture. */
export function registerOrgPaths(route: Route) {
  const admin = (method: Method, path: string, spec: Omit<RouteSpec, 'tag' | 'auth'>) =>
    route(method, `/admin${path}`, {
      tag: 'Admin organisations',
      auth: 'bearer',
      errors: [400, 401, 403, 404, 409],
      ...spec,
    });
  admin('get', '/orgs', {
    summary: 'Organisations, newest first (orgs.read)',
    query: OrgListQuery,
    response: OrgListPage,
  });
  admin('post', '/orgs', {
    summary:
      'Create an employer or college with seats, interview quota and sponsored wallet, and invite its owner (orgs.manage; audited)',
    body: CreateOrgBody,
    response: z.object({ org: OrgSummary, inviteEmailSent: z.boolean() }),
    status: 201,
  });
  admin('get', '/orgs/{id}', { summary: 'One organisation (orgs.read)', response: OrgSummary });
  admin('put', '/orgs/{id}', {
    summary: 'Name, seats, quota and whether members need an authenticator (orgs.manage; audited)',
    body: UpdateOrgBody,
    response: OrgSummary,
  });
  admin('post', '/orgs/{id}/status', {
    summary: 'Suspend or reactivate; suspension blocks every member and API key at once',
    body: OrgStatusBody,
    response: OrgSummary,
  });
  admin('post', '/orgs/{id}/wallet', {
    summary: 'Add or take back unallocated sponsored interviews (orgs.manage; audited)',
    body: OrgWalletAdjustBody,
    response: OrgSummary,
  });
  admin('get', '/orgs/{id}/members', {
    summary: 'Members (orgs.read)',
    response: z.array(OrgMemberSummary),
  });
  admin('post', '/orgs/{id}/members', {
    summary: 'Invite a member by email (orgs.manage)',
    body: InviteOrgMemberBody,
    response: InviteOrgMemberResponse,
    status: 201,
  });
  admin('put', '/orgs/{id}/members/{memberId}', {
    summary: 'Change a member role; the last owner stays an owner (orgs.manage)',
    body: UpdateOrgMemberBody,
    response: OrgMemberSummary,
  });
  admin('delete', '/orgs/{id}/members/{memberId}', {
    summary: 'Remove a member and end their org sessions (orgs.manage)',
    response: null,
  });

  // ---- Org portal (org sessions) ----------------------------------------------------------------
  const org = (method: Method, path: string, spec: Omit<RouteSpec, 'tag' | 'auth'>) =>
    route(method, `/org${path}`, {
      tag: 'Org portal',
      auth: 'bearer',
      errors: [400, 401, 403, 404],
      ...spec,
    });
  org('get', '/me', {
    summary: 'The member, their organisation, role and org permissions',
    response: OrgMeResponse,
  });
  org('get', '/organisation', { summary: 'The organisation (org.read)', response: OrgSummary });
  org('put', '/organisation/scorecard', {
    summary: 'Scorecard criteria reviewers rate 1–5 (owners)',
    body: UpdateScorecardCriteriaBody,
    response: OrgSummary,
  });
  org('get', '/members', { summary: 'Members (org.read)', response: z.array(OrgMemberSummary) });
  org('post', '/members', {
    summary: 'Invite a member within the seats (owners; audited)',
    body: InviteOrgMemberBody,
    response: InviteOrgMemberResponse,
    status: 201,
    errors: [400, 401, 403, 409],
  });
  org('put', '/members/{memberId}', {
    summary: 'Change a role (owners)',
    body: UpdateOrgMemberBody,
    response: OrgMemberSummary,
  });
  org('delete', '/members/{memberId}', { summary: 'Remove a member (owners)', response: null });
  org('get', '/library', {
    summary: 'Roles (with an active blueprint) and interview types to build campaigns from',
    response: z.object({
      roles: z.array(z.object({ id: z.string(), title: z.string() })),
      templates: z.array(
        z.object({ key: z.string(), name: z.string(), modes: z.array(z.string()) }),
      ),
    }),
  });
  org('get', '/campaigns', {
    summary: "The organisation's campaigns, newest first",
    query: CampaignListQuery,
    response: z.object({
      items: z.array(CampaignSummary),
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),
    }),
  });
  org('post', '/campaigns', {
    summary:
      'Create a draft campaign; a sponsored budget is taken from the wallet (402 when it does not cover it)',
    body: CreateCampaignBody,
    response: CampaignWithInvite,
    status: 201,
    errors: [400, 401, 402, 403, 404],
  });
  org('get', '/campaigns/{id}', { summary: 'One campaign', response: CampaignSummary });
  org('put', '/campaigns/{id}', {
    summary: 'Change a campaign; budget changes move interviews to or from the wallet',
    body: UpdateCampaignBody,
    response: CampaignSummary,
  });
  org('post', '/campaigns/{id}/status', {
    summary: 'Activate, pause or close; closing returns unused sponsored interviews to the wallet',
    body: CampaignStatusBody,
    response: CampaignSummary,
  });
  org('post', '/campaigns/{id}/rotate-invite', {
    summary: 'Replace the shared link (shown once)',
    body: RotateInviteBody,
    response: CampaignWithInvite,
  });
  org('get', '/campaigns/{id}/invites', {
    summary: 'Invites with status tracking and the status funnel',
    query: InviteListQuery,
    response: InviteListPage,
  });
  org('post', '/campaigns/{id}/invites/preview', {
    summary: 'Validate a CSV of invites (nothing saved): valid rows, errors by line, duplicates',
    body: InvitePreviewBody,
    response: InvitePreview,
  });
  org('post', '/campaigns/{id}/invites', {
    summary:
      'Invite up to 1000 emails (single or bulk); each gets a personal link; emails are sent by the worker',
    body: CreateInvitesBody,
    response: CreateInvitesResult,
    status: 201,
  });
  org('post', '/campaigns/{id}/invites/{inviteId}/revoke', {
    summary: 'Withdraw an invite (its link stops working; no more reminders)',
    response: CampaignInviteSummary,
  });
  org('post', '/campaigns/{id}/invites/{inviteId}/retry', {
    summary: 'Send an invite that failed again',
    response: CampaignInviteSummary,
  });
  org('get', '/campaigns/{id}/results', {
    summary:
      'Candidates who agreed to share with the organisation: scores, stage, scorecards, identity check; filters by status, stage, score, dimension and scorecard',
    query: OrgResultsQuery,
    response: OrgResults,
  });
  org('get', '/campaigns/{id}/results.csv', {
    summary: 'The same rows as CSV, streamed (org.export; audited)',
    query: OrgResultsExportQuery,
    response: null,
    status: 200,
  });
  org('post', '/campaigns/{id}/candidates/stage', {
    summary: 'Move several candidates to a stage (webhook candidate.stage_changed per change)',
    body: BulkStageChangeBody,
    response: BulkStageChangeResult,
  });
  org('get', '/campaigns/{id}/candidates/{applicationId}', {
    summary:
      'One candidate: results, the report as the employer view allows, stage history, notes, scorecards, identity (audited)',
    response: OrgCandidateDetail,
  });
  org('post', '/campaigns/{id}/candidates/{applicationId}/stage', {
    summary: 'Move one candidate to a stage',
    body: StageChangeBody,
    response: BulkStageChangeResult,
  });
  org('post', '/campaigns/{id}/candidates/{applicationId}/notes', {
    summary: 'Add a note; @mentions are kept as plain text',
    body: NoteBody,
    response: OrgNote,
    status: 201,
  });
  org('put', '/campaigns/{id}/candidates/{applicationId}/scorecard', {
    summary: "Save the reviewer's scorecard (every criterion 1–5 and a recommendation)",
    body: ScorecardBody,
    response: OrgScorecard,
  });
  org('get', '/campaigns/{id}/candidates/{applicationId}/identity/{kind}', {
    summary: 'A captured image (selfie, id-document or interview-frame), streamed (audited)',
    response: null,
    status: 200,
  });
  org('post', '/campaigns/{id}/candidates/{applicationId}/identity/review', {
    summary: 'Mark the capture verified or a mismatch (manual check; audited)',
    body: IdentityReviewBody,
    response: IdentityReview,
  });
  org('get', '/analytics/cohort', {
    summary:
      'College cohort readiness: bands, dimension averages, participation and improvement per student',
    query: CohortQuery,
    response: CohortAnalytics,
  });
  org('get', '/analytics/cohort.csv', {
    summary: 'The cohort report as CSV (org.export; audited)',
    query: CohortQuery,
    response: null,
    status: 200,
  });
  org('get', '/webhooks', { summary: 'Webhooks (owners)', response: z.array(WebhookSummary) });
  org('post', '/webhooks', {
    summary: 'Add a webhook; the signing secret is shown once',
    body: CreateWebhookBody,
    response: WebhookWithSecret,
    status: 201,
  });
  org('put', '/webhooks/{webhookId}', {
    summary: 'Change events, pause or resume',
    body: UpdateWebhookBody,
    response: WebhookSummary,
  });
  org('delete', '/webhooks/{webhookId}', { summary: 'Delete a webhook', response: null });
  org('post', '/webhooks/{webhookId}/ping', {
    summary: 'Queue a signed ping delivery',
    response: WebhookDelivery,
    status: 202,
  });
  org('get', '/webhooks/{webhookId}/deliveries', {
    summary: 'Delivery log (last 100, kept 30 days)',
    response: z.array(WebhookDelivery),
  });
  org('get', '/api-keys', { summary: 'API keys (owners)', response: z.array(ApiKeySummary) });
  org('post', '/api-keys', {
    summary: 'Create a read-only results key; the key is shown once',
    body: CreateApiKeyBody,
    response: ApiKeyWithSecret,
    status: 201,
  });
  org('post', '/api-keys/{keyId}/revoke', { summary: 'Revoke a key', response: ApiKeySummary });

  // ---- Org API (API keys, for ATS integrations) --------------------------------------------------
  const api = (path: string, spec: Omit<RouteSpec, 'tag' | 'auth'>) =>
    route('get', `/org-api${path}`, {
      tag: 'Org API (API key)',
      auth: 'bearer',
      errors: [401, 403, 404, 429],
      ...spec,
    });
  api('/campaigns', {
    summary: "The organisation's campaigns (`Authorization: Bearer cbk_…`, scope results:read)",
    query: CampaignListQuery,
    response: z.object({
      items: z.array(ApiCampaign),
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),
    }),
  });
  api('/campaigns/{id}/results', {
    summary: 'Results of consenting candidates, one page (audited per request)',
    query: OrgResultsQuery,
    response: OrgResults,
  });

  // ---- Candidates: personal invite links and identity capture ------------------------------------
  route('get', '/campaign-invites/{token}', {
    tag: 'Campaigns',
    summary: 'A personal invite link landing page (public); the first visit marks it opened',
    response: PublicCampaign,
    errors: [404, 429],
  });
  route('post', '/campaign-invites/{token}/join', {
    tag: 'Campaigns',
    summary:
      'Join through a personal invite. 403 INVITE_REQUIRED when the campaign is invite-only and the email differs',
    auth: 'bearer',
    body: JoinCampaignBody,
    response: JoinCampaignResult,
    status: 201,
    errors: [400, 401, 403, 404, 409],
  });
  route('put', '/interviews/{id}/identity/{kind}', {
    tag: 'Interviews',
    summary:
      'Upload a selfie, ID photo (before starting) or interview frame (video, once) as a raw JPEG or PNG body, up to 2 MB; needs the IDENTITY_CAPTURE consent',
    auth: 'bearer',
    response: IdentityCaptureStatus,
    errors: [401, 404, 409, 413, 415],
  });
}
