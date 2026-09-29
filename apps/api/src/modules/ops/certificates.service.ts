import { randomBytes } from 'node:crypto';
import {
  CertificateModel,
  InterviewReportModel,
  UserProfileModel,
  type CertificateRecord,
  type InterviewReportRecord,
} from '@cbi/db';
import type { StorageProvider } from '@cbi/provider-adapters';
import { bandAtLeast } from '@cbi/scoring-core';
import {
  CERTIFICATE_CODE_PATTERN,
  type CertificateStatus,
  type CertificateVerification,
  type PracticeSetting,
} from '@cbi/shared-types';
import type { Types } from 'mongoose';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { JobQueues } from '../../lib/jobs.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { FlagService } from './ops.service.js';

/** Certificates ride on Candidate Proof: the same flag, off by default. */
const FLAG = 'reports.publicProof' as const;

/** No 0/O, 1/I: codes are read off paper. 32 symbols, so a random byte maps without bias. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** `CPI-XXXX-XXXX-XXXX`: 60 random bits, printed on the certificate. */
export function certificateCode(bytes: Buffer = randomBytes(12)): string {
  const chars = [...bytes.subarray(0, 12)].map((b) => CODE_ALPHABET[b % 32]);
  return `CPI-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

export const verifyPath = (code: string) => `/verify/${code}`;

/** An interview report (not a drill) the candidate may see, latest revision. */
async function interviewReport(userId: string, sessionId: Types.ObjectId) {
  return InterviewReportModel.findOne({
    userId,
    sessionId,
    kind: { $ne: 'DRILL' },
    'visibility.candidate': true,
  })
    .sort({ revision: -1 })
    .lean<InterviewReportRecord>();
}

/**
 * Readiness certificates: a candidate whose report reaches the
 * `practice.certificateMinBand` band can issue one certificate per interview.
 * The worker renders its PDF; anyone with the code can check it on the
 * public verification page. Behind the Candidate Proof flag: while it is off
 * every endpoint answers 404.
 */
export function createCertificateService(deps: {
  flags: FlagService;
  audit: AuditService;
  storage: Pick<StorageProvider, 'get'>;
  jobs: Pick<JobQueues, 'renderCertificatePdf'>;
  practice: () => Promise<PracticeSetting>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const notFound = () => AppError.notFound('Not found');

  function statusOf(
    eligible: boolean,
    minBand: CertificateStatus['minBand'],
    cert: CertificateRecord | null,
  ): CertificateStatus {
    return {
      eligible,
      minBand,
      certificate: cert
        ? {
            code: cert.code,
            issuedAt: iso(cert.issuedAt),
            pdfReady: cert.pdf.status === 'READY',
            verifyPath: verifyPath(cert.code),
          }
        : null,
    };
  }

  async function load(userId: string, sessionId: string) {
    if (!(await deps.flags.isEnabled(FLAG, userId))) throw notFound();
    const sid = objectId(sessionId, 'Report');
    const report = await interviewReport(userId, sid);
    if (!report) throw AppError.notFound('Report not found');
    const { certificateMinBand } = await deps.practice();
    const cert = await CertificateModel.findOne({ userId, sessionId: sid }).lean();
    return {
      sid,
      report,
      cert,
      minBand: certificateMinBand,
      eligible: bandAtLeast(report.content.overall.band, certificateMinBand),
    };
  }

  return {
    async status(userId: string, sessionId: string): Promise<CertificateStatus> {
      const { eligible, minBand, cert } = await load(userId, sessionId);
      return statusOf(eligible, minBand, cert);
    },

    /** Issues the interview's certificate once (again: the existing one) and queues its PDF. */
    async issue(userId: string, sessionId: string, ctx: ClientContext): Promise<CertificateStatus> {
      const { sid, report, cert, eligible, minBand } = await load(userId, sessionId);
      if (cert) return statusOf(eligible, minBand, cert);
      if (!eligible) {
        throw new AppError(
          409,
          'INVALID_STATE',
          'This report does not reach the readiness band a certificate needs.',
        );
      }
      const profile = await UserProfileModel.findOne({ userId }, { displayName: 1 }).lean();
      const c = report.content;
      let created: CertificateRecord;
      try {
        created = (
          await CertificateModel.create({
            userId,
            sessionId: sid,
            reportRevision: report.revision,
            code: certificateCode(),
            candidateName: profile?.displayName ?? null,
            roleTitle: c.header.title,
            overall: c.overall.score,
            band: c.overall.band,
            completedAt: c.header.endedAt ? new Date(c.header.endedAt) : null,
            issuedAt: now(),
          })
        ).toObject();
      } catch (err) {
        // A concurrent request issued it first (unique per interview).
        if ((err as { code?: number }).code !== 11000) throw err;
        const existing = await CertificateModel.findOne({ userId, sessionId: sid }).lean();
        if (!existing) throw err;
        return statusOf(eligible, minBand, existing);
      }
      await deps.jobs.renderCertificatePdf(String(created._id));
      await deps.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'certificate.issued',
          resourceType: 'certificate',
          resourceId: String(created._id),
          details: { sessionId, band: created.band, reportRevision: created.reportRevision },
        },
        ctx,
      );
      return statusOf(eligible, minBand, created);
    },

    async pdf(userId: string, sessionId: string) {
      const { cert } = await load(userId, sessionId);
      if (!cert) throw AppError.notFound('Certificate not found');
      if (cert.pdf.status !== 'READY' || !cert.pdf.storageKey) {
        throw new AppError(409, 'INVALID_STATE', 'The certificate is still being prepared.');
      }
      return {
        body: await deps.storage.get(cert.pdf.storageKey),
        fileName: `readiness-certificate-${cert.code}.pdf`,
      };
    },

    /** The public verification page. Unknown codes and hidden reports read alike. */
    async verify(code: string): Promise<CertificateVerification> {
      if (!(await deps.flags.isSwitchedOn(FLAG))) throw notFound();
      const normalised = code.trim().toUpperCase();
      if (!CERTIFICATE_CODE_PATTERN.test(normalised)) throw notFound();
      const cert = await CertificateModel.findOne({ code: normalised }).lean();
      if (!cert) throw notFound();
      const latest = await InterviewReportModel.findOne(
        { userId: cert.userId, sessionId: cert.sessionId, 'visibility.candidate': true },
        { revision: 1 },
      )
        .sort({ revision: -1 })
        .lean();
      // A report hidden later (for example by a campaign) stops being verifiable.
      if (!latest) throw notFound();
      return {
        code: cert.code,
        candidateName: cert.candidateName,
        roleTitle: cert.roleTitle,
        overall: cert.overall,
        band: cert.band,
        completedAt: cert.completedAt ? iso(cert.completedAt) : null,
        issuedAt: iso(cert.issuedAt),
        superseded: latest.revision > cert.reportRevision,
      };
    },
  };
}

export type CertificateService = ReturnType<typeof createCertificateService>;
