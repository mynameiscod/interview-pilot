import {
  isSpokenMode,
  type DeviceCheckStatus,
  type InterviewSummary,
  type VoiceHealth,
  type VoiceReadiness,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { ConsentStep } from '../consent/ConsentStep';
import { queryKeys, useInterview, useInterviewsApi } from '../interviews/interviews-api';
import { inputErrorMessage, interviewPath, isEnded, isLive } from '../interviews/messages';
import {
  browserLabel,
  createLevelMeter,
  detectVoiceSupport,
  micProblem,
  openCamera,
  openMicrophone,
  pickVideoMimeType,
  playTestTone,
  stopStream,
  type LevelMeter,
  type MicProblem,
} from './media';
import { useVoiceApi } from './voice-api';
import './voice.scss';

/** Input level (0–1) that counts as hearing the candidate. */
export const MIC_PASS_LEVEL = 0.15;
/** Below this the microphone is effectively silent. */
const MIC_QUIET_LEVEL = 0.03;
/** How long to listen for speech before giving up. */
export const MIC_LISTEN_MS = 10_000;
const MIC_TICK_MS = 100;
/** How long to wait for the first camera picture. */
export const CAMERA_WAIT_MS = 5_000;
/** Round trips to the API used to judge the connection. */
const RTT_SAMPLES = 3;
const RTT_GOOD_MS = 800;
const RTT_SLOW_MS = 2_000;

type CheckStatus = 'PENDING' | 'RUNNING' | DeviceCheckStatus;

interface Check<P extends string = string> {
  status: CheckStatus;
  /** Why it warned or failed (selects the guidance shown). */
  problem?: P;
}

type MicCheckProblem = MicProblem | 'quiet' | 'silent' | 'noMeter';
type CameraProblem = MicProblem | 'noPicture';
type NetworkProblem = 'slow' | 'verySlow' | 'failed';
type SpeechProblem = 'stt' | 'tts' | 'both' | 'failed';
type Stage = 'checks' | 'saving' | 'failed' | 'consent' | 'done';

const decided = (c: Check) => c.status !== 'PENDING' && c.status !== 'RUNNING';

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

function speechCheck(health: VoiceHealth): Check<SpeechProblem> {
  const sttDown = health.stt === 'UNAVAILABLE';
  const ttsDown = health.tts === 'UNAVAILABLE';
  if (sttDown && ttsDown) return { status: 'FAIL', problem: 'both' };
  if (sttDown) return { status: 'WARN', problem: 'stt' };
  if (ttsDown) return { status: 'WARN', problem: 'tts' };
  // DEGRADED still works (fallback models).
  return { status: 'PASS' };
}

const STATUS_ICON: Record<CheckStatus, string> = {
  PENDING: 'bi-circle text-secondary',
  RUNNING: 'bi-hourglass-split text-primary',
  PASS: 'bi-check-circle-fill text-success',
  WARN: 'bi-exclamation-triangle-fill text-warning',
  FAIL: 'bi-x-circle-fill text-danger',
};

/** Status in words and an icon (never colour alone). */
function StatusBadge({ status }: { status: CheckStatus }) {
  const { t } = useTranslation();
  return (
    <span className="small fw-semibold d-inline-flex align-items-center gap-1 text-nowrap">
      <i className={`bi ${STATUS_ICON[status]}`} aria-hidden="true" />
      {t(`voice.check.status.${status}`)}
    </span>
  );
}

function CheckItem({
  icon,
  title,
  check,
  guidance,
  children,
}: {
  icon: string;
  title: string;
  check: Check;
  guidance: string | null;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <li className="p-3 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
        <h3 id={`${id}-title`} className="h6 mb-0">
          <i className={`bi ${icon} me-2 text-secondary`} aria-hidden="true" />
          {title}
        </h3>
        <div aria-live="polite" aria-atomic="true">
          <span className="visually-hidden">{title}: </span>
          <StatusBadge status={check.status} />
        </div>
      </div>
      {guidance && <p className="small mb-0 mt-2">{guidance}</p>}
      {children && <div className="mt-2">{children}</div>}
    </li>
  );
}

/** Offered at every step: continue with a typed interview instead. */
function SwitchToText({ interview }: { interview: InterviewSummary }) {
  const { t } = useTranslation();
  const api = useInterviewsApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function switchToText() {
    setSwitching(true);
    setError(null);
    try {
      const updated = await api.updateSetup(interview.id, {
        mode: 'TEXT',
        language: interview.language,
      });
      queryClient.setQueryData(queryKeys.interview(interview.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.interviews, exact: true });
      await navigate(`/app/interviews/${interview.id}/start`);
    } catch (err) {
      setError(inputErrorMessage(t, err));
      setSwitching(false);
    }
  }

  return (
    <div className="mt-4 pt-3 border-top cb-border">
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className="btn btn-link px-0"
        disabled={switching}
        onClick={() => void switchToText()}
      >
        <i className="bi bi-keyboard me-2" aria-hidden="true" />
        {t('voice.check.switchToText')}
      </button>
    </div>
  );
}

function DeviceCheck({ interview }: { interview: InterviewSummary }) {
  const { t } = useTranslation();
  const voice = useVoiceApi();
  const queryClient = useQueryClient();
  const doneRef = useRef<HTMLHeadingElement>(null);

  const isVideo = interview.mode === 'VIDEO';
  const [support] = useState(detectVoiceSupport);
  const [videoMimeType] = useState(() =>
    isVideo && support.mediaRecorder ? pickVideoMimeType() : null,
  );
  const canRecord = support.getUserMedia && support.mediaRecorder;
  const recorder: Check<'noRecorder' | 'noFormat' | 'noVideoFormat'> = !canRecord
    ? { status: 'FAIL', problem: 'noRecorder' }
    : support.mimeType === null
      ? { status: 'FAIL', problem: 'noFormat' }
      : isVideo && videoMimeType === null
        ? { status: 'FAIL', problem: 'noVideoFormat' }
        : { status: 'PASS' };

  const [mic, setMic] = useState<Check<MicCheckProblem>>(() =>
    support.getUserMedia ? { status: 'PENDING' } : { status: 'FAIL', problem: 'unsupported' },
  );
  const [level, setLevel] = useState(0);
  const [camera, setCamera] = useState<Check<CameraProblem>>(() =>
    support.getUserMedia ? { status: 'PENDING' } : { status: 'FAIL', problem: 'unsupported' },
  );
  const [previewing, setPreviewing] = useState(false);
  const [speaker, setSpeaker] = useState<Check<'noAnswer' | 'noAudio'> & { played?: boolean }>(
    () => (support.audioContext ? { status: 'PENDING' } : { status: 'WARN', problem: 'noAudio' }),
  );
  const [network, setNetwork] = useState<Check<NetworkProblem> & { rttMs?: number }>({
    status: 'RUNNING',
  });
  const [speech, setSpeech] = useState<Check<SpeechProblem>>({ status: 'RUNNING' });
  const [stage, setStage] = useState<Stage>('checks');
  const [saveError, setSaveError] = useState<string | null>(null);

  const micRef = useRef<{ stream: MediaStream; meter: LevelMeter; timer: number } | null>(null);
  const toneRef = useRef<{ stop: () => void } | null>(null);
  const cameraRef = useRef<{ stream: MediaStream; timer: number | undefined } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mountedRef = useRef(true);

  const stopMic = useCallback(() => {
    const active = micRef.current;
    if (!active) return;
    micRef.current = null;
    window.clearInterval(active.timer);
    active.meter.close();
    stopStream(active.stream);
  }, []);

  const stopCamera = useCallback(() => {
    const active = cameraRef.current;
    if (!active) return;
    cameraRef.current = null;
    window.clearInterval(active.timer);
    stopStream(active.stream);
    const video = videoRef.current;
    if (video) video.srcObject = null;
  }, []);

  // Release the microphone, camera and any test tone when leaving the page.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopMic();
      stopCamera();
      toneRef.current?.stop();
      toneRef.current = null;
    };
  }, [stopMic, stopCamera]);

  // Connection and speech services: time a few requests to /voice/health.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const times: number[] = [];
      let health: VoiceHealth | null = null;
      for (let i = 0; i < RTT_SAMPLES; i += 1) {
        const started = performance.now();
        try {
          health = await voice.health();
          times.push(performance.now() - started);
        } catch {
          // Counted as a failed sample.
        }
        if (cancelled) return;
      }
      if (times.length === 0) {
        setNetwork({ status: 'WARN', problem: 'failed' });
      } else {
        const rttMs = Math.round(median(times));
        setNetwork(
          rttMs < RTT_GOOD_MS
            ? { status: 'PASS', rttMs }
            : { status: 'WARN', rttMs, problem: rttMs < RTT_SLOW_MS ? 'slow' : 'verySlow' },
        );
      }
      setSpeech(health ? speechCheck(health) : { status: 'WARN', problem: 'failed' });
    })();
    return () => {
      cancelled = true;
    };
  }, [voice]);

  async function testMic() {
    stopMic();
    setLevel(0);
    setMic({ status: 'RUNNING' });
    let stream: MediaStream;
    try {
      stream = await openMicrophone();
    } catch (err) {
      setMic({ status: 'FAIL', problem: micProblem(err) });
      return;
    }
    if (!mountedRef.current) {
      stopStream(stream);
      return;
    }
    const meter = createLevelMeter(stream);
    if (!meter) {
      // Permission and a device, but no way to measure the level here.
      stopStream(stream);
      setMic({ status: 'WARN', problem: 'noMeter' });
      return;
    }
    const started = performance.now();
    let peak = 0;
    const timer = window.setInterval(() => {
      const value = meter.read();
      peak = Math.max(peak, value);
      setLevel(value);
      if (value >= MIC_PASS_LEVEL) {
        stopMic();
        setMic({ status: 'PASS' });
      } else if (performance.now() - started >= MIC_LISTEN_MS) {
        stopMic();
        setLevel(0);
        setMic({ status: 'WARN', problem: peak >= MIC_QUIET_LEVEL ? 'quiet' : 'silent' });
      }
    }, MIC_TICK_MS);
    micRef.current = { stream, meter, timer };
  }

  /** Opens the camera (with the microphone, as in the interview) and waits for a picture. */
  async function testCamera() {
    stopCamera();
    setPreviewing(false);
    setCamera({ status: 'RUNNING' });
    let stream: MediaStream;
    try {
      stream = await openCamera();
    } catch (err) {
      setCamera({ status: 'FAIL', problem: micProblem(err) });
      return;
    }
    if (!mountedRef.current) {
      stopStream(stream);
      return;
    }
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      // Older browsers return undefined instead of a promise; a muted preview may autoplay.
      void Promise.resolve(video.play()).catch(() => undefined);
    }
    setPreviewing(true);
    const started = performance.now();
    const active: { stream: MediaStream; timer: number | undefined } = { stream, timer: undefined };
    cameraRef.current = active;
    active.timer = window.setInterval(() => {
      const track = stream.getVideoTracks()[0];
      const width = track?.getSettings?.().width ?? 0;
      const picture =
        (videoRef.current?.videoWidth ?? 0) > 0 || (track?.readyState !== 'ended' && width > 0);
      if (picture) {
        window.clearInterval(active.timer);
        setCamera({ status: 'PASS' });
      } else if (performance.now() - started >= CAMERA_WAIT_MS) {
        stopCamera();
        setPreviewing(false);
        setCamera({ status: 'FAIL', problem: 'noPicture' });
      }
    }, MIC_TICK_MS);
  }

  function playTone() {
    toneRef.current?.stop();
    const tone = playTestTone();
    toneRef.current = tone;
    tone.done
      .then(() => {
        if (toneRef.current === tone) toneRef.current = null;
      })
      .catch(() => {
        if (mountedRef.current) setSpeaker({ status: 'WARN', problem: 'noAudio' });
      });
    setSpeaker({ status: 'RUNNING', played: true });
  }

  function applyReadiness(readiness: VoiceReadiness) {
    queryClient.setQueryData<InterviewSummary>(queryKeys.interview(interview.id), (old) =>
      old ? { ...old, voice: readiness, consentsPending: !readiness.consentsComplete } : old,
    );
  }

  async function save() {
    stopMic();
    stopCamera();
    setPreviewing(false);
    setStage('saving');
    setSaveError(null);
    try {
      const readiness = await voice.deviceCheck(interview.id, {
        microphone: mic.status as DeviceCheckStatus,
        recorder: recorder.status as DeviceCheckStatus,
        speaker: speaker.status as DeviceCheckStatus,
        network: network.status as DeviceCheckStatus,
        speechService: speech.status as DeviceCheckStatus,
        mimeType: support.mimeType,
        camera: isVideo ? (camera.status as DeviceCheckStatus) : null,
        videoMimeType: isVideo ? videoMimeType : null,
        rttMs: network.rttMs ?? null,
        browser: browserLabel(),
      });
      applyReadiness(readiness);
      if (!readiness.deviceCheck?.passed) setStage('failed');
      else setStage(readiness.ready ? 'done' : 'consent');
    } catch (err) {
      setSaveError(inputErrorMessage(t, err));
      setStage('checks');
    }
  }

  useEffect(() => {
    if (stage === 'done' || stage === 'failed') doneRef.current?.focus();
  }, [stage]);

  const checks = isVideo
    ? [recorder, camera, mic, speaker, network, speech]
    : [recorder, mic, speaker, network, speech];
  const allDecided = checks.every(decided);
  const requiredFailed =
    recorder.status === 'FAIL' || mic.status === 'FAIL' || (isVideo && camera.status === 'FAIL');

  if (stage === 'consent') {
    return (
      <>
        <ConsentStep sessionId={interview.id} onDone={() => setStage('done')} />
        <SwitchToText interview={interview} />
      </>
    );
  }

  if (stage === 'done') {
    return (
      <>
        <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="done-title">
          <h2 id="done-title" ref={doneRef} tabIndex={-1} className="h4">
            <i className="bi bi-check-circle text-success me-2" aria-hidden="true" />
            {t('voice.check.done.title')}
          </h2>
          <p>{isVideo ? t('voice.check.done.videoBody') : t('voice.check.done.body')}</p>
          <Link to={`/app/interviews/${interview.id}/start`} className="btn btn-primary btn-lg">
            {t('voice.check.done.continue')}
          </Link>
        </section>
        <SwitchToText interview={interview} />
      </>
    );
  }

  if (stage === 'failed') {
    return (
      <>
        <section
          className="p-4 border border-danger rounded-3 bg-white"
          aria-labelledby="failed-title"
        >
          <h2 id="failed-title" ref={doneRef} tabIndex={-1} className="h5">
            <i className="bi bi-x-circle text-danger me-2" aria-hidden="true" />
            {t('voice.check.failed.title')}
          </h2>
          <p>{isVideo ? t('voice.check.failed.videoBody') : t('voice.check.failed.body')}</p>
          <button
            type="button"
            className="btn btn-outline-primary"
            onClick={() => setStage('checks')}
          >
            {t('voice.check.failed.retry')}
          </button>
        </section>
        <SwitchToText interview={interview} />
      </>
    );
  }

  const guidance = {
    recorder: recorder.problem ? t(`voice.check.recorder.${recorder.problem}`) : null,
    camera:
      camera.status === 'PASS'
        ? t('voice.check.camera.pass')
        : camera.status === 'RUNNING'
          ? t('voice.check.camera.waiting')
          : camera.problem
            ? t(`voice.check.camera.${camera.problem}`)
            : t('voice.check.camera.intro'),
    mic:
      mic.status === 'PASS'
        ? t('voice.check.mic.pass')
        : mic.status === 'RUNNING'
          ? t('voice.check.mic.listening')
          : mic.problem
            ? t(`voice.check.mic.${mic.problem}`)
            : t('voice.check.mic.intro'),
    speaker:
      speaker.status === 'PASS'
        ? t('voice.check.speaker.pass')
        : speaker.status === 'RUNNING'
          ? null
          : speaker.problem
            ? t(`voice.check.speaker.${speaker.problem}`)
            : t('voice.check.speaker.intro'),
    network:
      network.status === 'RUNNING'
        ? null
        : network.problem
          ? t(`voice.check.network.${network.problem}`, { ms: network.rttMs })
          : t('voice.check.network.pass', { ms: network.rttMs }),
    speech:
      speech.status === 'RUNNING'
        ? null
        : speech.problem
          ? t(`voice.check.speech.${speech.problem}`)
          : t('voice.check.speech.pass'),
  };

  return (
    <>
      <p className="mb-4">{isVideo ? t('voice.check.videoIntro') : t('voice.check.intro')}</p>
      <ul className="list-unstyled d-flex flex-column gap-3 mb-4">
        <CheckItem
          icon="bi-browser-chrome"
          title={t('voice.check.recorder.title')}
          check={recorder}
          guidance={
            guidance.recorder ??
            (isVideo ? t('voice.check.recorder.videoPass') : t('voice.check.recorder.pass'))
          }
        />
        {isVideo && (
          <CheckItem
            icon="bi-camera-video"
            title={t('voice.check.camera.title')}
            check={camera}
            guidance={guidance.camera}
          >
            <video
              ref={videoRef}
              className="d-block rounded-3 bg-dark mb-2 cb-self-view-mirror"
              style={{ width: '100%', maxWidth: '20rem', aspectRatio: '4 / 3' }}
              muted
              playsInline
              autoPlay
              hidden={!previewing}
              aria-label={t('voice.check.camera.preview')}
            />
            {support.getUserMedia && camera.status !== 'RUNNING' && (
              <button
                type="button"
                className={`btn btn-sm ${camera.status === 'PENDING' ? 'btn-primary' : 'btn-outline-primary'}`}
                onClick={() => void testCamera()}
              >
                {camera.status === 'PENDING'
                  ? t('voice.check.camera.test')
                  : t('voice.check.testAgain')}
              </button>
            )}
          </CheckItem>
        )}
        <CheckItem
          icon="bi-mic"
          title={t('voice.check.mic.title')}
          check={mic}
          guidance={guidance.mic}
        >
          {mic.status === 'RUNNING' && (
            <div
              className="progress cb-voice-meter"
              style={{ height: '0.75rem' }}
              role="meter"
              aria-label={t('voice.check.mic.level')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(level * 100)}
            >
              <div
                className="progress-bar bg-success"
                style={{ width: `${Math.round(level * 100)}%` }}
              />
            </div>
          )}
          {support.getUserMedia && mic.status !== 'RUNNING' && (
            <button
              type="button"
              className={`btn btn-sm ${mic.status === 'PENDING' ? 'btn-primary' : 'btn-outline-primary'}`}
              onClick={() => void testMic()}
            >
              {mic.status === 'PENDING' ? t('voice.check.mic.test') : t('voice.check.testAgain')}
            </button>
          )}
        </CheckItem>
        <CheckItem
          icon="bi-volume-up"
          title={t('voice.check.speaker.title')}
          check={speaker}
          guidance={guidance.speaker}
        >
          {support.audioContext && (
            <div className="d-flex flex-wrap align-items-center gap-2">
              <button
                type="button"
                className={`btn btn-sm ${speaker.played ? 'btn-outline-primary' : 'btn-primary'}`}
                onClick={playTone}
              >
                <i className="bi bi-play-fill me-1" aria-hidden="true" />
                {speaker.played
                  ? t('voice.check.speaker.playAgain')
                  : t('voice.check.speaker.play')}
              </button>
              {speaker.status === 'RUNNING' && (
                <fieldset className="d-flex flex-wrap align-items-center gap-2 mb-0">
                  <legend className="small fw-semibold mb-0 me-1 float-none w-auto">
                    {t('voice.check.speaker.question')}
                  </legend>
                  <button
                    type="button"
                    className="btn btn-sm btn-success"
                    onClick={() => setSpeaker({ status: 'PASS', played: true })}
                  >
                    {t('voice.check.speaker.yes')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() =>
                      setSpeaker({ status: 'WARN', problem: 'noAnswer', played: true })
                    }
                  >
                    {t('voice.check.speaker.no')}
                  </button>
                </fieldset>
              )}
            </div>
          )}
        </CheckItem>
        <CheckItem
          icon="bi-wifi"
          title={t('voice.check.network.title')}
          check={network}
          guidance={guidance.network}
        />
        <CheckItem
          icon="bi-soundwave"
          title={t('voice.check.speech.title')}
          check={speech}
          guidance={guidance.speech}
        />
      </ul>

      {allDecided && requiredFailed && (
        <div className="alert alert-warning" role="alert">
          {isVideo ? t('voice.check.requiredFailedVideo') : t('voice.check.requiredFailed')}
        </div>
      )}
      {saveError && (
        <div className="alert alert-danger" role="alert">
          {saveError}
        </div>
      )}
      <div className="d-flex flex-wrap align-items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={!allDecided || stage === 'saving'}
          onClick={() => void save()}
        >
          {stage === 'saving' ? t('voice.check.saving') : t('voice.check.save')}
        </button>
        {!allDecided && (
          <span className="small cb-text-secondary">{t('voice.check.finishChecks')}</span>
        )}
      </div>
      <SwitchToText interview={interview} />
    </>
  );
}

