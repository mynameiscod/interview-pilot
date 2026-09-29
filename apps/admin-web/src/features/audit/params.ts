/** The filters as typed in the form; dates are `YYYY-MM-DD` in the admin's time zone. */
export interface AuditFilters {
  action: string;
  actorId: string;
  resourceId: string;
  fromDay: string;
  toDay: string;
}

export const NO_FILTERS: AuditFilters = {
  action: '',
  actorId: '',
  resourceId: '',
  fromDay: '',
  toDay: '',
};

/** Local midnight at the start of a `YYYY-MM-DD` day, as an ISO instant. */
const dayStart = (day: string) => new Date(`${day}T00:00:00`).toISOString();
/** Local midnight after a day, so the "to" day is included. */
function dayAfter(day: string) {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** Query parameters shared by the list and the CSV export. */
export function auditParams(f: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (f.action.trim()) params.set('action', f.action.trim());
  if (f.actorId.trim()) params.set('actorId', f.actorId.trim());
  if (f.resourceId.trim()) params.set('resourceId', f.resourceId.trim());
  if (f.fromDay) params.set('from', dayStart(f.fromDay));
  if (f.toDay) params.set('to', dayAfter(f.toDay));
  return params;
}
