import { CreditLedgerModel, getCreditBalance } from '@cbi/db';
import { CreditLedgerQuery, type CreditLedgerEntry } from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';

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
      .lean();
    const data: CreditLedgerEntry[] = rows.map((r) => ({
      id: String(r._id),
      type: r.type,
      amount: r.amount,
      refType: r.refType,
      refId: r.refId,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    }));
    res.json({ data });
  });

  return router;
}
