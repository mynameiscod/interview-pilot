import { useRef, type KeyboardEvent } from 'react';
import { TAB_SPACES, type CodeEditorProps } from './editor-types';

/**
 * A plain code editor: monospace, no wrapping, Tab indents with spaces
 * (Shift+Tab or Escape then Tab still leave the field for keyboard users),
 * Ctrl/Cmd+Enter runs and Ctrl/Cmd+Shift+Enter submits. Used when the full
 * editor cannot load, and in tests.
 */
export default function TextareaCodeEditor(props: CodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  /** After Escape, the next Tab moves focus instead of indenting. */
  const tabEscapes = useRef(false);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey) props.onSubmit();
      else props.onRun();
      return;
    }
    if (e.key === 'Escape') {
      tabEscapes.current = true;
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !tabEscapes.current && !props.readOnly) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart, selectionEnd, value } = el;
      const spaces = ' '.repeat(TAB_SPACES);
      const next = value.slice(0, selectionStart) + spaces + value.slice(selectionEnd);
      props.onChange(next);
      const caret = selectionStart + spaces.length;
      requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret));
      return;
    }
    tabEscapes.current = false;
  }

  return (
    <textarea
      ref={ref}
      id={props.id}
      className="form-control font-monospace border-0 rounded-0"
      style={{ minHeight: '22rem', resize: 'vertical', whiteSpace: 'pre', tabSize: TAB_SPACES }}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      wrap="off"
      aria-label={props.ariaLabel}
      aria-describedby={props.describedBy}
      value={props.value}
      readOnly={props.readOnly}
      data-language={props.language}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onBlur}
      onKeyDown={onKeyDown}
      onPaste={(e) => props.onPaste?.((e.clipboardData?.getData('text') ?? '').length)}
    />
  );
}
