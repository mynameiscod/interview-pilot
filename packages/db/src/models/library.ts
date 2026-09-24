import {
  BlueprintOrigin,
  CompetencyCategory,
  LibraryStatus,
  PatternSourceType,
  RoleFamily,
  Seniority,
  type BlueprintContent,
  type TemplateContent,
} from '@cbi/shared-types';
import type {
  BlueprintOrigin as BlueprintOriginT,
  CompetencyCategory as CompetencyCategoryT,
  LibraryStatus as LibraryStatusT,
  PatternSourceType as PatternSourceTypeT,
  RoleFamily as RoleFamilyT,
  Seniority as SeniorityT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

/**
 * Versioned documents are append-only: only lifecycle fields may change and
 * versions are never replaced or deleted.
 */
function immutableContent(schema: Schema, collection: string, mutable: readonly string[]) {
  const allowed = new Set(mutable);
  for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
    schema.pre(op, function () {
      const update = (this.getUpdate() ?? {}) as Record<string, unknown>;
      const fields = Object.entries(update).flatMap(([k, v]) =>
        k.startsWith('$') ? Object.keys((v ?? {}) as object) : [k],
      );
      const forbidden = fields.filter((f) => !allowed.has(f));
      if (forbidden.length > 0) {
        throw new Error(`${collection} content is immutable (attempted: ${forbidden.join(', ')})`);
      }
    });
  }
  for (const op of [
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ] as const) {
    schema.pre(op, function () {
      throw new Error(`${collection} versions cannot be replaced or deleted`);
    });
  }
}

// ---- companies -----------------------------------------------------------------------

export interface VerifiedPatternRecord {
  note: string;
  sourceType: PatternSourceTypeT;
  sourceUrl: string | null;
  verifiedBy: Types.ObjectId | null;
  verifiedAt: Date | null;
}

export interface CompanyRecord {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  description: string | null;
  website: string | null;
  roleFamilies: RoleFamilyT[];
  verifiedPatterns: VerifiedPatternRecord[];
  allowedQuestionCategories: CompetencyCategoryT[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const companySchema = new Schema<CompanyRecord>(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true },
    description: { type: String, default: null },
    website: { type: String, default: null },
    roleFamilies: { type: [String], enum: RoleFamily.options, default: [] },
    verifiedPatterns: {
      type: [
        new Schema<VerifiedPatternRecord>(
          {
            note: { type: String, required: true },
            sourceType: { type: String, enum: PatternSourceType.options, required: true },
            sourceUrl: { type: String, default: null },
            verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
            verifiedAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    allowedQuestionCategories: { type: [String], enum: CompetencyCategory.options, default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'companies' },
);
companySchema.index({ slug: 1 }, { unique: true });
companySchema.index({ name: 'text' });
companySchema.index({ active: 1, name: 1 });

export const CompanyModel = model<CompanyRecord>('Company', companySchema);

// ---- roles ---------------------------------------------------------------------------

export interface RoleRecord {
  _id: Types.ObjectId;
  title: string;
  slug: string;
  family: RoleFamilyT;
  defaultSeniority: SeniorityT;
  aliases: string[];
  activeBlueprintId: Types.ObjectId | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<RoleRecord>(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true },
    family: { type: String, enum: RoleFamily.options, required: true },
    defaultSeniority: { type: String, enum: Seniority.options, required: true },
    aliases: { type: [String], default: [] },
    activeBlueprintId: { type: Schema.Types.ObjectId, ref: 'RoleBlueprint', default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'roles' },
);
roleSchema.index({ slug: 1 }, { unique: true });
roleSchema.index({ family: 1, active: 1 });
roleSchema.index({ title: 'text', aliases: 'text' });

export const RoleModel = model<RoleRecord>('Role', roleSchema);

// ---- roleBlueprints (append-only by version) -------------------------------------------

export interface RoleBlueprintRecord {
  _id: Types.ObjectId;
  /** Null for AI-generated blueprints that are not (yet) part of a canonical role. */
  roleId: Types.ObjectId | null;
  origin: BlueprintOriginT;
  version: number;
  status: LibraryStatusT;
  content: BlueprintContent;
  contentHash: string;
  generatedBy: { model: string; promptVersion: number | null } | null;
  sourceJobTargetId: Types.ObjectId | null;
  /** The candidate whose inputs produced an AI-generated blueprint (private to them and admins). */
  userId: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  activatedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
}

const roleBlueprintSchema = new Schema<RoleBlueprintRecord>(
  {
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', default: null },
    origin: { type: String, enum: BlueprintOrigin.options, required: true },
    version: { type: Number, required: true },
    status: { type: String, enum: LibraryStatus.options, required: true, default: 'DRAFT' },
    content: { type: Schema.Types.Mixed, required: true },
    contentHash: { type: String, required: true },
    generatedBy: {
      type: new Schema(
        { model: String, promptVersion: { type: Number, default: null } },
        { _id: false },
      ),
      default: null,
    },
    sourceJobTargetId: { type: Schema.Types.ObjectId, ref: 'JobTarget', default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    activatedAt: { type: Date, default: null },
    retiredAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'roleBlueprints' },
);
roleBlueprintSchema.index(
  { roleId: 1, version: 1 },
  { unique: true, partialFilterExpression: { roleId: { $type: 'objectId' } } },
);
roleBlueprintSchema.index(
  { roleId: 1 },
  {
    unique: true,
    partialFilterExpression: { roleId: { $type: 'objectId' }, status: 'ACTIVE' },
    name: 'one_active_per_role',
  },
);
roleBlueprintSchema.index({ origin: 1, status: 1 });
roleBlueprintSchema.index({ contentHash: 1 });
roleBlueprintSchema.index(
  { userId: 1, createdAt: -1 },
  { partialFilterExpression: { userId: { $type: 'objectId' } } },
);
immutableContent(roleBlueprintSchema, 'roleBlueprints', ['status', 'activatedAt', 'retiredAt']);

export const RoleBlueprintModel = model<RoleBlueprintRecord>('RoleBlueprint', roleBlueprintSchema);

// ---- interviewTemplates (append-only by version) ----------------------------------------

export interface InterviewTemplateRecord {
  _id: Types.ObjectId;
  key: string;
  version: number;
  status: LibraryStatusT;
  content: TemplateContent;
  createdBy: Types.ObjectId | null;
  activatedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
}

const interviewTemplateSchema = new Schema<InterviewTemplateRecord>(
  {
    key: { type: String, required: true },
    version: { type: Number, required: true },
    status: { type: String, enum: LibraryStatus.options, required: true, default: 'DRAFT' },
    content: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    activatedAt: { type: Date, default: null },
    retiredAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'interviewTemplates' },
);
interviewTemplateSchema.index({ key: 1, version: 1 }, { unique: true });
interviewTemplateSchema.index(
  { key: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_per_key' },
);
immutableContent(interviewTemplateSchema, 'interviewTemplates', [
  'status',
  'activatedAt',
  'retiredAt',
]);

export const InterviewTemplateModel = model<InterviewTemplateRecord>(
  'InterviewTemplate',
  interviewTemplateSchema,
);
