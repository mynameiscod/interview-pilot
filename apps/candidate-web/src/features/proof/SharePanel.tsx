import type { ShareLinkSummary } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFlag } from '../../app/system-api';
import { track } from '../../lib/analytics';
import { formatDate, inputErrorMessage } from '../interviews/messages';
import {
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_CHOICES,
  shareState,
  useCreateShare,
  useRevokeShare,
  useShareLinks,
} from './proof-api';

const STATE_BADGE = {
  active: 'text-bg-success',
  expired: 'text-bg-light border cb-border',
  revoked: 'text-bg-light border cb-border',
} as const;

function shareError(t: ReturnType<typeof useTranslation>['t'], err: unknown) {
  if (err instanceof ApiClientError && err.status === 409) return t('proof.share.errors.limit');
  return inputErrorMessage(t, err);
}

/** The link just created: its full address is shown only now, so it can be copied. */
function CreatedLink({ url }: { url: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div className="alert alert-success" role="status">
      <p className="fw-semibold mb-1">{t('proof.share.created')}</p>
      <p className="small mb-2">{t('proof.share.copyNow')}</p>
      <label htmlFor={id} className="visually-hidden">
        {t('proof.share.linkLabel')}
      </label>
      <div className="input-group">
        <input
          id={id}
          type="text"
          className="form-control"
          value={url}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          <i className="bi bi-clipboard me-2" aria-hidden="true" />
          {t('proof.share.copy')}
        </button>
      </div>
      {copied && (
        <p className="small mb-0 mt-2" aria-live="polite">
          {copied === 'yes' ? t('proof.share.copied') : t('proof.share.copyFailed')}
        </p>
      )}
    </div>
  );
}

function LinkRow({
  link,
  onRevoke,
  revoking,
}: {
  link: ShareLinkSummary;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lng = i18n.resolvedLanguage;
  const state = shareState(link);
  const name = t('proof.share.linkName', { hint: link.tokenHint });
  return (
    <li className="border cb-border rounded-3 p-3">
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2">
        <div>
          <p className="fw-semibold mb-1">
            {name}{' '}
            <span className={`badge ${STATE_BADGE[state]} fw-normal`}>
              {t(`proof.share.states.${state}`)}
            </span>
          </p>
          <p className="small cb-text-secondary mb-0">
            {t('proof.share.createdOn', { date: formatDate(lng, link.createdAt) })} ·{' '}
            {state === 'revoked' && link.revokedAt
              ? t('proof.share.revokedOn', { date: formatDate(lng, link.revokedAt) })
              : t(state === 'expired' ? 'proof.share.expiredOn' : 'proof.share.expiresOn', {
                  date: formatDate(lng, link.expiresAt),
                })}{' '}
            · {t('proof.share.views', { count: link.views })}
            {link.lastViewedAt &&
              ` · ${t('proof.share.lastViewed', { date: formatDate(lng, link.lastViewedAt) })}`}
          </p>
        </div>
        {state === 'active' && (
          <button
            type="button"
            className="btn btn-outline-danger btn-sm"
            disabled={revoking}
            onClick={onRevoke}
            aria-label={t('proof.share.revokeNamed', { name })}
          >
            {t('proof.share.revoke')}
          </button>
        )}
      </div>
    </li>
  );
}

function SharePanelBody({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const id = useId();
  const links = useShareLinks(sessionId, true);
  const create = useCreateShare(sessionId);
  const revoke = useRevokeShare(sessionId);
  const [days, setDays] = useState<number>(DEFAULT_EXPIRY_DAYS);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createLink() {
    setError(null);
    setCreatedUrl(null);
    try {
      const created = await create.mutateAsync(days);
      setCreatedUrl(`${window.location.origin}${created.path}`);
      track('proof_shared', { expiresInDays: days });
    } catch (err) {
      setError(shareError(t, err));
    }
  }

  async function revokeLink(linkId: string) {
    setError(null);
    try {
      await revoke.mutateAsync(linkId);
    } catch (err) {
      setError(shareError(t, err));
    }
  }

  const list = links.data ?? [];

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h5">
        <i className="bi bi-share me-2 text-secondary" aria-hidden="true" />
        {t('proof.share.title')}
      </h2>
      <p>{t('proof.share.intro')}</p>
      <ul className="small mb-3">
        <li>{t('proof.share.shows')}</li>
        <li>{t('proof.share.neverShows')}</li>
        <li>{t('proof.share.anyone')}</li>
      </ul>

      {error && (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      )}
      {createdUrl && <CreatedLink url={createdUrl} />}

      <div className="d-flex flex-wrap align-items-end gap-2 mb-4">
        <div>
          <label htmlFor={`${id}-days`} className="form-label small mb-1">
            {t('proof.share.expiryLabel')}
          </label>
          <select
            id={`${id}-days`}
            className="form-select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {EXPIRY_CHOICES.map((d) => (
              <option key={d} value={d}>
                {t('proof.share.days', { count: d })}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={create.isPending}
          onClick={() => void createLink()}
        >
          {create.isPending ? t('proof.share.creating') : t('proof.share.create')}
        </button>
      </div>

      <h3 className="h6">{t('proof.share.listTitle')}</h3>
      {links.isPending && <p className="small cb-text-secondary">{t('common.loading')}</p>}
      {links.isError && (
        <p className="small text-danger" role="alert">
          {t('proof.share.listError')}
        </p>
      )}
      {links.isSuccess && list.length === 0 && (
        <p className="small cb-text-secondary mb-0">{t('proof.share.none')}</p>
      )}
      {list.length > 0 && (
        <ul className="list-unstyled d-flex flex-column gap-2 mb-0">
          {list.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              revoking={revoke.isPending && revoke.variables === link.id}
              onRevoke={() => void revokeLink(link.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Candidate Proof (behind the `reports.publicProof` flag): share a read-only
 * summary of this report by link. Renders nothing, and calls nothing, while
 * the flag is off.
 */
export function SharePanel({ sessionId }: { sessionId: string }) {
  const enabled = useFlag('reports.publicProof');
  if (!enabled) return null;
  return <SharePanelBody sessionId={sessionId} />;
}
