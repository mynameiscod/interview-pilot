import type { MaintenanceSetting } from '@cbi/shared-types';
import { AppError } from './errors.js';

const FALLBACK_MESSAGE = 'We are doing maintenance. Please try again a little later.';

/** The 503 sent while maintenance mode is on (the admin's notice, or a default). */
export function maintenanceError(m: MaintenanceSetting) {
  return new AppError(503, 'MAINTENANCE', m.message || FALLBACK_MESSAGE, {
    maintenance: { enabled: true, message: m.message },
  });
}

/** Maintenance mode: new interviews cannot start or be joined (running ones continue). */
export async function refuseDuringMaintenance(
  maintenance: (() => Promise<MaintenanceSetting>) | undefined,
) {
  const m = maintenance ? await maintenance() : null;
  if (m?.enabled) throw maintenanceError(m);
}
