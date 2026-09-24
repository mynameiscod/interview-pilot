/**
 * Whether an interview was used enough to consume its credit (design §6.1):
 * at least `minBudgetFraction` of the time budget, or at least `minAnswers`
 * answered questions. An interview with no answers is never meaningful.
 */
export interface UsagePolicy {
  minBudgetFraction: number;
  minAnswers: number;
}

export const DEFAULT_USAGE_POLICY: UsagePolicy = { minBudgetFraction: 0.4, minAnswers: 3 };

export interface UsageFacts {
  answeredCount: number;
  activeMs: number;
  budgetMs: number;
}

export function isMeaningfulUsage(facts: UsageFacts, policy: UsagePolicy = DEFAULT_USAGE_POLICY) {
  if (facts.answeredCount === 0) return false;
  if (facts.answeredCount >= policy.minAnswers) return true;
  return facts.budgetMs > 0 && facts.activeMs >= policy.minBudgetFraction * facts.budgetMs;
}
