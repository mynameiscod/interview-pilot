import type { Model, Types } from 'mongoose';

/** The fields every append-only, versioned bank document has (problems, design prompts). */
export interface VersionedDoc {
  _id: Types.ObjectId;
  key: string;
  version: number;
  active: boolean;
  content: unknown;
  createdBy: Types.ObjectId | null;
  reason: string | null;
  seedRevision?: number | null;
}

/** Seeded before revisions were recorded: created by nobody, revision 1. */
const seededRevision = (v: Pick<VersionedDoc, 'seedRevision' | 'createdBy'>) =>
  v.createdBy ? null : (v.seedRevision ?? 1);

/**
 * Idempotent, versioned seed of an append-only bank. A key with no versions
 * gets its seed as version 1 (active). A key whose versions all came from an
 * older seed revision gets the new revision as the next version, which takes
 * over as the active one if the key had an active version. A key with any
 * admin-created version is left alone. Returns the versions created.
 */
export async function ensureVersionedSeed(
  model: Model<VersionedDoc>,
  seeds: readonly { key: string; revision: number; content: unknown }[],
): Promise<number> {
  let created = 0;
  for (const seed of seeds) {
    const versions = await model
      .find({ key: seed.key }, { version: 1, active: 1, seedRevision: 1, createdBy: 1 })
      .sort({ version: 1 })
      .lean<VersionedDoc[]>();
    const revisions = versions.map(seededRevision);
    if (revisions.includes(null)) continue; // an admin owns this key now
    const latest = Math.max(0, ...(revisions as number[]));
    if (latest >= seed.revision) continue;
    const wasActive = versions.length === 0 || versions.some((v) => v.active);
    try {
      const doc = await model.create({
        key: seed.key,
        version: (versions[versions.length - 1]?.version ?? 0) + 1,
        active: false,
        content: seed.content,
        reason: versions.length ? `Seeded update (revision ${seed.revision})` : 'Seeded default',
        seedRevision: seed.revision,
      });
      if (wasActive) {
        await model.updateMany(
          { key: seed.key, active: true, _id: { $ne: doc._id } },
          { $set: { active: false } },
        );
        await model.updateOne({ _id: doc._id }, { $set: { active: true } });
      }
      created++;
    } catch (err) {
      // Another replica seeded this version first (unique {key, version}).
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return created;
}
