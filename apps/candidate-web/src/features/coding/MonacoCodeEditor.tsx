import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { TAB_SPACES, type CodeEditorProps } from './editor-types';
import { monaco } from './monaco-setup';

type EditorInstance = Parameters<OnMount>[0];

/** The Monaco code editor (lazy-loaded; see CodeEditor). */
export default function MonacoCodeEditor(props: CodeEditorProps) {
  const { t } = useTranslation();
  const editorRef = useRef<EditorInstance | null>(null);
  // Latest callbacks for the commands and listeners registered once on mount.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const textarea = editorRef.current?.getDomNode()?.querySelector('textarea');
    if (!textarea) return;
    if (props.describedBy) textarea.setAttribute('aria-describedby', props.describedBy);
    else textarea.removeAttribute('aria-describedby');
  }, [props.describedBy]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    const { KeyMod, KeyCode } = monaco;
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () => latest.current.onRun());
    editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter, () =>
      latest.current.onSubmit(),
    );
    editor.onDidBlurEditorText(() => latest.current.onBlur());
    editor.onDidPaste((e) => {
      const text = editor.getModel()?.getValueInRange(e.range) ?? '';
      latest.current.onPaste?.(text.length);
    });
    const textarea = editor.getDomNode()?.querySelector('textarea');
    if (textarea) {
      textarea.id = latest.current.id;
      if (latest.current.describedBy) {
        textarea.setAttribute('aria-describedby', latest.current.describedBy);
      }
    }
  };

  return (
    <Editor
      height="26rem"
      theme="vs"
      language={props.language}
      value={props.value}
      onChange={(value) => props.onChange(value ?? '')}
      onMount={onMount}
      loading={<span className="small cb-text-secondary">{t('coding.editor.loading')}</span>}
      options={{
        ariaLabel: props.ariaLabel,
        readOnly: props.readOnly,
        minimap: { enabled: false },
        fontSize: 14,
        tabSize: TAB_SPACES,
        insertSpaces: true,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: 'off',
        renderLineHighlight: 'line',
        quickSuggestions: false,
        contextmenu: false,
        tabFocusMode: false,
      }}
    />
  );
}
