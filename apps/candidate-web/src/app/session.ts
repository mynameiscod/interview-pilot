import type { MeResponse } from '@cbi/shared-types';
import { useAuth, type SessionManager } from '@cbi/web-core';
import { clearWizardState } from '../features/interviews/wizard/wizard-state';

export const useCandidateAuth = () => useAuth<MeResponse>();

/**
 * Signing out (here or in another tab) forgets the unfinished interview
 * wizard, which can hold pasted job description text, and cached data.
 */
export function forgetOnSignOut(manager: SessionManager, clearCache: () => void) {
  return manager.subscribe((session) => {
    if (!session) {
      clearWizardState();
      clearCache();
    }
  });
}
