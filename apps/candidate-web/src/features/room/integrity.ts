import type { IntegrityEventType } from '@cbi/shared-types';
import { useEffect, useRef } from 'react';

/** The same one-off observation (paste, fullscreen exit …) within this window is noted once. */
export const OBSERVATION_DEBOUNCE_MS = 1_000;

export type ReportIntegrity = (type: IntegrityEventType, value?: number) => void;

/**
 * Notes browser observations while `enabled` (the template tracks them and
 * the candidate agreed): the tab being hidden and shown again, the window
 * losing and regaining focus (with how long it was away), and leaving
 * fullscreen after the room entered it. They are observations with ordinary
 * explanations and are never shown to the candidate as warnings.
 */
export function useIntegrityObservations(enabled: boolean, report: ReportIntegrity) {
  const reportRef = useRef(report);
  useEffect(() => {
    reportRef.current = report;
  }, [report]);

  useEffect(() => {
    if (!enabled) return;
    const note: ReportIntegrity = (type, value) => reportRef.current(type, value);
    const noteOnce = debounced(note);
    // Paired events only change state once: a second "hidden" while hidden is a duplicate.
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
    let blurredAt: number | null = null;
    let fullscreen = Boolean(document.fullscreenElement);

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (hiddenAt !== null) return;
        hiddenAt = Date.now();
        note('TAB_HIDDEN');
      } else if (hiddenAt !== null) {
        const away = Date.now() - hiddenAt;
        hiddenAt = null;
        note('TAB_VISIBLE', away);
      }
    };
    const onBlur = () => {
      if (blurredAt !== null) return;
      blurredAt = Date.now();
      note('WINDOW_BLUR');
    };
    const onFocus = () => {
      if (blurredAt === null) return;
      const away = Date.now() - blurredAt;
      blurredAt = null;
      note('WINDOW_FOCUS', away);
    };
    const onFullscreen = () => {
      if (document.fullscreenElement) {
        fullscreen = true;
      } else if (fullscreen) {
        fullscreen = false;
        noteOnce('FULLSCREEN_EXIT');
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreen);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled]);
}

/** Drops a repeat of the same observation type within OBSERVATION_DEBOUNCE_MS. */
export function debounced(report: ReportIntegrity): ReportIntegrity {
  const last = new Map<IntegrityEventType, number>();
  return (type, value) => {
    const now = Date.now();
    const previous = last.get(type);
    if (previous !== undefined && now - previous < OBSERVATION_DEBOUNCE_MS) return;
    last.set(type, now);
    report(type, value);
  };
}
