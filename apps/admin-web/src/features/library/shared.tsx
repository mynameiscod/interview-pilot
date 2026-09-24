import type { BlueprintContent, BlueprintSummary, LibraryStatus } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import type { BlueprintDiff, FieldChange } from './blueprint-diff';
import { formatDateTime, type Issue } from './format';

const STATUS_BADGE: Record<LibraryStatus, string> = {
  ACTIVE: 'text-bg-success',
  DRAFT: 'text-bg-info',
  RETIRED: 'text-bg-secondary',
};

export function StatusBadge({ status }: { status: LibraryStatus }) {
  const { t } = useTranslation();
  return <span className={`badge ${STATUS_BADGE[status]}`}>{t(`library.status.${status}`)}</span>;
}

export function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${active ? 'text-bg-success' : 'text-bg-secondary'}`}>
      {active ? t('library.active') : t('library.inactive')}
    </span>
  );
}

/** Canonical roles and the AI-generated review queue share the Roles section. */
export function RolesTabs() {
  const { t } = useTranslation();
  const tabs = [
    { to: '/roles', key: 'library.roles.tab' },
    { to: '/blueprints', key: 'library.aiBlueprints.tab' },
  ];
  return (
    <nav aria-label={t('library.roles.tabsLabel')} className="mb-3">
      <ul className="nav nav-tabs">
        {tabs.map((tab) => (
          <li className="nav-item" key={tab.to}>
            <NavLink
              to={tab.to}
              end
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              {t(tab.key)}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Validation issues from the client check or the server, tied to the field by id. */
export function IssueList({ id, issues }: { id?: string; issues: Issue[] }) {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  return (
    <div id={id} className="alert alert-danger py-2" role="alert">
      <div className="fw-semibold small">{t('library.issuesTitle')}</div>
      <ul className="small mb-0">
        {issues.map((issue, i) => (
          <li key={i}>
            {issue.path && <code className="me-1">{issue.path}</code>}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BlueprintMeta({ blueprint }: { blueprint: BlueprintSummary }) {
  const { t, i18n } = useTranslation();
  return (
    <p className="small cb-text-secondary mb-2">
      {t(`library.origin.${blueprint.origin}`)}
      {blueprint.generatedBy && (
        <>
          {' · '}
          {t('library.blueprints.generatedBy', {
            model: blueprint.generatedBy.model,
            prompt:
              blueprint.generatedBy.promptVersion === null
                ? '—'
                : t('library.version', { n: blueprint.generatedBy.promptVersion }),
          })}
        </>
      )}
      {' · '}
      {t('library.blueprints.createdAt', {
        date: formatDateTime(blueprint.createdAt, i18n.language),
      })}
      {' · '}
      {t('library.hash', { hash: blueprint.contentHash.slice(0, 12) })}
    </p>
  );
}

/** A readable rendering of blueprint content for review. */
export function BlueprintViewer({ content, label }: { content: BlueprintContent; label: string }) {
  const { t } = useTranslation();
  const totalWeight = content.competencies.reduce((sum, c) => sum + c.weight, 0);
  return (
    <article aria-label={label}>
      <h3 className="h6 mb-1">{content.role.title}</h3>
      <p className="small cb-text-secondary mb-1">
        {t(`library.families.${content.role.family}`)} ·{' '}
        {t(`library.seniority.${content.role.seniority}`)}
      </p>
      {content.role.summary && <p className="small">{content.role.summary}</p>}

      <div className="table-responsive">
        <table className="table table-sm align-top small">
          <caption className="caption-top">
            {t('library.blueprints.competenciesCaption', { total: totalWeight })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('library.blueprints.competency')}</th>
              <th scope="col">{t('library.blueprints.category')}</th>
              <th scope="col" className="text-end">
                {t('library.blueprints.weight')}
              </th>
              <th scope="col">{t('library.blueprints.difficulty')}</th>
              <th scope="col">{t('library.blueprints.evidence')}</th>
              <th scope="col">{t('library.blueprints.rounds')}</th>
            </tr>
          </thead>
          <tbody>
            {content.competencies.map((c) => (
              <tr key={c.key}>
                <th scope="row" className="fw-normal">
                  <div className="fw-semibold">{c.name}</div>
                  <code className="small">{c.key}</code>
                  {c.description && <div className="cb-text-secondary">{c.description}</div>}
                  {c.subCompetencies.length > 0 && (
                    <div className="cb-text-secondary">
                      {t('library.blueprints.subCompetencies', {
                        list: c.subCompetencies.join(', '),
                      })}
                    </div>
                  )}
                </th>
                <td>{t(`library.categories.${c.category}`)}</td>
                <td className="text-end">{c.weight}</td>
                <td>{t(`library.difficulty.${c.difficulty}`)}</td>
                <td>
                  <ul className="ps-3 mb-0">
                    {c.expectedEvidence.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </td>
                <td>{c.roundTypes.map((r) => t(`library.roundTypes.${r}`)).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row g-3 small">
        <div className="col-md-6">
          <h4 className="h6">{t('library.blueprints.focusSkills')}</h4>
          {content.focusSkills.length === 0 ? (
            <p className="cb-text-secondary">{t('library.none')}</p>
          ) : (
            <ul className="ps-3">
              {content.focusSkills.map((s) => (
                <li key={s.name}>
                  {t('library.blueprints.focusSkill', {
                    name: s.name,
                    weight: s.weight,
                    source: t(`library.sources.${s.source}`),
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="col-md-6">
          <h4 className="h6">{t('library.blueprints.probeAreas')}</h4>
          {content.probeAreas.length === 0 ? (
            <p className="cb-text-secondary">{t('library.none')}</p>
          ) : (
            <ul className="ps-3">
              {content.probeAreas.map((p) => (
                <li key={p.topic}>
                  <span className="fw-semibold">{p.topic}</span> — {p.reason}{' '}
                  <span className="cb-text-secondary">({t(`library.sources.${p.source}`)})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {content.notes && (
        <p className="small mb-0">
          <span className="fw-semibold">{t('library.blueprints.notes')}:</span> {content.notes}
        </p>
      )}
    </article>
  );
}

function Change({ change }: { change: FieldChange }) {
  const { t } = useTranslation();
  const delta =
    typeof change.from === 'number' && typeof change.to === 'number'
      ? change.to - change.from
      : null;
  return (
    <li>
      <span className="fw-semibold">{t(`library.diff.fields.${change.field}`)}:</span>{' '}
      <del className="text-danger">{change.from === '' ? '—' : change.from}</del>{' '}
      <span aria-hidden="true">→</span>
      <span className="visually-hidden">{t('library.diff.to')}</span>{' '}
      <ins className="text-success">{change.to === '' ? '—' : change.to}</ins>
      {delta !== null && delta !== 0 && (
        <span className="cb-text-secondary ms-1">({delta > 0 ? `+${delta}` : delta})</span>
      )}
    </li>
  );
}

/** Structured differences between a version and the active one. */
export function BlueprintDiffView({
  diff,
  label,
  baseVersion,
}: {
  diff: BlueprintDiff;
  label: string;
  baseVersion: number;
}) {
  const { t } = useTranslation();
  if (diff.identical) {
    return (
      <p className="small mb-0" aria-label={label}>
        {t('library.diff.identical', { n: baseVersion })}
      </p>
    );
  }
  const { competencies, focusSkills, probeAreas } = diff;
  return (
    <section aria-label={label} className="small">
      <p className="cb-text-secondary">{t('library.diff.explain', { n: baseVersion })}</p>
      {diff.role.length > 0 && (
        <>
          <h4 className="h6">{t('library.diff.role')}</h4>
          <ul className="ps-3">
            {diff.role.map((c) => (
              <Change key={c.field} change={c} />
            ))}
          </ul>
        </>
      )}
      {(competencies.added.length > 0 ||
        competencies.removed.length > 0 ||
        competencies.changed.length > 0) && (
        <>
          <h4 className="h6">{t('library.diff.competencies')}</h4>
          <ul className="list-unstyled">
            {competencies.added.map((c) => (
              <li key={`a-${c.key}`} className="mb-1">
                <span className="badge text-bg-success me-2">{t('library.diff.added')}</span>
                {t('library.diff.competencyLine', { name: c.name, weight: c.weight })}
              </li>
            ))}
            {competencies.removed.map((c) => (
              <li key={`r-${c.key}`} className="mb-1">
                <span className="badge text-bg-danger me-2">{t('library.diff.removed')}</span>
                {t('library.diff.competencyLine', { name: c.name, weight: c.weight })}
              </li>
            ))}
            {competencies.changed.map((c) => (
              <li key={`c-${c.key}`} className="mb-2">
                <span className="badge text-bg-warning me-2">{t('library.diff.changed')}</span>
                <span className="fw-semibold">{c.item.name}</span>
                <ul className="ps-4">
                  {c.changes.map((change) => (
                    <Change key={change.field} change={change} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
      {(focusSkills.added.length > 0 ||
        focusSkills.removed.length > 0 ||
        focusSkills.changed.length > 0) && (
        <>
          <h4 className="h6">{t('library.blueprints.focusSkills')}</h4>
          <ul className="list-unstyled">
            {focusSkills.added.map((s) => (
              <li key={`a-${s.name}`}>
                <span className="badge text-bg-success me-2">{t('library.diff.added')}</span>
                {s.name}
              </li>
            ))}
            {focusSkills.removed.map((s) => (
              <li key={`r-${s.name}`}>
                <span className="badge text-bg-danger me-2">{t('library.diff.removed')}</span>
                {s.name}
              </li>
            ))}
            {focusSkills.changed.map((s) => (
              <li key={`c-${s.key}`}>
                <span className="badge text-bg-warning me-2">{t('library.diff.changed')}</span>
                {s.item.name}
                <ul className="ps-4">
                  {s.changes.map((change) => (
                    <Change key={change.field} change={change} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
      {(probeAreas.added.length > 0 ||
        probeAreas.removed.length > 0 ||
        probeAreas.changed.length > 0) && (
        <>
          <h4 className="h6">{t('library.blueprints.probeAreas')}</h4>
          <ul className="list-unstyled">
            {probeAreas.added.map((p) => (
              <li key={`a-${p.topic}`}>
                <span className="badge text-bg-success me-2">{t('library.diff.added')}</span>
                {p.topic}
              </li>
            ))}
            {probeAreas.removed.map((p) => (
              <li key={`r-${p.topic}`}>
                <span className="badge text-bg-danger me-2">{t('library.diff.removed')}</span>
                {p.topic}
              </li>
            ))}
            {probeAreas.changed.map((p) => (
              <li key={`c-${p.key}`}>
                <span className="badge text-bg-warning me-2">{t('library.diff.changed')}</span>
                {p.item.topic}
              </li>
            ))}
          </ul>
        </>
      )}
      {diff.notes && (
        <ul className="ps-3 mb-0">
          <Change change={diff.notes} />
        </ul>
      )}
    </section>
  );
}
