import { DOCUMENT_LIMITS, JobUrl, type ExtractionErrorCode } from '@cbi/shared-types';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { track } from '../../../lib/analytics';
import { ExtractionStatus } from '../components/ExtractionStatus';
import { FileDrop } from '../components/FileDrop';
import { useInterviewsApi, useJobStatus } from '../interviews-api';
import { inputErrorMessage } from '../messages';
import { StepActions } from './StepActions';
import type { JdTab, StepProps } from './wizard-state';

const TABS: JdTab[] = ['PASTE', 'UPLOAD', 'URL'];
/** Link failures where pasting the text is the practical way forward. */
const PAGE_UNREADABLE: ExtractionErrorCode[] = ['URL_BLOCKED', 'FETCH_FAILED', 'NOT_READABLE'];

export function JobStep({ state, update, onBack, onNext }: StepProps) {
  const { t, i18n } = useTranslation();
  const api = useInterviewsApi();
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const tab = state.jdTab;
  const target = state.jdTarget?.source === tab ? state.jdTarget : null;
  const status = useJobStatus(target?.id ?? null);
  const extraction = status.data;
  const count = state.jdText.trim().length;
  const numberFormat = new Intl.NumberFormat(i18n.resolvedLanguage);

  const selectTab = (next: JdTab) => {
    setError(null);
    setFieldError(null);
    update({ jdTab: next });
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const nextIndex = (index + delta + TABS.length) % TABS.length;
    selectTab(TABS[nextIndex]!);
    tabRefs.current[nextIndex]?.focus();
  };

  async function uploadFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const created = await api.uploadJobTarget(file);
      update({
        jdTarget: { id: created.id, source: 'UPLOAD', label: created.originalName ?? file.name },
      });
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  /** Creates the link target; returns false when the URL is not acceptable. */
  async function readLink(): Promise<boolean> {
    setError(null);
    setFieldError(null);
    const url = state.jdUrl.trim();
    if (!JobUrl.safeParse(url).success) {
      setFieldError(t('wizard.jd.urlInvalid'));
      return false;
    }
    setBusy(true);
    try {
      const created = await api.createJobTarget({ source: 'URL', url });
      update({ jdTarget: { id: created.id, source: 'URL', label: url } });
      return true;
    } catch (err) {
      setError(inputErrorMessage(t, err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const next = async () => {
    setError(null);
    setFieldError(null);
    if (tab === 'PASTE') {
      if (count < DOCUMENT_LIMITS.minPasteChars) {
        setFieldError(t('wizard.jd.pasteTooShort', { min: DOCUMENT_LIMITS.minPasteChars }));
        textareaRef.current?.focus();
        return;
      }
    } else if (tab === 'UPLOAD') {
      if (!target) {
        setError(t('wizard.jd.uploadFirst'));
        return;
      }
      if (extraction?.status === 'FAILED') {
        setError(t('wizard.jd.failedChooseAnother'));
        return;
      }
    } else {
      // A new or changed link is read first so the candidate sees whether it worked.
      if (!target || target.label !== state.jdUrl.trim()) {
        await readLink();
        return;
      }
      if (extraction?.status === 'FAILED') {
        setError(t('wizard.jd.failedChooseAnother'));
        return;
      }
    }
    update({ jdSkipped: false });
    track('jd_added', { source: tab.toLowerCase() });
    onNext();
  };

  const pastePanel = (
    <div>
      <label htmlFor={`${id}-text`} className="form-label">
        {t('wizard.jd.pasteLabel')}
      </label>
      <textarea
        ref={textareaRef}
        id={`${id}-text`}
        className={`form-control ${fieldError ? 'is-invalid' : ''}`}
        rows={10}
        maxLength={DOCUMENT_LIMITS.maxPasteChars}
        value={state.jdText}
        aria-invalid={fieldError ? true : undefined}
        aria-describedby={`${id}-count${fieldError ? ` ${id}-text-error` : ''}`}
        onChange={(e) => update({ jdText: e.target.value })}
      />
      {fieldError && (
        <div id={`${id}-text-error`} className="invalid-feedback d-block" role="alert">
          {fieldError}
        </div>
      )}
      <div id={`${id}-count`} className="form-text d-flex flex-wrap justify-content-between gap-2">
        <span>
          {t('wizard.jd.pasteLimits', {
            min: numberFormat.format(DOCUMENT_LIMITS.minPasteChars),
            max: numberFormat.format(DOCUMENT_LIMITS.maxPasteChars),
          })}
        </span>
        <span>
          {t('wizard.jd.charCount', {
            count,
            formatted: numberFormat.format(count),
            max: numberFormat.format(DOCUMENT_LIMITS.maxPasteChars),
          })}
        </span>
      </div>
    </div>
  );

  const uploadPanel = (
    <div>
      <FileDrop
        label={t('wizard.jd.fileLabel')}
        busy={busy}
        busyLabel={t('inputs.uploading')}
        onFile={(file) => void uploadFile(file)}
      />
      {target && (
        <div className="mt-3">
          <p className="small mb-1 text-break">{t('wizard.jd.fileName', { name: target.label })}</p>
          <ExtractionStatus kind="jd" extraction={extraction}>
            <p className="mb-0 mt-2 small">{t('wizard.jd.failedNext')}</p>
          </ExtractionStatus>
        </div>
      )}
    </div>
  );

  const pageUnreadable =
    extraction?.status === 'FAILED' && PAGE_UNREADABLE.includes(extraction.errorCode ?? 'INTERNAL');

  const urlPanel = (
    <div>
      <label htmlFor={`${id}-url`} className="form-label">
        {t('wizard.jd.urlLabel')}
      </label>
      <div className="d-flex flex-wrap gap-2">
        <input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          className={`form-control flex-grow-1 w-auto ${fieldError ? 'is-invalid' : ''}`}
          placeholder="https://"
          value={state.jdUrl}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={`${id}-url-hint${fieldError ? ` ${id}-url-error` : ''}`}
          onChange={(e) => update({ jdUrl: e.target.value })}
        />
        <button
          type="button"
          className="btn btn-outline-primary"
          disabled={busy}
          onClick={() => void readLink()}
        >
          {busy ? t('wizard.jd.reading') : t('wizard.jd.readLink')}
        </button>
      </div>
      {fieldError && (
        <div id={`${id}-url-error`} className="invalid-feedback d-block" role="alert">
          {fieldError}
        </div>
      )}
      <div id={`${id}-url-hint`} className="form-text">
        {t('wizard.jd.urlHint')}
      </div>
      {target && target.label === state.jdUrl.trim() && (
        <div className="mt-3">
          {pageUnreadable ? (
            <div className="alert alert-warning mb-0" role="alert">
              <p className="fw-semibold mb-1">{t('wizard.jd.pageUnreadableTitle')}</p>
              <p className="mb-2">{t(`inputs.errors.${extraction?.errorCode ?? 'INTERNAL'}`)}</p>
              <p className="mb-2">{t('wizard.jd.pasteInstead')}</p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  selectTab('PASTE');
                  // Wait for the paste panel to render before moving focus into it.
                  setTimeout(() => textareaRef.current?.focus(), 0);
                }}
              >
                {t('wizard.jd.pasteInsteadButton')}
              </button>
            </div>
          ) : (
            <ExtractionStatus kind="jd" extraction={extraction} />
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      <p className="cb-text-secondary">{t('wizard.jd.intro')}</p>
      <div className="nav nav-tabs mb-3" role="tablist" aria-label={t('wizard.jd.tabsLabel')}>
        {TABS.map((value, index) => (
          <button
            key={value}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            id={`${id}-tab-${value}`}
            type="button"
            role="tab"
            className={`nav-link ${tab === value ? 'active' : ''}`}
            aria-selected={tab === value}
            aria-controls={`${id}-panel`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => selectTab(value)}
            onKeyDown={(e) => onTabKey(e, index)}
          >
            {t(`wizard.jd.tabs.${value}`)}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}>
        {tab === 'PASTE' ? pastePanel : tab === 'UPLOAD' ? uploadPanel : urlPanel}
      </div>

      {error && (
        <div className="alert alert-danger mt-3 mb-0" role="alert">
          {error}
        </div>
      )}

      <StepActions
        onBack={onBack}
        onNext={() => void next()}
        nextPending={busy}
        skipLabel={t('wizard.jd.skip')}
        onSkip={() => {
          update({ jdSkipped: true });
          onNext();
        }}
      />
    </>
  );
}
