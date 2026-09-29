import {
  DELETE_CONFIRMATION_TEXT,
  type DeleteAccountBody,
  type OtpChannel,
  type OtpRequestResponse,
} from '@cbi/shared-types';
import { errorMessage, OtpCodeForm } from '@cbi/web-core';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useCandidateAuth } from '../../app/session';
import { ConsentHistory } from '../consent/ConsentHistory';
import { GrievanceOfficerCard, LegalLinks } from '../legal/LegalPage';
import { downloadJson, useLegalInfo, usePrivacyApi } from './privacy-api';

function ExportCard() {
  const { t } = useTranslation();
  const api = usePrivacyApi();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setPending(true);
    setNotice(null);
    setError(null);
    try {
      const bundle = await api.exportData();
      downloadJson(`careerpilot-data-${bundle.generatedAt.slice(0, 10)}.json`, bundle);
      setNotice(t('privacy.exportDone'));
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="export-title">
      <h2 id="export-title" className="h5">
        <i className="bi bi-download me-2" aria-hidden="true" />
        {t('privacy.exportTitle')}
      </h2>
      <p className="small cb-text-secondary">{t('privacy.exportHint')}</p>
      {notice && (
        <div className="alert alert-success py-2" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className="btn btn-outline-primary"
        disabled={pending}
        onClick={() => void download()}
      >
        {pending ? t('privacy.exporting') : t('privacy.exportButton')}
      </button>
    </section>
  );
}

type DeleteStep =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'code'; channel: OtpChannel; sent: OtpRequestResponse };

function DeleteAccountCard({ graceDays }: { graceDays: number }) {
  const { t } = useTranslation();
  const id = useId();
  const api = usePrivacyApi();
  const { user } = useCandidateAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<DeleteStep>({ kind: 'idle' });
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function finish(body: DeleteAccountBody) {
    const result = await api.deleteAccount(body);
    // The server has already ended every session; the next page ends this tab's (and other
    // tabs') once it is showing, so the signed-in area's guard does not send them to sign in.
    await navigate(`/account-deleted?until=${encodeURIComponent(result.scheduledFor)}`, {
      replace: true,
      state: { endSession: true },
    });
  }

  async function sendCode(channel: OtpChannel) {
    setError(null);
    setPending(true);
    try {
      setStep({ kind: 'code', channel, sent: await api.requestReauth(channel) });
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setPending(false);
    }
  }

  async function submitTyped(event: FormEvent) {
    event.preventDefault();
    if (typed.trim() !== DELETE_CONFIRMATION_TEXT) {
      setError(t('privacy.deleteTypedMismatch', { word: DELETE_CONFIRMATION_TEXT }));
      return;
    }
    setError(null);
    setPending(true);
    try {
      await finish({ method: 'TYPED', confirmText: DELETE_CONFIRMATION_TEXT });
    } catch (err) {
      setError(errorMessage(t, err));
      setPending(false);
    }
  }

  const cancel = () => {
    setStep({ kind: 'idle' });
    setTyped('');
    setError(null);
  };

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="delete-title">
      <h2 id="delete-title" className="h5">
        <i className="bi bi-trash me-2" aria-hidden="true" />
        {t('privacy.deleteTitle')}
      </h2>
      <p className="small cb-text-secondary">{t('privacy.deleteHint', { count: graceDays })}</p>

      {step.kind === 'idle' && (
        <button
          type="button"
          className="btn btn-outline-danger"
          onClick={() => setStep({ kind: 'confirm' })}
        >
          {t('privacy.deleteStart')}
        </button>
      )}

      {step.kind === 'confirm' && (
        <div className="p-3 border cb-border rounded-3 cb-surface-muted">
          <p className="fw-semibold">{t('privacy.deleteWarning', { count: graceDays })}</p>
          <div className="d-flex flex-wrap gap-2">
            {user?.email && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={pending}
                onClick={() => void sendCode('EMAIL')}
              >
                <i className="bi bi-envelope me-1" aria-hidden="true" />
                {t('privacy.deleteSendEmailCode')}
              </button>
            )}
            {user?.mobile && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={pending}
                onClick={() => void sendCode('MOBILE')}
              >
                <i className="bi bi-phone me-1" aria-hidden="true" />
                {t('privacy.deleteSendMobileCode')}
              </button>
            )}
            <button type="button" className="btn btn-outline-secondary" onClick={cancel}>
              {t('privacy.deleteKeep')}
            </button>
          </div>
          <form className="mt-3" onSubmit={(e) => void submitTyped(e)} noValidate>
            <label htmlFor={`${id}-typed`} className="form-label small">
              {t('privacy.deleteTypedLabel', { word: DELETE_CONFIRMATION_TEXT })}
            </label>
            <div className="d-flex flex-wrap gap-2">
              <input
                id={`${id}-typed`}
                className="form-control w-auto"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              <button type="submit" className="btn btn-outline-danger" disabled={pending}>
                {t('privacy.deleteConfirm')}
              </button>
            </div>
          </form>
        </div>
      )}

      {step.kind === 'code' && (
        <div className="p-3 border cb-border rounded-3 cb-surface-muted">
          <OtpCodeForm
            sent={step.sent}
            submitLabel={t('privacy.deleteConfirm')}
            verify={(challengeId, code) => finish({ method: 'OTP', challengeId, code })}
            resend={() => api.requestReauth(step.channel)}
            onChangeDestination={() => setStep({ kind: 'confirm' })}
          />
          <button type="button" className="btn btn-link px-0 mt-2" onClick={cancel}>
            {t('privacy.deleteKeep')}
          </button>
        </div>
      )}

      {error && (
        <div className="alert alert-danger mt-3 mb-0" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

/** `/app/privacy`: data rights under the DPDP Act (export, erasure, consents, grievances). */
export function PrivacyPage() {
  const { t } = useTranslation();
  const legal = useLegalInfo();

  return (
    <div className="container py-5">
      <h1 className="h3 mb-2">{t('privacy.pageTitle')}</h1>
      <p className="cb-text-secondary mb-4">{t('privacy.pageIntro')}</p>
      <div className="row g-4">
        <div className="col-lg-7 d-flex flex-column gap-4">
          <ExportCard />
          <ConsentHistory />
          <DeleteAccountCard graceDays={legal.data?.deletionGraceDays ?? 7} />
        </div>
        <div className="col-lg-5 d-flex flex-column gap-4">
          <GrievanceOfficerCard info={legal.data} />
          <section
            className="p-4 border cb-border rounded-3 bg-white"
            aria-labelledby="legal-links-title"
          >
            <h2 id="legal-links-title" className="h5">
              {t('privacy.legalTitle')}
            </h2>
            <p className="small cb-text-secondary">{t('privacy.legalHint')}</p>
            <LegalLinks className="small" />
          </section>
        </div>
      </div>
    </div>
  );
}
