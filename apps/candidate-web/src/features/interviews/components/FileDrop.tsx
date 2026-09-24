import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACCEPT_ATTRIBUTE, fileProblem, MAX_UPLOAD_MB } from '../messages';

interface Props {
  /** Accessible name of the file input, e.g. "Resume file". */
  label: string;
  busy: boolean;
  busyLabel: string;
  onFile: (file: File) => void;
}

/**
 * Drag-and-drop area with a real button. The native input stays in the
 * accessibility tree (visually hidden); keyboard users use the button.
 */
export function FileDrop({ label, busy, busyLabel, onFile }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const accept = (file: File | undefined) => {
    if (!file) return;
    const issue = fileProblem(t, file);
    setProblem(issue);
    if (!issue) onFile(file);
  };

  return (
    <div>
      <div
        className={`p-4 rounded-3 text-center ${dragging ? 'border border-primary cb-surface-muted' : 'border cb-border'}`}
        style={{ borderStyle: 'dashed' }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) accept(e.dataTransfer.files[0]);
        }}
      >
        <i className="bi bi-cloud-arrow-up fs-2 text-secondary" aria-hidden="true" />
        <p className="mb-2">{t('inputs.dropHint')}</p>
        <label htmlFor={id} className="visually-hidden">
          {label}
        </label>
        <input
          ref={inputRef}
          id={id}
          type="file"
          className="visually-hidden"
          tabIndex={-1}
          accept={ACCEPT_ATTRIBUTE}
          aria-describedby={`${id}-hint${problem ? ` ${id}-error` : ''}`}
          disabled={busy}
          onChange={(e) => {
            accept(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn btn-outline-primary"
          disabled={busy}
          aria-describedby={`${id}-hint`}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? (
            <>
              <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
              {busyLabel}
            </>
          ) : (
            <>
              <i className="bi bi-folder2-open me-2" aria-hidden="true" />
              {t('inputs.chooseFile')}
            </>
          )}
        </button>
        <p id={`${id}-hint`} className="small cb-text-secondary mt-2 mb-0">
          {t('inputs.fileHint', { mb: MAX_UPLOAD_MB })}
        </p>
      </div>
      {problem && (
        <div id={`${id}-error`} className="alert alert-danger mt-2 mb-0" role="alert">
          {problem}
        </div>
      )}
    </div>
  );
}
