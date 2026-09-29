import type { InterviewSummary } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useCandidateAuth } from '../../app/session';
import { queryKeys } from '../interviews/interviews-api';
import { inputErrorMessage } from '../interviews/messages';
import { uploadIdentityPhoto } from './campaigns-api';
import { captureVideoFrame } from './identity-frame';

type Step = 'selfie' | 'id-document';

/**
 * Identity capture before a campaign interview that asks for it: a selfie
 * and a photo of an ID, taken with the camera after the candidate agreed to
 * the IDENTITY_CAPTURE notice. The company's reviewers compare them by eye;
 * nothing is matched automatically.
 */
export function IdentityCaptureCard({ interview }: { interview: InterviewSummary }) {
  const { t } = useTranslation();
  const { manager } = useCandidateAuth();
  const queryClient = useQueryClient();
  const identity = interview.campaign?.identity;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The camera is on only while a photo is being taken.
  useEffect(() => () => stream?.getTracks().forEach((track) => track.stop()), [stream]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void Promise.resolve(video.play()).catch(() => undefined);
  }, [stream]);

  if (!identity?.required) return null;

  async function open(next: Step) {
    setError(null);
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      setError(t('identity.noCamera'));
      return;
    }
    try {
      stream?.getTracks().forEach((track) => track.stop());
      setStream(
        await navigator.mediaDevices.getUserMedia({
          video: { facingMode: next === 'selfie' ? 'user' : 'environment' },
          audio: false,
        }),
      );
      setStep(next);
    } catch {
      setError(t('identity.cameraBlocked'));
    }
  }

  function close() {
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
    setStep(null);
  }

  async function capture() {
    if (!step || !videoRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await captureVideoFrame(videoRef.current);
      if (!blob) {
        setError(t('identity.noPicture'));
        return;
      }
      await uploadIdentityPhoto(manager, interview.id, step, blob);
      close();
      await queryClient.invalidateQueries({ queryKey: queryKeys.interview(interview.id) });
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  const done: Record<Step, boolean> = {
    selfie: identity.selfie,
    'id-document': identity.idDocument,
  };

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="start-identity">
      <h2 id="start-identity" className="h5">
        <i className="bi bi-person-vcard me-2 text-secondary" aria-hidden="true" />
        {t('identity.title')}
      </h2>
      <p className="mb-2">
        {t('identity.intro', { company: interview.campaign?.companyName ?? '' })}
      </p>
      {interview.consentsPending ? (
        <>
          <p className="mb-3">{t('identity.consentFirst')}</p>
          <Link to={`/app/interviews/${interview.id}/consent`} className="btn btn-primary">
            {t('start.consent.action')}
          </Link>
        </>
      ) : (
        <>
          <ul className="list-unstyled mb-3">
            {(['selfie', 'id-document'] as const).map((kind) => (
              <li key={kind} className="d-flex flex-wrap align-items-center gap-2 mb-2">
                <i
                  className={`bi ${done[kind] ? 'bi-check-circle-fill text-success' : 'bi-circle text-secondary'}`}
                  aria-hidden="true"
                />
                <span>
                  {t(`identity.steps.${kind}`)}
                  <span className="visually-hidden">
                    {' '}
                    {done[kind] ? t('identity.done') : t('identity.notDone')}
                  </span>
                </span>
                <button
                  type="button"
                  className={`btn btn-sm ${done[kind] ? 'btn-outline-secondary' : 'btn-outline-primary'}`}
                  disabled={busy}
                  onClick={() => void open(kind)}
                >
                  {done[kind] ? t('identity.retake') : t('identity.take')}
                </button>
              </li>
            ))}
          </ul>
          <p className="small cb-text-secondary">{t('identity.idHint')}</p>
          {step && (
            <div className="mb-3">
              <p className="small fw-semibold mb-1">{t(`identity.framing.${step}`)}</p>
              <video
                ref={videoRef}
                className="d-block w-100 rounded-3 bg-dark mb-2"
                style={{ maxWidth: '28rem', aspectRatio: '4 / 3' }}
                muted
                playsInline
                autoPlay
                aria-label={t('identity.preview')}
              />
              <div className="d-flex gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void capture()}
                >
                  <i className="bi bi-camera me-1" aria-hidden="true" />
                  {busy ? t('identity.saving') : t('identity.capture')}
                </button>
                <button type="button" className="btn btn-link" onClick={close}>
                  {t('identity.cancel')}
                </button>
              </div>
            </div>
          )}
          {error && (
            <div className="alert alert-danger mb-0" role="alert">
              {error}
            </div>
          )}
          {identity.complete && (
            <p className="mb-0" role="status">
              <i className="bi bi-check-circle-fill text-success me-2" aria-hidden="true" />
              {t('identity.complete')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
