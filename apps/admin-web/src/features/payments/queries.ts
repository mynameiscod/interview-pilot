import type { AdminPurchase, CouponSummary, PlanSummary } from '@cbi/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useAdminAuth } from '../../app/session';

export const paymentsKeys = {
  plans: ['payments', 'plans'] as const,
  coupons: ['payments', 'coupons'] as const,
  purchases: ['payments', 'purchases'] as const,
  purchase: (id: string) => ['payments', 'purchase', id] as const,
};

export function usePlans() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: paymentsKeys.plans,
    queryFn: () => manager.api.get<PlanSummary[]>('/admin/plans'),
  });
}

export function useCoupons() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: paymentsKeys.coupons,
    queryFn: () => manager.api.get<CouponSummary[]>('/admin/coupons'),
  });
}

export function usePurchases(filters: { status: string; q: string }) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: [...paymentsKeys.purchases, filters],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (filters.status) params.set('status', filters.status);
      if (filters.q) params.set('q', filters.q);
      return manager.api.get<AdminPurchase[]>(`/admin/purchases?${params.toString()}`);
    },
  });
}

export function usePurchase(id: string) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: paymentsKeys.purchase(id),
    queryFn: () => manager.api.get<AdminPurchase>(`/admin/purchases/${encodeURIComponent(id)}`),
  });
}
