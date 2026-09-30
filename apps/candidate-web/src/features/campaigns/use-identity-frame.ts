import { useEffect, useRef } from 'react';
import { useCandidateAuth } from '../../app/session';
import { uploadIdentityPhoto } from './campaigns-api';
import { captureStreamFrame } from './identity-frame';

/** How long into a video interview the one frame is taken (the candidate has settled in). */
export const IDENTITY_FRAME_DELAY_MS = 20_000;

/**
 * Campaigns with identity capture: one still frame from the camera, taken
 * once during a video interview, for reviewers to compare with the selfie
 * and ID photo (the candidate agreed to this in the identity notice).
 * Failures are ignored: it never disturbs the interview.
 */
export function useIdentityFrame(sessionId: string, stream: MediaStream | null, enabled: boolean) {
  const { manager } = useCandidateAuth();
  const sent = useRef(false);
  useEffect(() => {
    if (!enabled || !stream || sent.current) return;
    const timer = setTimeout(() => {
      sent.current = true;
      void captureStreamFrame(stream)
        .then((blob) =>
          blob ? uploadIdentityPhoto(manager, sessionId, 'interview-frame', blob) : null,
        )
        .catch(() => undefined);
    }, IDENTITY_FRAME_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, stream, manager, sessionId]);
}
