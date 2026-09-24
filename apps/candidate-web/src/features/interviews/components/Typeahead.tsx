import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLibrarySearch } from '../interviews-api';

export interface LibraryChoice {
  /** Library id, or null for a name the candidate typed. */
  id: string | null;
  name: string;
}

interface Props {
  kind: 'companies' | 'roles';
  label: string;
  hint?: string;
  placeholder?: string;
  value: LibraryChoice | null;
  onChange: (value: LibraryChoice | null) => void;
  required?: boolean;
  error?: string | null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Combobox over the public library search with a free-text fallback
 * ("Use 'X'"). Typing without choosing keeps the typed text as a free-text
 * value. Follows the ARIA 1.2 combobox pattern (list autocomplete).
 */
export function Typeahead({
  kind,
  label,
  hint,
  placeholder,
  value,
  onChange,
  required,
  error,
}: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const query = useDebounced(text.trim(), 250);
  const search = useLibrarySearch(kind, query, open);

  // Keep the box in sync when the value is restored or cleared from outside
  // (adjusting state during render, not in an effect).
  const outside = value?.name ?? '';
  const [lastOutside, setLastOutside] = useState(outside);
  if (outside !== lastOutside) {
    setLastOutside(outside);
    if (outside !== text.trim()) setText(outside);
  }

  const results = search.data ?? [];
  const typed = text.trim();
  const exact = results.some((r) => r.name.toLowerCase() === typed.toLowerCase());
  const options: LibraryChoice[] = [
    ...results.map((r) => ({ id: r.id, name: r.name })),
    ...(typed && !exact ? [{ id: null, name: typed }] : []),
  ];
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');

  const choose = (choice: LibraryChoice) => {
    onChange(choice);
    setText(choice.name);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div className="mb-3 position-relative">
      <label htmlFor={id} className="form-label">
        {label}
        {required && ' '}
        {required && <span className="cb-text-secondary">{t('wizard.requiredMark')}</span>}
      </label>
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        className={`form-control ${error ? 'is-invalid' : ''}`}
        placeholder={placeholder}
        aria-autocomplete="list"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy || undefined}
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          setOpen(true);
          setActive(-1);
          onChange(next.trim() ? { id: null, name: next.trim() } : null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(options.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(-1, i - 1));
          } else if (e.key === 'Enter' && open && active >= 0 && options[active]) {
            e.preventDefault();
            choose(options[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      {hint && (
        <div id={`${id}-hint`} className="form-text">
          {hint}
        </div>
      )}
      {error && (
        <div id={`${id}-error`} className="invalid-feedback d-block" role="alert">
          {error}
        </div>
      )}
      <ul
        id={listId}
        role="listbox"
        aria-label={label}
        className="list-group position-absolute w-100 shadow-sm"
        style={{ zIndex: 10 }}
        hidden={!open || options.length === 0}
      >
        {options.map((option, i) => (
          <li
            key={option.id ?? `free-${option.name}`}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            className={`list-group-item list-group-item-action ${i === active ? 'active' : ''}`}
            // mousedown keeps focus in the input so blur does not close the list first.
            onMouseDown={(e) => {
              e.preventDefault();
              choose(option);
            }}
          >
            {option.id ? (
              option.name
            ) : (
              <>
                <i className="bi bi-pencil me-2" aria-hidden="true" />
                {t('wizard.useTyped', { name: option.name })}
              </>
            )}
          </li>
        ))}
      </ul>
      {value?.id && (
        <div className="form-text">
          <i className="bi bi-check2 me-1" aria-hidden="true" />
          {t('wizard.fromLibrary')}
        </div>
      )}
    </div>
  );
}
