import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  /** Longest single entry (matches the API's limit for the field). */
  maxLength?: number;
  maxItems?: number;
}

/**
 * Editable chips: type and press Enter (or comma, or the Add button) to add,
 * use a chip's remove button to delete it. Duplicates are ignored.
 */
export function ChipsInput({ label, values, onChange, maxLength = 80, maxItems = 60 }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState('');

  const add = () => {
    const parts = draft
      .split(',')
      .map((p) => p.trim().slice(0, maxLength))
      .filter(Boolean);
    const known = new Set(values.map((v) => v.toLowerCase()));
    const next = [...values];
    for (const part of parts) {
      if (next.length >= maxItems) break;
      if (!known.has(part.toLowerCase())) {
        next.push(part);
        known.add(part.toLowerCase());
      }
    }
    onChange(next);
    setDraft('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="mb-3">
      <label htmlFor={`${id}-input`} className="form-label">
        {label}
      </label>
      {values.length > 0 && (
        <ul className="list-unstyled d-flex flex-wrap gap-2 mb-2">
          {values.map((value) => (
            <li
              key={value}
              className="badge text-bg-light border cb-border fw-normal d-flex align-items-center gap-1"
            >
              <span>{value}</span>
              <button
                type="button"
                className="btn-close btn-close-sm"
                style={{ fontSize: '0.6rem' }}
                aria-label={t('resumeTools.chips.remove', { value })}
                onClick={() => onChange(values.filter((v) => v !== value))}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="input-group">
        <input
          id={`${id}-input`}
          type="text"
          className="form-control"
          value={draft}
          maxLength={maxLength * 4}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className="btn btn-outline-secondary"
          onClick={add}
          disabled={!draft.trim()}
        >
          {t('resumeTools.chips.add')}
        </button>
      </div>
      <div id={`${id}-hint`} className="form-text">
        {t('resumeTools.chips.hint')}
      </div>
    </div>
  );
}
