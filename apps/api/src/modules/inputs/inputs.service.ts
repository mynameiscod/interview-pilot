import { createHash } from 'node:crypto';
import type { Logger } from '@cbi/config';
import {
  CompanyModel,
  JobTargetModel,
  mongoose,
  ResumeModel,
  RoleModel,
  type ExtractionRecord,
  type JobTargetRecord,
  type ResumeRecord,
} from '@cbi/db';
import { detectDocumentType } from '@cbi/documents/detect';
import type { StorageProvider } from '@cbi/provider-adapters';
import {
  DOCUMENT_MIME,
  type CreateJobTargetBody,
  type DocumentMime,
  type Extraction,
  type JobTargetSummary,
  type ResumeSummary,
  type UploadJobTargetFields,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { JobQueues } from '../../lib/jobs.js';
import type { ClientContext } from '../../lib/request-context.js';
import { safeFileName } from '../../lib/upload.js';

/** Stored inputs per candidate; older ones must be deleted first. */
export const MAX_RESUMES_PER_USER = 20;

const EXTENSION: Record<DocumentMime, string> = {
  [DOCUMENT_MIME.PDF]: 'pdf',
  [DOCUMENT_MIME.DOCX]: 'docx',
  [DOCUMENT_MIME.TXT]: 'txt',
};

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
}

export function extractionSummary(e: ExtractionRecord): Extraction {
  return {
    status: e.status,
    errorCode: e.errorCode,
    warnings: e.warnings,
    parser: e.parser,
    ocrUsed: e.ocrUsed,
    charCount: e.charCount,
    completedAt: e.completedAt ? iso(e.completedAt) : null,
  };
}

export function resumeSummary(r: ResumeRecord): ResumeSummary {
  return {
    id: String(r._id),
    originalName: r.originalName,
    mime: r.mime,
    size: r.size,
    extraction: extractionSummary(r.extraction),
    structured: r.structured,
    createdAt: iso(r.createdAt),
  };
}

export async function jobTargetSummary(t: JobTargetRecord): Promise<JobTargetSummary> {
  const [company, role] = await Promise.all([
    t.companyId ? CompanyModel.findById(t.companyId, { name: 1 }).lean() : null,
    t.roleId ? RoleModel.findById(t.roleId, { title: 1 }).lean() : null,
  ]);
  return {
    id: String(t._id),
    source: t.source,
    url: t.url,
    originalName: t.originalName,
    extraction: extractionSummary(t.extraction),
    structured: t.structured,
    company: company ? { id: String(company._id), name: company.name } : null,
    companyName: t.companyName,
    role: role ? { id: String(role._id), title: role.title } : null,
    roleTitle: t.roleTitle,
    createdAt: iso(t.createdAt),
  };
}

function sniff(file: UploadedFile): DocumentMime {
  const mime = detectDocumentType(file.buffer);
  if (!mime) {
    throw new AppError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Upload a PDF, Word (.docx) or plain-text file.',
    );
  }
  return mime;
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

interface Deps {
  storage: StorageProvider;
  jobs: JobQueues;
  audit: AuditService;
  logger: Logger;
}

