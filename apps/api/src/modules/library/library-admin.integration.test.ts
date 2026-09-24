import {
  AuditLogModel,
  contentHash,
  ensureLibraryCatalog,
  InterviewTemplateModel,
  RoleBlueprintModel,
  RoleModel,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import {
  BlueprintSummary,
  CompanySummary,
  RoleSummary,
  TemplateSummary,
  type AdminRole,
  type BlueprintContent,
} from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis });
  await ensureLibraryCatalog();
});

async function adminAs(roles: AdminRole[], email = `${roles[0]!.toLowerCase()}@codebegun.com`) {
  const user = await UserModel.create({ primaryEmail: email, adminRoles: roles });
  await UserProfileModel.create({ userId: user._id });
  const { accessToken } = await signInWithEmail(t.app, t.email.sent, email, 'admin');
  const call = (method: 'get' | 'post' | 'put', path: string) =>
    request(t.app)
      [method](`/api/v1/admin${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { call, userId: String(user._id) };
}

async function backendRole() {
  return (await RoleModel.findOne({ slug: 'backend-engineer' }).lean())!;
}

async function activeContent(): Promise<BlueprintContent> {
  const role = await backendRole();
  return (await RoleBlueprintModel.findById(role.activeBlueprintId).lean())!.content;
}

describe('admin library permissions', () => {
  it.each([
    ['SUPPORT_ADMIN', 403],
    ['FINANCE_ADMIN', 403],
    ['CONTENT_ADMIN', 200],
    ['OPERATIONS_ADMIN', 200],
  ] as const)('%s reading roles gets %i', async (role, status) => {
    const { call } = await adminAs([role]);
    await call('get', '/roles').expect(status);
  });

  it('candidates cannot reach admin library endpoints', async () => {
    const { accessToken } = await signInWithEmail(t.app, t.email.sent, 'cand@example.com');
    await request(t.app)
      .get('/api/v1/admin/roles')
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
  });
});

describe('roles and blueprint versions', () => {
  it('lists the seeded roles with their active blueprints', async () => {
    const { call } = await adminAs(['CONTENT_ADMIN']);
    const roles = z.array(RoleSummary).parse((await call('get', '/roles').expect(200)).body.data);
    expect(roles.map((r) => r.slug)).toEqual(
      expect.arrayContaining([
        'backend-engineer',
        'frontend-engineer',
        'data-analyst',
        'qa-engineer',
      ]),
    );
    expect(roles.every((r) => r.activeBlueprintId)).toBe(true);
  });

  it('creates a role and rejects a duplicate slug', async () => {
    const { call } = await adminAs(['CONTENT_ADMIN']);
    const body = {
      title: 'DevOps Engineer',
      slug: 'devops-engineer',
      family: 'INFRASTRUCTURE',
      defaultSeniority: 'MID',
    };
    const res = await call('post', '/roles').send(body).expect(201);
    expect(res.body.data).toMatchObject({
      slug: 'devops-engineer',
      activeBlueprintId: null,
      aliases: [],
    });
    const dup = await call('post', '/roles').send(body).expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('adds a DRAFT version, activates it and retires the previous one atomically', async () => {
    const { call, userId } = await adminAs(['CONTENT_ADMIN']);
    const role = await backendRole();
    const content = await activeContent();
    const edited = {
      ...content,
      role: { ...content.role, summary: 'Updated summary for version two.' },
    };
    const created = BlueprintSummary.parse(
      (
        await call('post', `/roles/${role._id}/blueprints`)
          .send({ content: edited, reason: 'Clarify the summary' })
          .expect(201)
      ).body.data,
    );
    expect(created).toMatchObject({ version: 2, status: 'DRAFT', origin: 'CANONICAL' });
    expect(created.contentHash).toBe(contentHash(edited));

    await call('post', `/blueprints/${created.id}/activate`)
      .send({ reason: 'Ship v2' })
      .expect(200);
    const versions = z
      .array(BlueprintSummary)
      .parse((await call('get', `/roles/${role._id}/blueprints`).expect(200)).body.data);
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'ACTIVE'],
      [1, 'RETIRED'],
    ]);
    expect(String((await backendRole()).activeBlueprintId)).toBe(created.id);
    const audit = await AuditLogModel.findOne({ action: 'blueprint.version_activated' }).lean();
    expect(audit).toMatchObject({ actorType: 'ADMIN', resourceId: created.id });
    expect(String(audit!.actorId)).toBe(userId);
    expect(audit!.details).toMatchObject({
      activatedVersion: 2,
      retiredVersion: 1,
      reason: 'Ship v2',
    });

    await call('post', `/blueprints/${created.id}/activate`).send({ reason: 'again' }).expect(409);
  });

  it('validates blueprint content (weights must sum to 100)', async () => {
    const { call } = await adminAs(['CONTENT_ADMIN']);
    const role = await backendRole();
    const content = await activeContent();
    content.competencies[0]!.weight += 1;
    const res = await call('post', `/roles/${role._id}/blueprints`)
      .send({ content, reason: 'broken weights' })
      .expect(400);
    expect(JSON.stringify(res.body.error.details)).toContain('sum to 100');
  });

  it('promotes an AI-generated blueprint into a role as a new DRAFT', async () => {
    const { call } = await adminAs(['OPERATIONS_ADMIN']);
    const role = await backendRole();
    const content = await activeContent();
    const generated = await RoleBlueprintModel.create({
      roleId: null,
      origin: 'AI_GENERATED',
      version: 1,
      status: 'ACTIVE',
      content,
      contentHash: contentHash(content),
      generatedBy: { model: 'mock-llm', promptVersion: 1 },
    });
    const list = await call('get', '/blueprints').query({ origin: 'AI_GENERATED' }).expect(200);
    expect(list.body.data.map((b: { id: string }) => b.id)).toEqual([String(generated._id)]);

    // AI-generated blueprints cannot be activated directly.
    await call('post', `/blueprints/${generated._id}/activate`)
      .send({ reason: 'nope' })
      .expect(409);
    const promoted = await call('post', `/blueprints/${generated._id}/promote`)
      .send({ roleId: String(role._id), reason: 'Good tailored version' })
      .expect(201);
    expect(promoted.body.data).toMatchObject({
      roleId: String(role._id),
      origin: 'CANONICAL',
      version: 2,
      status: 'DRAFT',
      generatedBy: { model: 'mock-llm', promptVersion: 1 },
    });
  });

  it('never lets stored versions be edited in place', async () => {
    const role = await backendRole();
    await expect(
      RoleBlueprintModel.updateOne(
        { _id: role.activeBlueprintId },
        { $set: { 'content.notes': 'x' } },
      ),
    ).rejects.toThrow(/immutable/);
    await expect(RoleBlueprintModel.deleteOne({ _id: role.activeBlueprintId })).rejects.toThrow();
  });
});

describe('companies', () => {
  const body = {
    name: 'Acme Payments',
    slug: 'acme-payments',
    verifiedPatterns: [
      {
        note: 'Final round includes a system design discussion.',
        sourceType: 'COMPANY_PUBLISHED',
        sourceUrl: 'https://acme.example/careers',
      },
    ],
  };

  it('records who verified each pattern and keeps it for unchanged notes', async () => {
    const first = await adminAs(['CONTENT_ADMIN']);
    const created = CompanySummary.parse(
      (await first.call('post', '/companies').send(body).expect(201)).body.data,
    );
    expect(created.verifiedPatterns[0]).toMatchObject({ verifiedBy: first.userId });
    expect(created.allowedQuestionCategories).toHaveLength(5);

    const second = await adminAs(['OPERATIONS_ADMIN']);
    const updated = CompanySummary.parse(
      (
        await second
          .call('put', `/companies/${created.id}`)
          .send({
            ...body,
            verifiedPatterns: [
              ...body.verifiedPatterns,
              {
                note: 'Behavioural round uses STAR questions.',
                sourceType: 'PUBLIC_POSTING',
                sourceUrl: null,
              },
            ],
          })
          .expect(200)
      ).body.data,
    );
    expect(updated.verifiedPatterns.map((p) => p.verifiedBy)).toEqual([
      first.userId,
      second.userId,
    ]);

    // Candidates only ever see the name.
    const search = await request(t.app)
      .get('/api/v1/companies')
      .set('Origin', TEST_ORIGIN)
      .expect(200);
    expect(search.body.data).toEqual([
      { id: created.id, name: 'Acme Payments', slug: 'acme-payments' },
    ]);
  });

  it('rejects non-http source links', async () => {
    const { call } = await adminAs(['CONTENT_ADMIN']);
    await call('post', '/companies')
      .send({
        ...body,
        verifiedPatterns: [{ ...body.verifiedPatterns[0], sourceUrl: 'javascript:alert(1)' }],
      })
      .expect(400);
  });
});

describe('templates', () => {
  it('versions templates by key and swaps the active version', async () => {
    const { call } = await adminAs(['CONTENT_ADMIN']);
    const templates = z
      .array(TemplateSummary)
      .parse((await call('get', '/templates').expect(200)).body.data);
    const standard = templates.find((x) => x.key === 'standard-practice')!;
    const content = { ...standard.content, creditCost: standard.content.creditCost + 1 };
    const created = await call('post', '/templates')
      .send({ key: 'standard-practice', content, reason: 'Price change' })
      .expect(201);
    expect(created.body.data).toMatchObject({ version: 2, status: 'DRAFT' });

    await call('post', `/templates/${created.body.data.id}/activate`)
      .send({ reason: 'Go live' })
      .expect(200);
    const active = await InterviewTemplateModel.find({
      key: 'standard-practice',
      status: 'ACTIVE',
    }).lean();
    expect(active.map((x) => x.version)).toEqual([2]);
  });

  it('rejects templates whose dimension weights do not sum to 100', async () => {
    const { call } = await adminAs(['CONTENT_ADMIN']);
    const [standard] = z
      .array(TemplateSummary)
      .parse((await call('get', '/templates')).body.data)
      .filter((x) => x.key === 'standard-practice');
    const weights = { ...standard!.content.scoringPolicy.dimensionWeights, TECHNICAL: 99 };
    await call('post', '/templates')
      .send({
        key: 'standard-practice',
        content: { ...standard!.content, scoringPolicy: { dimensionWeights: weights } },
        reason: 'bad weights',
      })
      .expect(400);
  });
});
