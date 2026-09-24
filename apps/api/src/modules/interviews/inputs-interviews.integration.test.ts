import {
  AuditLogModel,
  ensureLibraryCatalog,
  InterviewSessionModel,
  JobTargetModel,
  ResumeModel,
  RoleModel,
} from '@cbi/db';
import { buildDocx, buildPdf, SAMPLE_RESUME_LINES } from '@cbi/documents/testing';
import { InterviewSummary, JobTargetSummary, ResumeSummary } from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis });
  await ensureLibraryCatalog();
});

async function candidate(email = 'asha@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { call, userId: String(user.id) };
}

const JD_TEXT =
  'We are hiring a Backend Engineer to build REST APIs with Node.js and PostgreSQL. ' +
  'You will own services end to end.';

describe('resumes', () => {
  it('stores an upload, sniffs its type and enqueues extraction', async () => {
    const { call, userId } = await candidate();
    const pdf = buildPdf([SAMPLE_RESUME_LINES]);
    const res = await call('post', '/resumes')
      .attach('file', pdf, { filename: '../../etc/My Résumé.pdf', contentType: 'image/png' })
      .expect(201);
    const resume = ResumeSummary.parse(res.body.data);
    expect(resume).toMatchObject({ mime: 'application/pdf', size: pdf.length });
    expect(resume.extraction.status).toBe('PENDING');
    expect(resume.originalName).toBe('My Résumé.pdf');
    const stored = await ResumeModel.findById(resume.id).lean();
    expect(stored!.storageKey).toBe(`resumes/${userId}/${resume.id}.pdf`);
    expect(t.storage.objects.get(stored!.storageKey)!.body.equals(pdf)).toBe(true);
    expect(t.jobs.jobs).toEqual([{ kind: 'resume', id: resume.id }]);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await AuditLogModel.countDocuments({ action: 'resume.uploaded' })).toBe(1);
  });

  it('returns the existing resume for a duplicate upload', async () => {
    const { call } = await candidate();
    const docx = buildDocx(SAMPLE_RESUME_LINES);
    const first = await call('post', '/resumes').attach('file', docx, 'cv.docx').expect(201);
    const second = await call('post', '/resumes').attach('file', docx, 'cv-copy.docx').expect(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(t.jobs.jobs).toHaveLength(1);
  });

  it('rejects files that are not documents, whatever they are called', async () => {
    const { call } = await candidate();
    const res = await call('post', '/resumes')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]), {
        filename: 'resume.pdf',
        contentType: 'application/pdf',
      })
      .expect(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(t.storage.objects.size).toBe(0);
  });

  it('enforces the upload size limit before storing anything', async () => {
    t = await buildTestApp({ redis, env: { UPLOAD_MAX_MB: '1' } });
    const { call } = await candidate();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024 * 1024 + 10, 0x20)]);
    const res = await call('post', '/resumes').attach('file', big, 'big.pdf').expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(t.storage.objects.size).toBe(0);
  });

  it('requires a file in the "file" field', async () => {
    const { call } = await candidate();
    await call('post', '/resumes')
      .attach('other', buildPdf([['x']]), 'a.pdf')
      .expect(400);
    await call('post', '/resumes').send({}).expect(400);
  });

  it('lists without raw text, deletes the object, and hides other users’ resumes', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const up = await asha
      .call('post', '/resumes')
      .attach('file', buildPdf([SAMPLE_RESUME_LINES]), 'a.pdf');
    const id = up.body.data.id as string;
    await ResumeModel.updateOne({ _id: id }, { $set: { rawText: 'secret text' } });

    const list = await asha.call('get', '/resumes').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('secret text');
    await asha.call('get', `/resumes/${id}/status`).expect(200);

    await ravi.call('get', `/resumes/${id}`).expect(404);
    await ravi.call('delete', `/resumes/${id}`).expect(404);
    expect((await ravi.call('get', '/resumes')).body.data).toEqual([]);

    await asha.call('delete', `/resumes/${id}`).expect(204);
    expect(t.storage.objects.size).toBe(0);
    await asha.call('get', `/resumes/${id}`).expect(404);
    await asha.call('get', '/resumes/not-an-id').expect(404);
  });

  it('requires a candidate session', async () => {
    await request(t.app).get('/api/v1/resumes').set('Origin', TEST_ORIGIN).expect(401);
  });
});

