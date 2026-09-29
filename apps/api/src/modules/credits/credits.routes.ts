import { CreditLedgerModel, getCreditBalance, type CreditLedgerRecord } from '@cbi/db';
import { AdminCreditLookupQuery, CreditAdjustmentBody, CreditLedgerQuery } from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requirePermission } from '../../middleware/authenticate.js';
import { ledgerEntry } from './credits-admin.service.js';

/** `/credits`: the signed-in candidate's balance and ledger. */
export function creditsRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/balance', async (req, res) => {
    res.json({ data: await getCreditBalance(requireAuth(req).userId) });
  });

  router.get('/ledger', async (req, res) => {
    const { limit } = CreditLedgerQuery.parse(req.query);
    const rows = await CreditLedgerModel.find({ userId: requireAuth(req).userId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean<CreditLedgerRecord[]>();
    res.json({ data: rows.map(ledgerEntry) });
  });

  return router;
}

/** Admin credit accounts and manual adjustments (mounted inside the admin router). */
export function creditsAdminRouter(c: Container): Router {
  const router = Router();

  router.get('/credits/account', requirePermission('payments.read'), async (req, res) => {
    const { user } = AdminCreditLookupQuery.parse(req.query);
    res.set('Cache-Control', 'no-store').json({ data: await c.creditsAdmin.lookup(user) });
  });

  router.post('/credits/adjustments', requirePermission('credits.adjust'), async (req, res) => {
    const body = CreditAdjustmentBody.parse(req.body);
    res.json({
      data: await c.creditsAdmin.adjust(body, requireAuth(req).userId, clientContext(req)),
    });
  });

  return router;
}
