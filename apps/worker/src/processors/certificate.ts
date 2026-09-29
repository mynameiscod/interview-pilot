import { CertificateModel } from '@cbi/db';
import type { StorageProvider } from '@cbi/provider-adapters';
import { renderCertificatePdf } from '../evaluation/certificate-pdf.js';

export interface CertificateDeps {
  storage: Pick<StorageProvider, 'put'>;
  /** Base URL of the candidate site; the verification link is `<url>/verify/<code>`. */
  candidateUrl: string;
  now?: () => Date;
}

export const certificateVerifyUrl = (candidateUrl: string, code: string) =>
  `${candidateUrl.replace(/\/$/, '')}/verify/${code}`;

/**
 * Renders a readiness certificate's PDF once. A certificate deleted in the
 * meantime (account erasure) is skipped; a retry after a storage failure
 * renders again (the object key is stable, so it is simply overwritten).
 */
export async function processCertificatePdf(
  deps: CertificateDeps,
  certificateId: string,
): Promise<'rendered' | 'skipped'> {
  const cert = await CertificateModel.findById(certificateId).lean();
  if (!cert || cert.pdf.status === 'READY') return 'skipped';
  const pdf = await renderCertificatePdf({
    code: cert.code,
    candidateName: cert.candidateName,
    roleTitle: cert.roleTitle,
    overall: cert.overall,
    band: cert.band,
    completedAt: cert.completedAt,
    issuedAt: cert.issuedAt,
    verifyUrl: certificateVerifyUrl(deps.candidateUrl, cert.code),
  });
  const key = `certificates/${String(cert.userId)}/${String(cert._id)}.pdf`;
  await deps.storage.put(key, pdf, 'application/pdf');
  await CertificateModel.updateOne(
    { _id: cert._id },
    {
      $set: {
        pdf: { status: 'READY', storageKey: key, generatedAt: deps.now?.() ?? new Date() },
      },
    },
  );
  return 'rendered';
}