/** Screen 14: device check and consents before a voice or video interview can start. */
export function DeviceCheckPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const interview = useInterview(id);

  if (interview.isPending) return <RouteLoading />;
  if (interview.isError || !interview.data) {
    return (
      <div className="container py-5" role="alert">
        <h1 className="h3">{t('analysis.loadErrorTitle')}</h1>
        <p className="cb-text-secondary">{inputErrorMessage(t, interview.error)}</p>
        <Link to="/app" className="btn btn-outline-primary">
          {t('interview.backToDashboard')}
        </Link>
      </div>
    );
  }
  const data = interview.data;
  if (isLive(data.state) || isEnded(data)) return <Navigate to={interviewPath(data)} replace />;
  if (['DRAFT', 'ROLE_ANALYSIS', 'FAILED'].includes(data.state)) {
    return <Navigate to={`/app/interviews/${data.id}/analysis`} replace />;
  }
  if (!isSpokenMode(data.mode)) {
    return <Navigate to={`/app/interviews/${data.id}/start`} replace />;
  }

  const preStart = ['READY', 'DEVICE_CHECK', 'CONSENT_REQUIRED', 'READY_TO_START'].includes(
    data.state,
  );
  return (
    <div className="container py-5" style={{ maxWidth: '48rem' }}>
      <h1 className="h3">
        {data.mode === 'VIDEO' ? t('voice.check.videoTitle') : t('voice.check.title')}
      </h1>
      <p className="cb-text-secondary">{data.title}</p>
      {preStart ? (
        <DeviceCheck interview={data} />
      ) : (
        <section className="p-4 border cb-border rounded-3 bg-white">
          <p className="mb-3">
            {t('interview.stateNotice', { state: t(`interview.states.${data.state}`) })}
          </p>
          <Link to="/app" className="btn btn-outline-primary">
            {t('interview.backToDashboard')}
          </Link>
        </section>
      )}
    </div>
  );
}