export function createInputsService({ storage, jobs, audit, logger }: Deps) {
  /** Resolves library references; unknown or inactive ids are a validation error. */
  async function resolveTarget(
    userInput: Pick<CreateJobTargetBody, 'companyId' | 'companyName' | 'roleId' | 'roleTitle'>,
  ) {
    let companyId: mongoose.Types.ObjectId | null = null;
    let companyName = userInput.companyName?.trim() || null;
    if (userInput.companyId) {
      const company = mongoose.isValidObjectId(userInput.companyId)
        ? await CompanyModel.findOne({ _id: userInput.companyId, active: true }).lean()
        : null;
      if (!company)
        throw AppError.validation('That company is not available. Type its name instead.');
      companyId = company._id;
      companyName = company.name;
    }
    let roleId: mongoose.Types.ObjectId | null = null;
    let roleTitle = userInput.roleTitle?.trim() || null;
    if (userInput.roleId) {
      const role = mongoose.isValidObjectId(userInput.roleId)
        ? await RoleModel.findOne({ _id: userInput.roleId, active: true }).lean()
        : null;
      if (!role)
        throw AppError.validation('That role is not available. Type a role title instead.');
      roleId = role._id;
      roleTitle = role.title;
    }
    return { companyId, companyName, roleId, roleTitle };
  }

  async function enqueue(kind: 'resume' | 'jobTarget', id: string, run: () => Promise<void>) {
    try {
      await run();
    } catch (err) {
      // The input stays PENDING; analysis then times out with a clear error instead of hanging.
      logger.error({ err, kind, id }, 'failed to enqueue extraction');
      throw new AppError(
        503,
        'SERVICE_UNAVAILABLE',
        'We could not start processing. Please try again.',
      );
    }
  }

  return {
    async uploadResume(userId: string, file: UploadedFile, ctx: ClientContext) {
      const mime = sniff(file);
      const hash = sha256(file.buffer);
      // Re-uploading the same file returns the existing resume instead of a duplicate.
      const existing = await ResumeModel.findOne({
        userId,
        sha256: hash,
        'extraction.status': { $ne: 'FAILED' },
      }).lean();
      if (existing) return { created: false, resume: resumeSummary(existing) };
      if ((await ResumeModel.countDocuments({ userId })) >= MAX_RESUMES_PER_USER) {
        throw AppError.conflict(
          `You can keep up to ${MAX_RESUMES_PER_USER} resumes. Delete one to upload another.`,
        );
      }
      const id = new mongoose.Types.ObjectId();
      const storageKey = `resumes/${userId}/${id}.${EXTENSION[mime]}`;
      await storage.put(storageKey, file.buffer, mime);
      const resume = await ResumeModel.create({
        _id: id,
        userId,
        storageKey,
        originalName: safeFileName(file.originalname),
        mime,
        size: file.buffer.length,
        sha256: hash,
      });
      await audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'resume.uploaded',
          resourceType: 'resume',
          resourceId: String(id),
          details: { mime, size: file.buffer.length },
        },
        ctx,
      );
      await enqueue('resume', String(id), () => jobs.extractResume(String(id)));
      return { created: true, resume: resumeSummary(resume.toObject()) };
    },

    async listResumes(userId: string) {
      const rows = await ResumeModel.find({ userId }, { rawText: 0 })
        .sort({ createdAt: -1 })
        .limit(MAX_RESUMES_PER_USER)
        .lean();
      return rows.map((r) => resumeSummary(r as ResumeRecord));
    },

    async getResume(userId: string, id: string) {
      const resume = await ResumeModel.findOne(
        { _id: objectId(id, 'Resume'), userId },
        { rawText: 0 },
      ).lean();
      if (!resume) throw AppError.notFound('Resume not found');
      return resumeSummary(resume as ResumeRecord);
    },

    async deleteResume(userId: string, id: string, ctx: ClientContext) {
      const resume = await ResumeModel.findOneAndDelete({ _id: objectId(id, 'Resume'), userId });
      if (!resume) throw AppError.notFound('Resume not found');
      try {
        await storage.delete(resume.storageKey);
      } catch (err) {
        // The record is gone; an orphaned object is swept by the Phase 8 retention job.
        logger.warn({ err, resumeId: id }, 'resume object delete failed');
      }
      await audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'resume.deleted',
          resourceType: 'resume',
          resourceId: id,
        },
        ctx,
      );
    },

    async createJobTarget(userId: string, body: CreateJobTargetBody) {
      const refs = await resolveTarget(body);
      const readyNow = body.source === 'ROLE_ONLY';
      const target = await JobTargetModel.create({
        userId,
        source: body.source,
        url: body.source === 'URL' ? body.url : null,
        rawText: body.source === 'PASTE' ? body.text : null,
        ...refs,
        extraction: readyNow
          ? { status: 'READY', parser: 'none', completedAt: new Date() }
          : { status: 'PENDING' },
      });
      if (!readyNow) {
        await enqueue('jobTarget', String(target._id), () =>
          jobs.extractJobTarget(String(target._id)),
        );
      }
      return jobTargetSummary(target.toObject());
    },

    async uploadJobTarget(userId: string, file: UploadedFile, fields: UploadJobTargetFields) {
      const mime = sniff(file);
      const refs = await resolveTarget(fields);
      const id = new mongoose.Types.ObjectId();
      const storageKey = `job-descriptions/${userId}/${id}.${EXTENSION[mime]}`;
      await storage.put(storageKey, file.buffer, mime);
      const target = await JobTargetModel.create({
        _id: id,
        userId,
        source: 'UPLOAD',
        storageKey,
        originalName: safeFileName(file.originalname),
        mime,
        sha256: sha256(file.buffer),
        ...refs,
      });
      await enqueue('jobTarget', String(id), () => jobs.extractJobTarget(String(id)));
      return jobTargetSummary(target.toObject());
    },

    async listJobTargets(userId: string) {
      const rows = await JobTargetModel.find({ userId }, { rawText: 0 })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
      return Promise.all(rows.map((t) => jobTargetSummary(t as JobTargetRecord)));
    },

    async getJobTarget(userId: string, id: string) {
      const target = await JobTargetModel.findOne(
        { _id: objectId(id, 'Job target'), userId },
        { rawText: 0 },
      ).lean();
      if (!target) throw AppError.notFound('Job target not found');
      return jobTargetSummary(target as JobTargetRecord);
    },
  };
}

export type InputsService = ReturnType<typeof createInputsService>;
