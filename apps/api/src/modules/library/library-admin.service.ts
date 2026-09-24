import {
  CompanyModel,
  contentHash,
  InterviewTemplateModel,
  RoleBlueprintModel,
  RoleModel,
  type CompanyRecord,
  type InterviewTemplateRecord,
  type RoleBlueprintRecord,
  type RoleRecord,
  type VerifiedPatternRecord,
} from '@cbi/db';
import {
  templateDurationSec,
  type BlueprintListQuery,
  type BlueprintSummary,
  type CompanySummary,
  type CreateBlueprintVersionBody,
  type CreateTemplateVersionBody,
  type PromoteBlueprintBody,
  type RoleSummary,
  type TemplateSummary,
  type UpsertCompanyBody,
  type UpsertRoleBody,
} from '@cbi/shared-types';
import type { ClientSession, Types } from 'mongoose';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';

export function roleSummary(r: RoleRecord): RoleSummary {
  return {
    id: String(r._id),
    title: r.title,
    slug: r.slug,
    family: r.family,
    defaultSeniority: r.defaultSeniority,
    aliases: r.aliases,
    activeBlueprintId: r.activeBlueprintId ? String(r.activeBlueprintId) : null,
    active: r.active,
    updatedAt: iso(r.updatedAt),
  };
}

export function blueprintSummary(b: RoleBlueprintRecord): BlueprintSummary {
  return {
    id: String(b._id),
    roleId: b.roleId ? String(b.roleId) : null,
    origin: b.origin,
    version: b.version,
    status: b.status,
    content: b.content,
    contentHash: b.contentHash,
    generatedBy: b.generatedBy
      ? { model: b.generatedBy.model, promptVersion: b.generatedBy.promptVersion ?? null }
      : null,
    sourceJobTargetId: b.sourceJobTargetId ? String(b.sourceJobTargetId) : null,
    createdAt: iso(b.createdAt),
    activatedAt: b.activatedAt ? iso(b.activatedAt) : null,
  };
}

export function companySummary(c: CompanyRecord): CompanySummary {
  return {
    id: String(c._id),
    name: c.name,
    slug: c.slug,
    description: c.description,
    website: c.website,
    roleFamilies: c.roleFamilies,
    verifiedPatterns: c.verifiedPatterns.map((p) => ({
      note: p.note,
      sourceType: p.sourceType,
      sourceUrl: p.sourceUrl,
      verifiedBy: p.verifiedBy ? String(p.verifiedBy) : null,
      verifiedAt: p.verifiedAt ? iso(p.verifiedAt) : null,
    })),
    allowedQuestionCategories: c.allowedQuestionCategories,
    active: c.active,
    updatedAt: iso(c.updatedAt),
  };
}

export function templateSummary(t: InterviewTemplateRecord): TemplateSummary {
  return {
    id: String(t._id),
    key: t.key,
    version: t.version,
    status: t.status,
    content: t.content,
    totalDurationSec: templateDurationSec(t.content),
    createdAt: iso(t.createdAt),
    activatedAt: t.activatedAt ? iso(t.activatedAt) : null,
  };
}

const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;

/**
 * Admin management of the interview library. Blueprints and templates are
 * append-only: edits create a new DRAFT version, and activation swaps the
 * ACTIVE version atomically. Every change is audited in the same transaction.
 */
