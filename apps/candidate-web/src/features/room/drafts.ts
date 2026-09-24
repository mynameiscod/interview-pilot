/**
 * Unsent answers are kept per question in sessionStorage so a page refresh
 * does not lose them. They never leave the browser tab.
 */
const key = (sessionId: string, questionId: string) => `cbi.room.draft.${sessionId}.${questionId}`;

export function loadDraft(sessionId: string, questionId: string): string {
  try {
    return sessionStorage.getItem(key(sessionId, questionId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(sessionId: string, questionId: string, text: string) {
  try {
    if (text) sessionStorage.setItem(key(sessionId, questionId), text);
    else sessionStorage.removeItem(key(sessionId, questionId));
  } catch {
    // Storage full or blocked: the draft simply is not kept across a refresh.
  }
}

export function clearDraft(sessionId: string, questionId: string) {
  saveDraft(sessionId, questionId, '');
}
