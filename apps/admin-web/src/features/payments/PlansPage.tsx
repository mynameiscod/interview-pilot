import type { PlanContent, PlanSummary } from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { ActiveBadge } from '../library/shared';
import { formatMoney, paymentsError } from './format';
import { PlanEditor } from './PlanEditor';
import { paymentsKeys, usePlans } from './queries';

type Editing = { code: string | null; initial: PlanContent | null } | null;
type Panel = { id: string; mode: 'view' | 'activate' | 'deactivate' } | null;

function PlanPrice({ plan }: { plan: PlanContent }) {
  const { t } = useTranslation();
  return (
    <>{plan.priceMinor === 0 ? t('payments.free') : formatMoney(plan.priceMinor, plan.currency)}</>
  );
}

function PlanViewer({ plan }: { plan: PlanSummary }) {
  const { t } = useTranslation();
  return (
    <article
      className="small"
      aria-label={t('payments.plans.viewerLabel', { code: plan.code, version: plan.version })}
    >
      {plan.description && <p>{plan.description}</p>}
      <dl className="row mb-0">
        <dt className="col-sm-3">{t('payments.plans.features')}</dt>
        <dd className="col-sm-9">
          {plan.features.length === 0 ? (
            t('library.none')
          ) : (
            <ul className="ps-3 mb-0">
              {plan.features.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="col-sm-3">{t('payments.plans.displayOrder')}</dt>
        <dd className="col-sm-9">{plan.displayOrder}</dd>
        <dt className="col-sm-3">{t('payments.plans.featured')}</dt>
        <dd className="col-sm-9">{plan.featured ? t('library.yes') : t('library.no')}</dd>
      </dl>
    </article>
  );
}

function PlanRow({
  plan,
  panel,
  setPanel,
  canManage,
  editing,
  onEdit,
  onChanged,
}: {
  plan: PlanSummary;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  canManage: boolean;
  editing: boolean;
  onEdit: () => void;
  onChanged: (plan: PlanSummary, active: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mode = panel?.id === plan.id ? panel.mode : null;
  const label = `${plan.code} v${plan.version}`;
  const toggle = useMutation({
    mutationFn: ({ active, reason }: { active: boolean; reason: string }) =>
      manager.api.post<PlanSummary>(
        `/admin/plans/${plan.id}/${active ? 'activate' : 'deactivate'}`,
        { reason },
      ),
    onSuccess: async (_saved, { active }) => {
      setError(null);
      setPanel(null);
      await queryClient.invalidateQueries({ queryKey: paymentsKeys.plans });
      onChanged(plan, active);
    },
    onError: (err) => setError(paymentsError(t, err)),
  });

  return (
    <>
      <tr className={plan.active ? 'table-success' : undefined}>
        <th scope="row">{t('library.version', { n: plan.version })}</th>
        <td>{plan.name}</td>
        <td className="text-end">
          <PlanPrice plan={plan} />
        </td>
        <td className="text-end">{plan.credits}</td>
        <td>
          {plan.validityDays === null
            ? t('payments.plans.noExpiry')
            : t('payments.plans.days', { count: plan.validityDays })}
        </td>
        <td>
          <ActiveBadge active={plan.active} />
          {plan.featured && (
            <span className="badge text-bg-primary ms-1">{t('payments.plans.featured')}</span>
          )}
        </td>
        <td className="small">{formatDateTime(plan.createdAt, i18n.language)}</td>
        <td className="text-end text-nowrap">
          <div className="d-flex flex-wrap gap-2 justify-content-end">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              aria-expanded={mode === 'view'}
              aria-label={t('payments.plans.viewLabel', { label })}
              onClick={() => setPanel(mode === 'view' ? null : { id: plan.id, mode: 'view' })}
            >
              {mode === 'view' ? t('library.hide') : t('library.view')}
            </button>
            {canManage && !editing && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  aria-label={t('payments.plans.editLabel', { label })}
                  onClick={onEdit}
                >
                  {t('library.edit')}
                </button>
                {!plan.active && mode !== 'activate' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    aria-label={t('payments.plans.activateLabel', { label })}
                    onClick={() => {
                      setError(null);
                      setPanel({ id: plan.id, mode: 'activate' });
                    }}
                  >
                    {t('library.activate')}
                  </button>
                )}
                {plan.active && mode !== 'deactivate' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    aria-label={t('payments.plans.deactivateLabel', { label })}
                    onClick={() => {
                      setError(null);
                      setPanel({ id: plan.id, mode: 'deactivate' });
                    }}
                  >
                    {t('payments.plans.deactivate')}
                  </button>
                )}
              </>
            )}
          </div>
        </td>
      </tr>
      {mode && (
        <tr>
          <td colSpan={8}>
            {mode === 'view' && <PlanViewer plan={plan} />}
            {(mode === 'activate' || mode === 'deactivate') && (
              <ReasonForm
                submitLabel={
                  mode === 'activate'
                    ? t('payments.plans.confirmActivate', { label })
                    : t('payments.plans.confirmDeactivate', { label })
                }
                danger={mode === 'deactivate'}
                pending={toggle.isPending}
                error={error}
                onSubmit={(reason) => toggle.mutate({ active: mode === 'activate', reason })}
                onCancel={() => {
                  setPanel(null);
                  setError(null);
                }}
              >
                <p>
                  {mode === 'activate'
                    ? t('payments.plans.activateExplain', {
                        code: plan.code,
                        version: plan.version,
                      })
                    : t('payments.plans.deactivateExplain', { code: plan.code })}
                </p>
              </ReasonForm>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function PlansPage() {
  const { t } = useTranslation();
  const canManage = useCan('payments.manage');
  const plans = usePlans();
  const [editing, setEditing] = useState<Editing>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The API already orders by displayOrder, code, then newest version first.
  const groups = new Map<string, PlanSummary[]>();
  for (const plan of plans.data ?? []) {
    groups.set(plan.code, [...(groups.get(plan.code) ?? []), plan]);
  }

  const startEditing = (next: Editing) => {
    setNotice(null);
    setPanel(null);
    setEditing(next);
  };

  return (
    <>
      <h1 className="h3 mb-2">{t('payments.plans.title')}</h1>
      <p className="cb-text-secondary">{t('payments.plans.subtitle')}</p>
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {canManage && editing === null && (
        <button
          type="button"
          className="btn btn-sm btn-primary mb-3"
          onClick={() => startEditing({ code: null, initial: null })}
        >
          {t('payments.plans.new')}
        </button>
      )}
      {editing && (
        <PlanEditor
          code={editing.code}
          initial={editing.initial}
          onDone={(created) => {
            setEditing(null);
            if (created) {
              setNotice(
                t('payments.plans.created', { code: created.code, version: created.version }),
              );
            }
          }}
        />
      )}
      {plans.isPending && <LoadingRow />}
      {plans.isError && <ErrorAlert error={paymentsError(t, plans.error)} />}
      {plans.data && plans.data.length === 0 && (
        <p className="cb-text-secondary">{t('payments.plans.empty')}</p>
      )}
      {[...groups.entries()].map(([code, versions]) => {
        const active = versions.find((v) => v.active);
        const headingId = `plan-${code}`;
        return (
          <section
            key={code}
            className="border cb-border rounded-3 bg-white mb-3"
            aria-labelledby={headingId}
          >
            <div className="p-3 pb-2">
              <h2 id={headingId} className="h6 mb-0">
                <code>{code}</code>
              </h2>
              <div className="small cb-text-secondary">
                {active
                  ? t('payments.plans.onSale', {
                      name: active.name,
                      version: active.version,
                      price:
                        active.priceMinor === 0
                          ? t('payments.free')
                          : formatMoney(active.priceMinor, active.currency),
                      credits: active.credits,
                    })
                  : t('payments.plans.notOnSale')}
              </div>
            </div>
            <div className="table-responsive">
              <table className="table align-middle mb-0">
                <caption className="visually-hidden">
                  {t('payments.plans.historyCaption', { code })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t('library.versionHeader')}</th>
                    <th scope="col">{t('payments.plans.name')}</th>
                    <th scope="col" className="text-end">
                      {t('payments.plans.price')}
                    </th>
                    <th scope="col" className="text-end">
                      {t('payments.plans.credits')}
                    </th>
                    <th scope="col">{t('payments.plans.validity')}</th>
                    <th scope="col">{t('ai.status')}</th>
                    <th scope="col">{t('library.created')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('ai.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((plan) => (
                    <PlanRow
                      key={plan.id}
                      plan={plan}
                      panel={panel}
                      setPanel={setPanel}
                      canManage={canManage}
                      editing={editing !== null}
                      onEdit={() => {
                        const { name, description, priceMinor, currency, credits } = plan;
                        const { validityDays, features, displayOrder, featured } = plan;
                        startEditing({
                          code,
                          initial: {
                            name,
                            description,
                            priceMinor,
                            currency,
                            credits,
                            validityDays,
                            features,
                            displayOrder,
                            featured,
                          },
                        });
                      }}
                      onChanged={(changed, nowActive) =>
                        setNotice(
                          t(nowActive ? 'payments.plans.activated' : 'payments.plans.deactivated', {
                            code: changed.code,
                            version: changed.version,
                          }),
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}
