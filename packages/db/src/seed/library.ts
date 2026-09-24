import { createHash } from 'node:crypto';
import { extractVariables } from '@cbi/ai-core';
import { BlueprintContent, TemplateContent } from '@cbi/shared-types';
import { PromptTemplateModel } from '../models/ai.js';
import { InterviewTemplateModel, RoleBlueprintModel, RoleModel } from '../models/library.js';
import { SEED_PROMPTS } from './prompts-content.js';
import { SEED_ROLES, SEED_TEMPLATES } from './library-content.js';

/** Stable hash of JSON content (key order preserved as authored). */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export interface EnsureLibraryResult {
  rolesCreated: number;
  blueprintsCreated: number;
  templatesCreated: number;
  promptsCreated: number;
}

/**
 * Idempotent first-run seed for the interview library and the Phase 3
 * prompts. Only fills gaps (a role with no blueprints, a template key or
 * prompt key with no versions); never modifies what admins have changed.
 */
export async function ensureLibraryCatalog(now: Date = new Date()): Promise<EnsureLibraryResult> {
  const result: EnsureLibraryResult = {
    rolesCreated: 0,
    blueprintsCreated: 0,
    templatesCreated: 0,
    promptsCreated: 0,
  };

  for (const seed of SEED_ROLES) {
    const content = BlueprintContent.parse(seed.blueprint);
    const upsert = await RoleModel.updateOne(
      { slug: seed.slug },
      {
        $setOnInsert: {
          slug: seed.slug,
          title: seed.title,
          family: seed.family,
          defaultSeniority: seed.defaultSeniority,
          aliases: seed.aliases,
          active: true,
          activeBlueprintId: null,
        },
      },
      { upsert: true },
    );
    result.rolesCreated += upsert.upsertedCount;
    const role = await RoleModel.findOne({ slug: seed.slug }, { _id: 1 }).lean();
    if (!role || (await RoleBlueprintModel.exists({ roleId: role._id }))) continue;
    try {
      const [blueprint] = await RoleBlueprintModel.create([
        {
          roleId: role._id,
          origin: 'CANONICAL',
          version: 1,
          status: 'ACTIVE',
          content,
          contentHash: contentHash(content),
          activatedAt: now,
        },
      ]);
      await RoleModel.updateOne(
        { _id: role._id, activeBlueprintId: null },
        { $set: { activeBlueprintId: blueprint!._id } },
      );
      result.blueprintsCreated += 1;
    } catch (err) {
      // Another replica seeded it first (unique {roleId, version}).
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  for (const seed of SEED_TEMPLATES) {
    if (await InterviewTemplateModel.exists({ key: seed.key })) continue;
    try {
      await InterviewTemplateModel.create({
        key: seed.key,
        version: 1,
        status: 'ACTIVE',
        content: TemplateContent.parse(seed.content),
        activatedAt: now,
      });
      result.templatesCreated += 1;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  for (const seed of SEED_PROMPTS) {
    if (await PromptTemplateModel.exists({ key: seed.key, locale: 'en' })) continue;
    try {
      await PromptTemplateModel.create({
        key: seed.key,
        version: 1,
        locale: 'en',
        feature: seed.feature,
        status: 'ACTIVE',
        messages: seed.messages,
        variables: extractVariables(seed.messages),
        notes: 'Seeded default.',
        contentHash: contentHash({ feature: seed.feature, messages: seed.messages }),
        activatedAt: now,
      });
      result.promptsCreated += 1;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return result;
}
