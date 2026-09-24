import {
  DOCUMENT_LIMITS,
  type JobTargetSummary,
  type UpdateJobTargetBody,
} from '@cbi/shared-types';
import type { LibraryChoice } from '../components/Typeahead';

export const WIZARD_STEPS = ['start', 'resume', 'jd', 'target'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type JdTab = 'PASTE' | 'UPLOAD' | 'URL';

/** A job target the JD step already created (uploads and links need one to show status). */
export interface SavedJdTarget {
  id: string;
  source: JobTargetSummary['source'];
  /** File name or URL, shown back to the candidate. */
  label: string;
}

export interface WizardState {
  step: number;
  resumeId: string | null;
  jdTab: JdTab;
  jdText: string;
  jdUrl: string;
  jdTarget: SavedJdTarget | null;
  jdSkipped: boolean;
  company: LibraryChoice | null;
  role: LibraryChoice | null;
  /**
   * Pasted-text or role-only target created at submit time. Reused while its
   * source (text, or role only) is unchanged, so going back and submitting
   * again never creates duplicates; company/role changes go through PATCH.
   */
  finalTarget: { id: string; key: string } | null;
  /** Company/role last saved on a job target, so unchanged fields are not re-sent. */
  targetFields: { id: string; key: string } | null;
  /** Job target whose company/role have already been used to prefill the final step. */
  prefilledTargetId: string | null;
  interview: { id: string; key: string } | null;
  /** Interview being replaced after "Edit inputs"; cancelled once the new one exists. */
  replacesInterviewId: string | null;
  /** Set once the wizard has handed over to the analysis screen. */
  submittedInterviewId: string | null;
}

export const initialWizardState = (): WizardState => ({
  step: 0,
  resumeId: null,
  jdTab: 'PASTE',
  jdText: '',
  jdUrl: '',
  jdTarget: null,
  jdSkipped: false,
  company: null,
  role: null,
  finalTarget: null,
  targetFields: null,
  prefilledTargetId: null,
  interview: null,
  replacesInterviewId: null,
  submittedInterviewId: null,
});

const STORAGE_KEY = 'cbi.newInterview';

export function loadWizardState(): WizardState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WizardState>;
    return { ...initialWizardState(), ...parsed };
  } catch {
    return null;
  }
}

export function saveWizardState(state: WizardState) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be full or blocked; the wizard still works without it.
  }
}

export function clearWizardState() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore: nothing to clear.
  }
}

/**
 * Picks the starting state for `/app/new`:
 * - an unfinished wizard in this tab resumes where it was;
 * - "Edit inputs" for the interview this tab just created reopens its inputs;
 * - anything else starts fresh (an edit of another interview is prefilled later).
 */
export function startingState(editId: string | null): { state: WizardState; restored: boolean } {
  const stored = loadWizardState();
  if (stored && !stored.submittedInterviewId && (!editId || stored.replacesInterviewId === editId))
    return { state: stored, restored: true };
  if (stored && editId && stored.submittedInterviewId === editId) {
    return {
      state: {
        ...stored,
        step: 1,
        interview: null,
        submittedInterviewId: null,
        replacesInterviewId: editId,
      },
      restored: true,
    };
  }
  return {
    state: { ...initialWizardState(), replacesInterviewId: editId, step: editId ? 1 : 0 },
    restored: false,
  };
}

/** Prefill for "Edit inputs" on an interview created elsewhere (only what the server returns). */
export function prefillFromTarget(
  state: WizardState,
  resumeId: string | null,
  target: JobTargetSummary,
): WizardState {
  const { company, role } = targetChoices(target);
  const next: WizardState = {
    ...state,
    resumeId,
    company,
    role,
    prefilledTargetId: target.id,
    targetFields: { id: target.id, key: fieldsKey(targetFieldsBody(company, role)) },
  };
  switch (target.source) {
    case 'URL':
      return {
        ...next,
        jdTab: 'URL',
        jdUrl: target.url ?? '',
        jdTarget: { id: target.id, source: 'URL', label: target.url ?? '' },
      };
    case 'UPLOAD':
      return {
        ...next,
        jdTab: 'UPLOAD',
        jdTarget: { id: target.id, source: 'UPLOAD', label: target.originalName ?? '' },
      };
    case 'ROLE_ONLY':
      // Reused on submit (its role can be changed with PATCH).
      return {
        ...next,
        jdSkipped: true,
        finalTarget: { id: target.id, key: finalTargetKey({ source: 'ROLE_ONLY' }) },
      };
    default:
      // Pasted text is not sent back to the browser; the candidate pastes it again.
      return { ...next, jdTab: 'PASTE' };
  }
}

/** Props every wizard step receives from the page. */
export interface StepProps {
  state: WizardState;
  /**
   * Merges a patch. Pass a function to compute it from the latest state (for
   * effects that must not overwrite changes made since they were scheduled).
   */
  update: (patch: Partial<WizardState> | ((s: WizardState) => Partial<WizardState>)) => void;
  onBack: () => void;
  onNext: () => void;
}

/** The JD target already saved by the JD step, when the chosen tab is an upload or link. */
export function savedJdTarget(state: WizardState) {
  if (state.jdSkipped || state.jdTab === 'PASTE') return null;
  return state.jdTarget?.source === state.jdTab ? state.jdTarget : null;
}

export function hasJobDescription(state: WizardState) {
  if (state.jdSkipped) return false;
  if (state.jdTab === 'PASTE') return state.jdText.trim().length >= DOCUMENT_LIMITS.minPasteChars;
  return savedJdTarget(state) !== null;
}

/** Company and role chosen on a target, else those read from its job description. */
export function targetChoices(target: JobTargetSummary): {
  company: LibraryChoice | null;
  role: LibraryChoice | null;
} {
  const detected = target.extraction.status === 'READY' ? target.structured : null;
  const company = target.company
    ? { id: target.company.id, name: target.company.name }
    : target.companyName
      ? { id: null, name: target.companyName }
      : detected?.companyName
        ? { id: null, name: detected.companyName }
        : null;
  const role = target.role
    ? { id: target.role.id, name: target.role.title }
    : target.roleTitle
      ? { id: null, name: target.roleTitle }
      : detected?.title
        ? { id: null, name: detected.title }
        : null;
  return { company, role };
}

/** The company/role fields as the API expects them (a library id, else the typed name). */
export function targetFieldsBody(
  company: LibraryChoice | null,
  role: LibraryChoice | null,
): UpdateJobTargetBody {
  return {
    ...(company ? (company.id ? { companyId: company.id } : { companyName: company.name }) : {}),
    ...(role ? (role.id ? { roleId: role.id } : { roleTitle: role.name }) : {}),
  };
}

export const fieldsKey = (fields: UpdateJobTargetBody) =>
  JSON.stringify([fields.companyId, fields.companyName, fields.roleId, fields.roleTitle]);

/** Identifies a submit-time target by its source only (company/role are patched). */
export const finalTargetKey = (
  source: { source: 'PASTE'; text: string } | { source: 'ROLE_ONLY' },
) => JSON.stringify(source);
