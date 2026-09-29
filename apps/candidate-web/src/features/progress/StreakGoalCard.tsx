import type { GoalInfo, ProgressOverview, StreakInfo } from '@cbi/shared-types';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDate, inputErrorMessage } from '../interviews/messages';
import { useUpdateGoals } from './progress-api';
import { drillPath } from './progress-format';

/** Goals offered in the editor (the API accepts 1–14 sessions a week). */
const WEEKLY_CHOICES = [1, 2, 3, 4, 5, 6, 7, 10, 14] as const;
/** Schedule entries shown on the dashboard. */
const SCHEDULE_SHOWN = 5;

/** An India-time day (`YYYY-MM-DD`) shown as a date in the UI language. */
const dayLabel = (lng: string | undefined, day: string) => formatDate(lng, `${day}T12:00:00+05:30`);

function StreakSummary({ streak }: { streak: StreakInfo }) {
  const { t } = useTranslation();
  const status = streak.practicedToday
    ? t('progress.streak.doneToday')
    : streak.current > 0
      ? t('progress.streak.keepGoing')
      : t('progress.streak.startToday');
  return (
    <div className="d-flex align-items-center gap-3 mb-3">
      <span className="cb-streak-flame" aria-hidden="true">
        <i className="bi bi-fire" />
      </span>
      <div>
        <p className="fs-4 fw-bold mb-0">
          {t('progress.streak.current', { count: streak.current })}
        </p>
        <p className="small cb-text-secondary mb-0">
          {t('progress.streak.longest', { count: streak.longest })} · {status}
        </p>
      </div>
    </div>
  );
}

/** `today` is the server's India-time day, the earliest target date allowed. */
function GoalEditor({
  goals,
  today,
  onDone,
}: {
  goals: GoalInfo;
  today: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const update = useUpdateGoals();
  const [weekly, setWeekly] = useState(goals.weeklyTarget);
  const [date, setDate] = useState(goals.targetDate ?? '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await update.mutateAsync({ weeklyTarget: weekly, targetDate: date || null });
      onDone();
    } catch {
      // Shown below.
    }
  }

  return (
    <form className="border cb-border rounded-3 p-3 mt-2" onSubmit={(e) => void submit(e)}>
      <div className="mb-2">
        <label htmlFor={`${id}-weekly`} className="form-label small mb-1">
          {t('progress.goal.weeklyLabel')}
        </label>
        <select
          id={`${id}-weekly`}
          className="form-select form-select-sm"
          value={weekly}
          onChange={(e) => setWeekly(Number(e.target.value))}
        >
          {WEEKLY_CHOICES.map((n) => (
            <option key={n} value={n}>
              {t('progress.goal.perWeek', { count: n })}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-2">
        <label htmlFor={`${id}-date`} className="form-label small mb-1">
          {t('progress.goal.dateLabel')}
        </label>
        <input
          id={`${id}-date`}
          type="date"
          className="form-control form-control-sm"
          min={today}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-describedby={`${id}-date-help`}
        />
        <div id={`${id}-date-help`} className="form-text">
          {t('progress.goal.dateHelp')}
        </div>
      </div>
      {update.isError && (
        <div className="alert alert-danger py-2 small" role="alert">
          {inputErrorMessage(t, update.error)}
        </div>
      )}
      <div className="d-flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary btn-sm" disabled={update.isPending}>
          {update.isPending ? t('progress.goal.saving') : t('progress.goal.save')}
        </button>
        <button type="button" className="btn btn-link btn-sm" onClick={onDone}>
          {t('progress.goal.cancel')}
        </button>
      </div>
    </form>
  );
}

function Countdown({ goals }: { goals: GoalInfo }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.resolvedLanguage;
  if (!goals.targetDate || goals.daysToTarget === null) return null;
  const days = goals.daysToTarget;
  return (
    <div className="mt-3">
      <p className="fw-semibold mb-1">
        <i className="bi bi-calendar-event me-2 text-secondary" aria-hidden="true" />
        {days > 0
          ? t('progress.goal.daysLeft', { count: days, date: dayLabel(lng, goals.targetDate) })
          : days === 0
            ? t('progress.goal.today')
            : t('progress.goal.passed', { date: dayLabel(lng, goals.targetDate) })}
      </p>
      {goals.schedule.length > 0 && (
        <>
          <h3 className="h6 small cb-text-secondary mb-1">{t('progress.goal.scheduleTitle')}</h3>
          <ol className="list-unstyled small mb-0">
            {goals.schedule.slice(0, SCHEDULE_SHOWN).map((item) => (
              <li key={`${item.day}-${item.kind}`} className="d-flex flex-wrap gap-2 py-1">
                <span className="fw-semibold" style={{ minWidth: '6.5rem' }}>
                  {dayLabel(lng, item.day)}
                </span>
                {item.kind === 'DRILL' && item.dimensionKey ? (
                  <Link to={drillPath(item.dimensionKey)}>
                    {t('progress.goal.drillOn', { name: item.dimensionName })}
                  </Link>
                ) : (
                  <Link to="/app/new">{t('progress.goal.mockInterview')}</Link>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/** Daily streak (India time), the weekly goal, the target date countdown and a schedule. */
export function StreakGoalCard({ progress }: { progress: ProgressOverview }) {
  const { t } = useTranslation();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const { goals, streak } = progress;
  const percent = Math.min(100, Math.round((goals.weekCompleted / goals.weeklyTarget) * 100));
  return (
    <section className="cb-dash-card h-100" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h5 mb-3 d-flex align-items-center gap-2">
        <i className="bi bi-calendar-check text-secondary" aria-hidden="true" />
        {t('progress.streak.title')}
      </h2>
      <StreakSummary streak={streak} />
      <p className="small mb-1" id={`${id}-week`}>
        {t('progress.goal.week', { done: goals.weekCompleted, target: goals.weeklyTarget })}
      </p>
      <div
        className="progress"
        role="progressbar"
        aria-labelledby={`${id}-week`}
        aria-valuenow={goals.weekCompleted}
        aria-valuemin={0}
        aria-valuemax={goals.weeklyTarget}
        style={{ height: '0.5rem' }}
      >
        <div className="progress-bar bg-secondary" style={{ width: `${percent}%` }} />
      </div>
      <Countdown goals={goals} />
      {editing ? (
        <GoalEditor goals={goals} today={streak.today} onDone={() => setEditing(false)} />
      ) : (
        <button
          type="button"
          className="btn btn-link btn-sm px-0 mt-2"
          onClick={() => setEditing(true)}
        >
          <i className="bi bi-pencil me-1" aria-hidden="true" />
          {goals.targetDate ? t('progress.goal.edit') : t('progress.goal.set')}
        </button>
      )}
      <p className="small cb-text-secondary mb-0 mt-2">{t('progress.streak.note')}</p>
    </section>
  );
}
