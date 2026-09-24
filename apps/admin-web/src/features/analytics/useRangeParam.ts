import { useSearchParams } from 'react-router';
import { DEFAULT_PRESET, isDay, presetRange, rangeProblem, type DayRange } from './format';

/**
 * The selected range lives in the URL (`?from=&to=`) so a view can be shared
 * and survives a reload. Missing or unusable values fall back to the last 30 days.
 */
export function useRangeParam(): [DayRange, (next: DayRange) => void] {
  const [params, setParams] = useSearchParams();
  const from = params.get('from');
  const to = params.get('to');
  const range =
    isDay(from) && isDay(to) && rangeProblem({ from, to }) === null
      ? { from, to }
      : presetRange(DEFAULT_PRESET);
  const setRange = (next: DayRange) =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.set('from', next.from);
        updated.set('to', next.to);
        return updated;
      },
      { replace: true },
    );
  return [range, setRange];
}
