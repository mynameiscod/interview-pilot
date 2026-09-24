import { CompanyModel, RoleModel } from '@cbi/db';
import { LibrarySearchQuery, type LibrarySearchItem } from '@cbi/shared-types';
import { Router } from 'express';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive "contains" on the given fields; an empty query lists alphabetically. */
function searchFilter(q: string, fields: string[]) {
  if (!q) return { active: true };
  const pattern = new RegExp(escapeRegex(q), 'i');
  return { active: true, $or: fields.map((f) => ({ [f]: pattern })) };
}

/**
 * `/companies` and `/roles`: public reads of active library entries for the
 * interview wizard. Only names are exposed, never internal notes.
 */
export function librarySearchRouter(): Router {
  const router = Router();

  router.get('/companies', async (req, res) => {
    const { q, limit } = LibrarySearchQuery.parse(req.query);
    const rows = await CompanyModel.find(searchFilter(q, ['name']), { name: 1, slug: 1 })
      .sort({ name: 1 })
      .limit(limit)
      .lean();
    const data: LibrarySearchItem[] = rows.map((r) => ({
      id: String(r._id),
      name: r.name,
      slug: r.slug,
    }));
    res.set('Cache-Control', 'public, max-age=60').json({ data });
  });

  router.get('/roles', async (req, res) => {
    const { q, limit } = LibrarySearchQuery.parse(req.query);
    const rows = await RoleModel.find(searchFilter(q, ['title', 'aliases']), {
      title: 1,
      slug: 1,
    })
      .sort({ title: 1 })
      .limit(limit)
      .lean();
    const data: LibrarySearchItem[] = rows.map((r) => ({
      id: String(r._id),
      name: r.title,
      slug: r.slug,
    }));
    res.set('Cache-Control', 'public, max-age=60').json({ data });
  });

  return router;
}