export function createLibraryAdminService(deps: { audit: AuditService; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());

  async function audited<T>(
    ctx: ClientContext,
    actorId: string,
    event: { action: string; resourceType: string; resourceId?: string },
    fn: (
      session: ClientSession,
    ) => Promise<{ result: T; details: Record<string, unknown>; id?: string }>,
  ): Promise<T> {
    try {
      return await transaction(async (session) => {
        const { result, details, id } = await fn(session);
        await deps.audit.record(
          { actorType: 'ADMIN', actorId, ...event, resourceId: event.resourceId ?? id, details },
          ctx,
          session,
        );
        return result;
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw AppError.conflict('That slug is already in use.');
      throw err;
    }
  }

  async function nextBlueprintVersion(roleId: Types.ObjectId, session: ClientSession) {
    const latest = await RoleBlueprintModel.findOne({ roleId }, { version: 1 }, { session })
      .sort({ version: -1 })
      .lean();
    return (latest?.version ?? 0) + 1;
  }

  async function loadRole(id: string, session?: ClientSession) {
    const role = await RoleModel.findById(objectId(id, 'Role'), null, { session }).lean();
    if (!role) throw AppError.notFound('Role not found');
    return role;
  }

  /** Patterns are verified by the admin who saves them; unchanged ones keep their verifier. */
  function verifyPatterns(
    incoming: UpsertCompanyBody['verifiedPatterns'],
    previous: VerifiedPatternRecord[],
    actorId: string,
  ): VerifiedPatternRecord[] {
    const at = now();
    return incoming.map((p) => {
      const same = previous.find(
        (old) =>
          old.note === p.note && old.sourceType === p.sourceType && old.sourceUrl === p.sourceUrl,
      );
      return same ?? { ...p, verifiedBy: objectId(actorId, 'User'), verifiedAt: at };
    });
  }

  return {
    // ---- Roles ------------------------------------------------------------------------
    async listRoles() {
      const rows = await RoleModel.find().sort({ title: 1 }).lean();
      return rows.map(roleSummary);
    },

    async createRole(body: UpsertRoleBody, actorId: string, ctx: ClientContext) {
      return audited(
        ctx,
        actorId,
        { action: 'role.created', resourceType: 'role' },
        async (session) => {
          const [role] = await RoleModel.create([{ ...body, activeBlueprintId: null }], {
            session,
          });
          return {
            result: roleSummary(role!.toObject()),
            details: { slug: body.slug },
            id: String(role!._id),
          };
        },
      );
    },

    async updateRole(id: string, body: UpsertRoleBody, actorId: string, ctx: ClientContext) {
      return audited(
        ctx,
        actorId,
        { action: 'role.updated', resourceType: 'role', resourceId: id },
        async (session) => {
          const before = await loadRole(id, session);
          const role = await RoleModel.findByIdAndUpdate(
            before._id,
            { $set: body },
            { returnDocument: 'after', session },
          ).lean();
          return {
            result: roleSummary(role!),
            details: {
              before: { title: before.title, slug: before.slug, active: before.active },
              after: { title: body.title, slug: body.slug, active: body.active },
            },
          };
        },
      );
    },

    // ---- Blueprints ----------------------------------------------------------------------
    async listRoleBlueprints(roleId: string) {
      const role = await loadRole(roleId);
      const rows = await RoleBlueprintModel.find({ roleId: role._id }).sort({ version: -1 }).lean();
      return rows.map(blueprintSummary);
    },

    async listBlueprints(query: BlueprintListQuery) {
      const rows = await RoleBlueprintModel.find(query.origin ? { origin: query.origin } : {})
        .sort({ createdAt: -1 })
        .limit(query.limit)
        .lean();
      return rows.map(blueprintSummary);
    },

    async getBlueprint(id: string) {
      const doc = await RoleBlueprintModel.findById(objectId(id, 'Blueprint')).lean();
      if (!doc) throw AppError.notFound('Blueprint not found');
      return blueprintSummary(doc);
    },

    async createBlueprintVersion(
      roleId: string,
      body: CreateBlueprintVersionBody,
      actorId: string,
      ctx: ClientContext,
    ) {
      return audited(
        ctx,
        actorId,
        { action: 'blueprint.version_created', resourceType: 'roleBlueprint' },
        async (session) => {
          const role = await loadRole(roleId, session);
          const version = await nextBlueprintVersion(role._id, session);
          const [doc] = await RoleBlueprintModel.create(
            [
              {
                roleId: role._id,
                origin: 'CANONICAL',
                version,
                status: 'DRAFT',
                content: body.content,
                contentHash: contentHash(body.content),
                createdBy: objectId(actorId, 'User'),
              },
            ],
            { session },
          );
          return {
            result: blueprintSummary(doc!.toObject()),
            details: { roleId, version, reason: body.reason },
            id: String(doc!._id),
          };
        },
      );
    },

    async activateBlueprint(id: string, reason: string, actorId: string, ctx: ClientContext) {
      return audited(
        ctx,
        actorId,
        { action: 'blueprint.version_activated', resourceType: 'roleBlueprint', resourceId: id },
        async (session) => {
          const target = await RoleBlueprintModel.findById(objectId(id, 'Blueprint'), null, {
            session,
          }).lean();
          if (!target) throw AppError.notFound('Blueprint not found');
          if (target.origin !== 'CANONICAL' || !target.roleId) {
            throw new AppError(
              409,
              'INVALID_STATE',
              'Only role blueprints can be activated. Promote an AI-generated blueprint to a role first.',
            );
          }
          if (target.status === 'ACTIVE')
            throw AppError.conflict('This version is already active.');
          const at = now();
          const previous = await RoleBlueprintModel.findOneAndUpdate(
            { roleId: target.roleId, status: 'ACTIVE' },
            { $set: { status: 'RETIRED', retiredAt: at } },
            { session },
          ).lean();
          await RoleBlueprintModel.updateOne(
            { _id: target._id },
            { $set: { status: 'ACTIVE', activatedAt: at, retiredAt: null } },
            { session },
          );
          await RoleModel.updateOne(
            { _id: target.roleId },
            { $set: { activeBlueprintId: target._id } },
            { session },
          );
          const doc = await RoleBlueprintModel.findById(target._id, null, { session }).lean();
          return {
            result: blueprintSummary(doc!),
            details: {
              roleId: String(target.roleId),
              activatedVersion: target.version,
              retiredVersion: previous?.version ?? null,
              reason,
            },
          };
        },
      );
    },

    async promoteBlueprint(
      id: string,
      body: PromoteBlueprintBody,
      actorId: string,
      ctx: ClientContext,
    ) {
      return audited(
        ctx,
        actorId,
        { action: 'blueprint.promoted', resourceType: 'roleBlueprint' },
        async (session) => {
          const source = await RoleBlueprintModel.findById(objectId(id, 'Blueprint'), null, {
            session,
          }).lean();
          if (!source) throw AppError.notFound('Blueprint not found');
          if (source.origin !== 'AI_GENERATED') {
            throw new AppError(
              409,
              'INVALID_STATE',
              'Only AI-generated blueprints can be promoted.',
            );
          }
          const role = await loadRole(body.roleId, session);
          const version = await nextBlueprintVersion(role._id, session);
          const [doc] = await RoleBlueprintModel.create(
            [
              {
                roleId: role._id,
                origin: 'CANONICAL',
                version,
                status: 'DRAFT',
                content: source.content,
                contentHash: source.contentHash,
                generatedBy: source.generatedBy,
                createdBy: objectId(actorId, 'User'),
              },
            ],
            { session },
          );
          return {
            result: blueprintSummary(doc!.toObject()),
            // The candidate's inputs stay private: only ids are recorded.
            details: { sourceBlueprintId: id, roleId: body.roleId, version, reason: body.reason },
            id: String(doc!._id),
          };
        },
      );
    },

    // ---- Companies -----------------------------------------------------------------------
    async listCompanies() {
      const rows = await CompanyModel.find().sort({ name: 1 }).lean();
      return rows.map(companySummary);
    },

    async createCompany(body: UpsertCompanyBody, actorId: string, ctx: ClientContext) {
      return audited(
        ctx,
        actorId,
        { action: 'company.created', resourceType: 'company' },
        async (session) => {
          const [company] = await CompanyModel.create(
            [{ ...body, verifiedPatterns: verifyPatterns(body.verifiedPatterns, [], actorId) }],
            { session },
          );
          return {
            result: companySummary(company!.toObject()),
            details: { slug: body.slug, patterns: body.verifiedPatterns.length },
            id: String(company!._id),
          };
        },
      );
    },

    async updateCompany(id: string, body: UpsertCompanyBody, actorId: string, ctx: ClientContext) {
      return audited(
        ctx,
        actorId,
        { action: 'company.updated', resourceType: 'company', resourceId: id },
        async (session) => {
          const before = await CompanyModel.findById(objectId(id, 'Company'), null, {
            session,
          }).lean();
          if (!before) throw AppError.notFound('Company not found');
          const company = await CompanyModel.findByIdAndUpdate(
            before._id,
            {
              $set: {
                ...body,
                verifiedPatterns: verifyPatterns(
                  body.verifiedPatterns,
                  before.verifiedPatterns,
                  actorId,
                ),
              },
            },
            { returnDocument: 'after', session },
          ).lean();
          return {
            result: companySummary(company!),
            details: {
              slug: body.slug,
              active: body.active,
              patternsBefore: before.verifiedPatterns.length,
              patternsAfter: body.verifiedPatterns.length,
            },
          };
        },
      );
    },

    // ---- Templates -----------------------------------------------------------------------
    async listTemplates() {
      const rows = await InterviewTemplateModel.find().sort({ key: 1, version: -1 }).lean();
      return rows.map(templateSummary);
    },

    async createTemplateVersion(
      body: CreateTemplateVersionBody,
      actorId: string,
      ctx: ClientContext,
    ) {
      return audited(
        ctx,
        actorId,
        { action: 'template.version_created', resourceType: 'interviewTemplate' },
        async (session) => {
          const latest = await InterviewTemplateModel.findOne(
            { key: body.key },
            { version: 1 },
            { session },
          )
            .sort({ version: -1 })
            .lean();
          const version = (latest?.version ?? 0) + 1;
          const [doc] = await InterviewTemplateModel.create(
            [
              {
                key: body.key,
                version,
                status: 'DRAFT',
                content: body.content,
                createdBy: objectId(actorId, 'User'),
              },
            ],
            { session },
          );
          return {
            result: templateSummary(doc!.toObject()),
            details: { key: body.key, version, reason: body.reason },
            id: String(doc!._id),
          };
        },
      );
    },

    async activateTemplate(id: string, reason: string, actorId: string, ctx: ClientContext) {
      return audited(
        ctx,
        actorId,
        { action: 'template.version_activated', resourceType: 'interviewTemplate', resourceId: id },
        async (session) => {
          const target = await InterviewTemplateModel.findById(objectId(id, 'Template'), null, {
            session,
          }).lean();
          if (!target) throw AppError.notFound('Template not found');
          if (target.status === 'ACTIVE')
            throw AppError.conflict('This version is already active.');
          const at = now();
          const previous = await InterviewTemplateModel.findOneAndUpdate(
            { key: target.key, status: 'ACTIVE' },
            { $set: { status: 'RETIRED', retiredAt: at } },
            { session },
          ).lean();
          await InterviewTemplateModel.updateOne(
            { _id: target._id },
            { $set: { status: 'ACTIVE', activatedAt: at, retiredAt: null } },
            { session },
          );
          const doc = await InterviewTemplateModel.findById(target._id, null, { session }).lean();
          return {
            result: templateSummary(doc!),
            details: {
              key: target.key,
              activatedVersion: target.version,
              retiredVersion: previous?.version ?? null,
              reason,
            },
          };
        },
      );
    },
  };
}

export type LibraryAdminService = ReturnType<typeof createLibraryAdminService>;
