import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodeEditorProps } from './editor-types';

/**
 * Monaco loads in its own chunk the first time a coding question appears.
 * If that chunk cannot load (a flaky network, an old browser), the plain
 * editor takes its place so the candidate can still write and submit.
 */
const LazyEditor = lazy(() =>
  import('./MonacoCodeEditor').catch(() => import('./TextareaCodeEditor')),
);

export function CodeEditor(props: CodeEditorProps) {
  const { t } = useTranslation();
  return (
    <Suspense
      fallback={
        <p
          className="small cb-text-secondary d-flex align-items-center gap-2 p-3 mb-0"
          role="status"
        >
          <span className="spinner-border spinner-border-sm" aria-hidden="true" />
          {t('coding.editor.loading')}
        </p>
      }
    >
      <LazyEditor {...props} />
    </Suspense>
  );
}
