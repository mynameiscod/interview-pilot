import type { MaintenanceSetting } from '@cbi/shared-types';
import { AppError } from './errors.js';

/** Maintenance mode: new interviews cannot start or be joined (running ones continue). */
export async function refuseDuringMaintenance(
  maintenance: (() => Promise<MaintenanceSetting>) | undefined,
) {
  const m = maintenance ? await maintenance() : null;
  if (m?.enabled) {
    throw new AppError(
      503,
      'MAINTENANCE',
      m.message || 'We are doing maintenance. Please try again a little later.',
    );
  }
}
