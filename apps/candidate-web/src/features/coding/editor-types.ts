import type { CodingLanguage } from '@cbi/shared-types';

/** What every code editor implementation (Monaco, or the plain fallback) accepts. */
export interface CodeEditorProps {
  id: string;
  value: string;
  language: CodingLanguage;
  onChange: (value: string) => void;
  onBlur: () => void;
  readOnly: boolean;
  /** Accessible name of the editing area. */
  ariaLabel: string;
  /** Ids of hints that describe the editor. */
  describedBy?: string;
  /** Ctrl/Cmd+Enter. */
  onRun: () => void;
  /** Ctrl/Cmd+Shift+Enter. */
  onSubmit: () => void;
  /** A paste into the editor, by length only (session observations). */
  onPaste?: (length: number) => void;
}

/** Spaces a Tab key press inserts in the plain editor. */
export const TAB_SPACES = 4;
