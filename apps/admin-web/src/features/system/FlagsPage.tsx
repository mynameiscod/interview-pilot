import { UpdateFlagBody, type FeatureFlag } from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { systemKeys, useFlags } from './queries';

/** Flags the console explains in more detail. */
const FLAG_NOTES: Record<string, string> = {
  'reports.publicProof': 'system.flags.notes.publicProof',
};

function FlagState({ flag }: { flag: FeatureFlag }) {
  const { t } = useTranslation();
  if (!flag.enabled)
    return <span className="badge text-bg-secondary">{t('system.flags.off')}</span>;
  return flag.rolloutPercent >= 100 ? (
    <span className="badge text-bg-success">{t('system.flags.onForEveryone')}</span>
  ) : (
    <span className="badge text-bg-info">
      {t('system.flags.onForPercent', { percent: flag.rolloutPercent })}
    </span>
  );
}

function FlagEditor({ flag, onDone }: { flag: FeatureFlag; onDone: (saved: FeatureFlag) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(flag.enabled);
  const [rollout, setRollout] = useState(String(flag.rolloutPercent));
  const [error, setError] = useState<string | null>(null);
  const rolloutValue = /^\d+$/.test(rollout.trim()) ? Number(rollout.trim()) : Number.NaN;
  const rolloutInvalid = !UpdateFlagBody.shape.rolloutPercent.safeParse(rolloutValue).success;

  const save = useMutation({
    mutationFn: (reason: string) =>
      manager.api.put<FeatureFlag>(`/admin/flags/${encodeURIComponent(flag.key)}`, {
        enabled,
        rolloutPercent: rolloutValue,
        reason,
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData<FeatureFlag[]>(systemKeys.flags, (list) =>
        list?.map((f) => (f.key === saved.key ? saved : f)),
      );
      await queryClient.invalidateQueries({ queryKey: systemKeys.flags });
      onDone(saved);
    },
    onError: (err) => setError(consoleError(t, err)),
  });

  return (
    <ReasonForm
      submitLabel={t('system.flags.save')}
      pending={save.isPending}
      disabled={rolloutInvalid}
      error={error}
      onSubmit={(reason) => save.mutate(reason)}
      onCancel={() => onDone(flag)}
    >
      <p className="fw-semibold mb-2">{t('system.flags.editTitle', { key: flag.key })}</p>
      <div className="form-check form-switch mb-2">
        <input
          id={`${id}-enabled`}
          type="checkbox"
          role="switch"
          className="form-check-input"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <label htmlFor={`${id}-enabled`} className="form-check-label">
          {t('system.flags.enabled')}
        </label>
      </div>
      <div className="mb-2" style={{ maxWidth: '14rem' }}>
        <label htmlFor={`${id}-rollout`} className="form-label">
          {t('system.flags.rollout')}
        </label>
        <div className="input-group input-group-sm">
          <input
            id={`${id}-rollout`}
            type="number"
            min={0}
            max={100}
            step={1}
            inputMode="numeric"
            className={`form-control ${rolloutInvalid ? 'is-invalid' : ''}`}
            value={rollout}
            onChange={(e) => setRollout(e.target.value)}
            aria-invalid={rolloutInvalid || undefined}
            aria-describedby={`${id}-rollout-hint`}
          />
          <span className="input-group-text">%</span>
        </div>
        <div
          id={`${id}-rollout-hint`}
          className={rolloutInvalid ? 'invalid-feedback d-block' : 'form-text'}
        >
          {rolloutInvalid ? t('system.flags.rolloutInvalid') : t('system.flags.rolloutHint')}
        </div>
      </div>
    </ReasonForm>
  );
}

export function FlagsPage() {
  const { t, i18n } = useTranslation();
  const canManage = useCan('system.manage');
  const flags = useFlags();
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cols = canManage ? 5 : 4;

  return (
    <>
      <h1 className="h3 mb-2">{t('system.flags.title')}</h1>
      <p className="cb-text-secondary mb-1">{t('system.flags.subtitle')}</p>
      <p className="small cb-text-secondary">{t('system.flags.rolloutExplain')}</p>
      {!canManage && (
        <p className="small cb-text-secondary">
          <i className="bi bi-lock me-1" aria-hidden="true" />
          {t('system.readOnly')}
        </p>
      )}
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {flags.isPending && <LoadingRow />}
      <ErrorAlert error={flags.isError ? consoleError(t, flags.error) : null} />
      {flags.data && (
        <section
          className="border cb-border rounded-3 bg-white"
          aria-label={t('system.flags.listLabel')}
        >
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('system.flags.flag')}</th>
                  <th scope="col">{t('system.flags.state')}</th>
                  <th scope="col">{t('system.flags.visibility')}</th>
                  <th scope="col">{t('system.flags.updated')}</th>
                  {canManage && (
                    <th scope="col">
                      <span className="visually-hidden">{t('system.flags.actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {flags.data.length === 0 && (
                  <tr>
                    <td colSpan={cols} className="cb-text-secondary">
                      {t('system.flags.empty')}
                    </td>
                  </tr>
                )}
                {flags.data.map((flag) => (
                  <Fragment key={flag.key}>
                    <tr>
                      <th scope="row" className="fw-normal">
                        <code>{flag.key}</code>
                        <span className="d-block small cb-text-secondary">{flag.description}</span>
                        {FLAG_NOTES[flag.key] && (
                          <span className="d-block small">{t(FLAG_NOTES[flag.key]!)}</span>
                        )}
                      </th>
                      <td>
                        <FlagState flag={flag} />
                      </td>
                      <td className="small">
                        {flag.clientVisible
                          ? t('system.flags.clientVisible')
                          : t('system.flags.serverOnly')}
                      </td>
                      <td className="small">
                        {formatDateTime(flag.updatedAt, i18n.language)}
                        {flag.updatedBy && (
                          <span className="d-block cb-text-secondary">
                            {t('system.updatedBy', { by: flag.updatedBy })}
                          </span>
                        )}
                      </td>
                      {canManage && (
                        <td className="text-end">
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-primary"
                            disabled={editing !== null}
                            aria-label={t('system.flags.editFlag', { key: flag.key })}
                            onClick={() => {
                              setNotice(null);
                              setEditing(flag.key);
                            }}
                          >
                            {t('system.flags.edit')}
                          </button>
                        </td>
                      )}
                    </tr>
                    {editing === flag.key && (
                      <tr>
                        <td colSpan={cols}>
                          <FlagEditor
                            flag={flag}
                            onDone={(saved) => {
                              setEditing(null);
                              if (saved !== flag) {
                                setNotice(t('system.flags.saved', { key: saved.key }));
                              }
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
