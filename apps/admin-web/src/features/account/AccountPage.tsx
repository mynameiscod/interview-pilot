import type { AdminMeResponse } from '@cbi/shared-types';
import { errorMessage } from '@cbi/web-core';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';

const MIN_LENGTH = 12;

/** The signed-in admin's own account: password sign-in. */
export function AccountPage() {
  const { t } = useTranslation();
  const { user, manager, setUser } = useAdminAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  if (!user) return null;
  const hasPassword = user.hasPassword === true;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (next.length < MIN_LENGTH) return setError(t('account.tooShort'));
    if (next !== confirm) return setError(t('account.mismatch'));
    setError(null);
    setPending(true);
    try {
      await manager.api.post('/admin/auth/password', {
        ...(hasPassword ? { currentPassword: current } : {}),
        newPassword: next,
      });
      setUser({ ...(user as AdminMeResponse), hasPassword: true });
      setCurrent('');
      setNext('');
      setConfirm('');
      setSaved(true);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <h1 className="h3">{t('account.title')}</h1>
      <section
        className="p-4 border cb-border rounded-3 bg-white mt-3"
        style={{ maxWidth: '32rem' }}
        aria-labelledby="password-title"
      >
        <h2 id="password-title" className="h5">
          {t('account.passwordTitle')}
        </h2>
        <p className="cb-text-secondary">
          {hasPassword ? t('account.passwordSet') : t('account.passwordNotSet')}
        </p>
        <form onSubmit={(e) => void submit(e)} noValidate>
          {hasPassword && (
            <div className="mb-3">
              <label htmlFor="current-password" className="form-label">
                {t('account.current')}
              </label>
              <input
                id="current-password"
                type="password"
                className="form-control"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>
          )}
          <div className="mb-3">
            <label htmlFor="new-password" className="form-label">
              {t('account.new')}
            </label>
            <input
              id="new-password"
              type="password"
              className="form-control"
              autoComplete="new-password"
              aria-describedby="new-password-hint"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <div id="new-password-hint" className="form-text">
              {t('account.hint')}
            </div>
          </div>
          <div className="mb-3">
            <label htmlFor="confirm-password" className="form-label">
              {t('account.confirm')}
            </label>
            <input
              id="confirm-password"
              type="password"
              className="form-control"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {error && (
            <div className="alert alert-danger" role="alert">
              {error}
            </div>
          )}
          {saved && (
            <div className="alert alert-success" role="status">
              {t('account.saved')}
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? t('account.saving') : t('account.save')}
          </button>
        </form>
      </section>
    </div>
  );
}
