import type { ResumeStructured, TailoringSuggestions } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { track } from '../../lib/analytics';
import { inputErrorMessage } from '../interviews/messages';
import { useResumeToolsApi, useTailoring } from './resume-tools-api';
import { tailoredDraft } from './tailored-draft';

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  };
  return { copied, copy };
}

function download(filename: string, text: string, type: string) {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function CopyButton({
  label,
  done,
  onClick,
}: {
  label: string;
  done: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onClick}>
      <i className={`bi ${done ? 'bi-clipboard-check' : 'bi-clipboard'} me-1`} aria-hidden="true" />
      {done ? t('resumeTools.tailor.copied') : label}
    </button>
  );
}

function Suggestions({ s, resume }: { s: TailoringSuggestions; resume: ResumeStructured | null }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  const draft = () =>
    tailoredDraft(resume, s, {
      notice: t('resumeTools.tailor.draftNotice'),
      summary: t('resumeTools.tailor.summary'),
      skills: t('resumeTools.resume.skills'),
      experience: t('resumeTools.resume.experience'),
      projects: t('resumeTools.resume.projects'),
      education: t('resumeTools.resume.education'),
      certifications: t('resumeTools.tailor.certifications'),
      present: t('resumeTools.resume.present'),
    });

  return (
    <div>
      {s.source === 'FALLBACK' && (
        <div className="alert alert-secondary py-2 small" role="status">
          {t('resumeTools.tailor.fallback')}
        </div>
      )}
      {s.guardNotes.length > 0 && (
        <ul className="small cb-text-secondary ps-3">
          {s.guardNotes.map((n) => (
            <li key={n.note}>{t(`resumeTools.tailor.guard.${n.note}`, { count: n.count })}</li>
          ))}
        </ul>
      )}

      {s.summary && (
        <>
          <h3 className="h6">{t('resumeTools.tailor.summary')}</h3>
          <p className="mb-2">{s.summary}</p>
          <CopyButton
            label={t('resumeTools.tailor.copy')}
            done={copied === 'summary'}
            onClick={() => void copy('summary', s.summary)}
          />
        </>
      )}

      <h3 className="h6 mt-4">{t('resumeTools.tailor.bullets')}</h3>
      {s.bullets.length ? (
        <ol className="ps-3">
          {s.bullets.map((b, i) => (
            <li key={`${b.original}-${i}`} className="mb-3">
              <p className="small cb-text-secondary mb-1">
                {t('resumeTools.tailor.original')}: {b.original}
              </p>
              <p className="mb-1">{b.rewritten}</p>
              {b.placeholders.length > 0 && (
                <p className="small text-warning-emphasis mb-1">
                  <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
                  {t('resumeTools.tailor.placeholders', { list: b.placeholders.join(', ') })}
                </p>
              )}
              <CopyButton
                label={t('resumeTools.tailor.copy')}
                done={copied === `b${i}`}
                onClick={() => void copy(`b${i}`, b.rewritten)}
              />
            </li>
          ))}
        </ol>
      ) : (
        <p className="small cb-text-secondary">{t('resumeTools.tailor.noBullets')}</p>
      )}

      <h3 className="h6 mt-4">{t('resumeTools.tailor.missing')}</h3>
      {s.missingKeywords.length ? (
        <ul className="small ps-3">
          {s.missingKeywords.map((k) => (
            <li key={k.keyword} className="mb-1">
              <span className="fw-semibold">{k.keyword}</span>
              {k.mustHave && (
                <span className="badge text-bg-light border cb-border fw-normal ms-1">
                  {t('resumeTools.tailor.required')}
                </span>
              )}
              <span> {k.guidance || t('resumeTools.tailor.defaultGuidance')}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small cb-text-secondary">{t('resumeTools.tailor.noMissing')}</p>
      )}

      <h3 className="h6 mt-4">{t('resumeTools.tailor.exportTitle')}</h3>
      <p className="small cb-text-secondary">{t('resumeTools.tailor.exportHint')}</p>
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-outline-primary btn-sm"
          onClick={() => {
            track('resume_draft_exported', { format: 'txt' });
            download('tailored-resume-draft.txt', draft().text, 'text/plain');
          }}
        >
          <i className="bi bi-download me-1" aria-hidden="true" />
          {t('resumeTools.tailor.downloadText')}
        </button>
        <button
          type="button"
          className="btn btn-outline-primary btn-sm"
          onClick={() => {
            track('resume_draft_exported', { format: 'md' });
            download('tailored-resume-draft.md', draft().markdown, 'text/markdown');
          }}
        >
          <i className="bi bi-markdown me-1" aria-hidden="true" />
          {t('resumeTools.tailor.downloadMarkdown')}
        </button>
        <CopyButton
          label={t('resumeTools.tailor.copyMarkdown')}
          done={copied === 'markdown'}
          onClick={() => void copy('markdown', draft().markdown)}
        />
      </div>
    </div>
  );
}

/**
 * AI tailoring suggestions for one resume and job description. Suggestions
 * only reuse facts from the resume and are never applied automatically: the
 * candidate copies what is true.
 */
export function TailoringPanel({
  resumeId,
  jobTargetId,
  resume,
}: {
  resumeId: string | null;
  jobTargetId: string | null;
  /** The effective structured resume, for the exported draft. */
  resume: ResumeStructured | null;
}) {
  const { t } = useTranslation();
  const id = useId();
  const api = useResumeToolsApi();
  const [request, setRequest] = useState<{ key: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `${resumeId}:${jobTargetId}`;
  const current = request?.key === key ? request.id : null;
  const tailoring = useTailoring(current);
  const data = tailoring.data;

  async function ask() {
    if (!resumeId || !jobTargetId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.requestTailoring({ resumeId, jobTargetId });
      setRequest({ key, id: created.id });
      track('resume_tailoring_requested', {});
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h5">
        {t('resumeTools.tailor.title')}
      </h2>
      <div className="alert alert-info small" role="note">
        <i className="bi bi-info-circle me-2" aria-hidden="true" />
        {t('resumeTools.tailor.honestyNote')}
      </div>
      {error && (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      )}
      {!data ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={!resumeId || !jobTargetId || busy}
          onClick={() => void ask()}
        >
          {busy ? t('resumeTools.tailor.asking') : t('resumeTools.tailor.ask')}
        </button>
      ) : data.status === 'PENDING' ? (
        <p className="d-flex align-items-center gap-2 mb-0" role="status" aria-live="polite">
          <span className="spinner-border spinner-border-sm text-primary" aria-hidden="true" />
          {t('resumeTools.tailor.working')}
        </p>
      ) : data.status === 'FAILED' ? (
        <div className="alert alert-warning mb-0" role="alert">
          {t(`resumeTools.tailor.failed.${data.failureCode ?? 'INTERNAL'}`)}
        </div>
      ) : data.suggestions ? (
        <Suggestions s={data.suggestions} resume={resume} />
      ) : null}
    </section>
  );
}