describe('job targets', () => {
  it('accepts pasted text and enqueues structuring', async () => {
    const { call } = await candidate();
    const res = await call('post', '/jobs')
      .send({ source: 'PASTE', text: JD_TEXT, companyName: '  Acme Corp ' })
      .expect(201);
    const target = JobTargetSummary.parse(res.body.data);
    expect(target).toMatchObject({ source: 'PASTE', companyName: 'Acme Corp', company: null });
    expect(t.jobs.jobs).toEqual([{ kind: 'jobTarget', id: target.id }]);
  });

  it('resolves library roles and is ready at once for role-only targets', async () => {
    const { call } = await candidate();
    const role = await RoleModel.findOne({ slug: 'qa-engineer' }).lean();
    const res = await call('post', '/jobs')
      .send({ source: 'ROLE_ONLY', roleId: String(role!._id), roleTitle: 'ignored' })
      .expect(201);
    expect(res.body.data).toMatchObject({
      role: { id: String(role!._id), title: 'QA Engineer' },
      roleTitle: 'QA Engineer',
      extraction: { status: 'READY' },
    });
    expect(t.jobs.jobs).toEqual([]);
  });

  it.each([
    [{ source: 'ROLE_ONLY' }],
    [{ source: 'PASTE', text: 'too short' }],
    [{ source: 'URL', url: 'ftp://example.com/job' }],
    [{ source: 'URL', url: 'https://user:pass@example.com/job' }],
    [{ source: 'URL', url: 'javascript:alert(1)' }],
    [{ source: 'ROLE_ONLY', roleId: '64b7f3c2a1b2c3d4e5f60718' }],
  ])('rejects %j', async (body) => {
    const { call } = await candidate();
    await call('post', '/jobs').send(body).expect(400);
    expect(t.jobs.jobs).toEqual([]);
  });

  it('accepts a job URL for the SSRF-guarded worker fetch', async () => {
    const { call } = await candidate();
    const res = await call('post', '/jobs')
      .send({ source: 'URL', url: 'https://careers.example.com/jobs/42' })
      .expect(201);
    expect(res.body.data).toMatchObject({
      url: 'https://careers.example.com/jobs/42',
      extraction: { status: 'PENDING' },
    });
  });

  it('accepts an uploaded JD with form fields', async () => {
    const { call } = await candidate();
    const res = await call('post', '/jobs/upload')
      .field('companyName', 'Acme')
      .field('roleTitle', 'Backend Engineer')
      .attach('file', Buffer.from(JD_TEXT), 'jd.txt')
      .expect(201);
    expect(res.body.data).toMatchObject({
      source: 'UPLOAD',
      originalName: 'jd.txt',
      companyName: 'Acme',
      roleTitle: 'Backend Engineer',
    });
    expect(t.jobs.jobs).toHaveLength(1);
  });

  it('sets the company and role of an existing target, owner only', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const created = await asha
      .call('post', '/jobs')
      .send({ source: 'URL', url: 'https://jobs.example.com/1' });
    const id = created.body.data.id as string;
    const role = await RoleModel.findOne({ slug: 'data-analyst' }).lean();

    await ravi.call('patch', `/jobs/${id}`).send({ companyName: 'Evil' }).expect(404);
    const res = await asha
      .call('patch', `/jobs/${id}`)
      .send({ companyName: ' Globex ', roleId: String(role!._id) })
      .expect(200);
    expect(res.body.data).toMatchObject({
      companyName: 'Globex',
      role: { id: String(role!._id), title: 'Data Analyst' },
      roleTitle: 'Data Analyst',
      source: 'URL',
    });
    // Omitted fields are cleared.
    const cleared = await asha.call('patch', `/jobs/${id}`).send({}).expect(200);
    expect(cleared.body.data).toMatchObject({ companyName: null, role: null, roleTitle: null });
    await asha
      .call('patch', `/jobs/${id}`)
      .send({ roleId: '64b7f3c2a1b2c3d4e5f60718' })
      .expect(400);
  });

  it('keeps a role on role-only targets', async () => {
    const { call } = await candidate();
    const created = await call('post', '/jobs').send({ source: 'ROLE_ONLY', roleTitle: 'SRE' });
    await call('patch', `/jobs/${created.body.data.id}`).send({ companyName: 'Acme' }).expect(400);
  });

  it('reports a queue outage instead of leaving the input silently stuck', async () => {
    const { call } = await candidate();
    t.jobs.state.fail = true;
    const res = await call('post', '/jobs').send({ source: 'PASTE', text: JD_TEXT }).expect(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('library search (public)', () => {
  it('finds active roles by title or alias and hides inactive ones', async () => {
    const find = (q: string) =>
      request(t.app).get('/api/v1/roles').query({ q }).set('Origin', TEST_ORIGIN).expect(200);
    expect((await find('node.js')).body.data.map((r: { slug: string }) => r.slug)).toEqual([
      'backend-engineer',
    ]);
    await RoleModel.updateOne({ slug: 'backend-engineer' }, { $set: { active: false } });
    expect((await find('backend')).body.data).toEqual([]);
    // Regex metacharacters are matched literally.
    expect((await find('.*')).body.data).toEqual([]);
  });

  it('lists companies without internal fields', async () => {
    const res = await request(t.app)
      .get('/api/v1/companies')
      .set('Origin', TEST_ORIGIN)
      .expect(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('interviews', () => {
  async function readyTarget(call: Awaited<ReturnType<typeof candidate>>['call']) {
    const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
    const res = await call('post', '/jobs').send({
      source: 'ROLE_ONLY',
      roleId: String(role!._id),
    });
    return res.body.data.id as string;
  }

  it('creates a draft on the default template and starts analysis', async () => {
    const { call } = await candidate();
    const jobTargetId = await readyTarget(call);
    const created = await call('post', '/interviews').send({ jobTargetId }).expect(201);
    const draft = InterviewSummary.parse(created.body.data);
    expect(draft).toMatchObject({
      state: 'DRAFT',
      mode: 'TEXT',
      language: 'auto',
      title: 'Backend Engineer',
      template: { name: 'Standard practice interview', modes: expect.arrayContaining(['TEXT']) },
    });

    const analysing = await call('post', `/interviews/${draft.id}/analyze`).expect(202);
    expect(analysing.body.data.state).toBe('ROLE_ANALYSIS');
    expect(t.jobs.jobs).toEqual([{ kind: 'analyze', id: draft.id, attempt: 1 }]);
    // A repeated click is a no-op while analysis runs.
    await call('post', `/interviews/${draft.id}/analyze`).expect(202);
    expect(t.jobs.jobs).toHaveLength(1);
  });

  it('refuses inputs that failed extraction and other users’ inputs', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const jobTargetId = await readyTarget(asha.call);
    await ravi.call('post', '/interviews').send({ jobTargetId }).expect(404);

    await JobTargetModel.updateOne(
      { _id: jobTargetId },
      { $set: { 'extraction.status': 'FAILED' } },
    );
    const res = await asha.call('post', '/interviews').send({ jobTargetId }).expect(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  it('only allows setup in READY and only for available modes', async () => {
    const { call } = await candidate();
    const draft = (await call('post', '/interviews').send({ jobTargetId: await readyTarget(call) }))
      .body.data;
    await call('patch', `/interviews/${draft.id}/setup`)
      .send({ mode: 'TEXT', language: 'hi' })
      .expect(409);

    await InterviewSessionModel.updateOne({ _id: draft.id }, { $set: { state: 'READY' } });
    // Video arrives in Phase 8.
    await call('patch', `/interviews/${draft.id}/setup`)
      .send({ mode: 'VIDEO', language: 'hi' })
      .expect(400);
    const ok = await call('patch', `/interviews/${draft.id}/setup`)
      .send({ mode: 'TEXT', language: 'hi' })
      .expect(200);
    expect(ok.body.data).toMatchObject({ mode: 'TEXT', language: 'hi', state: 'READY' });
  });

  it('retries a failed analysis as a new job and caps attempts', async () => {
    const { call } = await candidate();
    const draft = (await call('post', '/interviews').send({ jobTargetId: await readyTarget(call) }))
      .body.data;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await call('post', `/interviews/${draft.id}/analyze`).expect(202);
      await InterviewSessionModel.updateOne(
        { _id: draft.id },
        { $set: { state: 'FAILED', failure: { code: 'AI_UNAVAILABLE', at: new Date() } } },
      );
    }
    expect(new Set(t.jobs.jobs.map((j) => (j.kind === 'analyze' ? j.attempt : 0))).size).toBe(5);
    const res = await call('post', `/interviews/${draft.id}/analyze`).expect(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  it('marks the session FAILED when analysis cannot be enqueued', async () => {
    const { call } = await candidate();
    const draft = (await call('post', '/interviews').send({ jobTargetId: await readyTarget(call) }))
      .body.data;
    t.jobs.state.fail = true;
    await call('post', `/interviews/${draft.id}/analyze`).expect(503);
    const saved = (await call('get', `/interviews/${draft.id}`)).body.data;
    expect(saved).toMatchObject({ state: 'FAILED', failure: { code: 'INTERNAL' } });
  });

  it('cancels drafts but never another user’s', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const draft = (
      await asha.call('post', '/interviews').send({ jobTargetId: await readyTarget(asha.call) })
    ).body.data;
    await ravi.call('post', `/interviews/${draft.id}/cancel`).expect(404);
    await ravi.call('get', `/interviews/${draft.id}`).expect(404);
    expect((await ravi.call('get', '/interviews')).body.data).toEqual([]);
    const res = await asha.call('post', `/interviews/${draft.id}/cancel`).expect(200);
    expect(res.body.data.state).toBe('CANCELLED');
    await asha.call('post', `/interviews/${draft.id}/analyze`).expect(409);
  });
});
