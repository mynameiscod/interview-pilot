import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AuditLogModel,
  ensureLibraryCatalog,
  IntegrityEventModel,
  InterviewSessionModel,
  InterviewTemplateModel,
  JobTargetModel,
  MediaAssetModel,
  RoleBlueprintModel,
  RoleModel,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import {
  AdminIntegrityEvent,
  AdminMediaAsset,
  MediaAssetSummary,
  PlaybackUrl,
  RT_NAMESPACE,
  RtEvent,
  SessionConsents,
  type AdminRole,
  type DeviceCheckBody,
  type InterviewSnapshot,
  type RtAck,
} from '@cbi/shared-types';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRealtime } from '../../realtime.js';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';
import { bootstrapAi } from '../ai/ai-bootstrap.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;
let server: Server;
let realtime: Awaited<ReturnType<typeof createRealtime>>;
let baseUrl: string;
const sockets: Socket[] = [];

beforeEach(async () => {
  t = await buildTestApp({ redis });
  await bootstrapAi({
    env: t.env,
    ai: t.container.ai,
    audit: t.container.audit,
    logger: t.container.logger,
  });
  await ensureLibraryCatalog();
  server = createServer(t.app);
  realtime = await createRealtime({ server, container: t.container, redis });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await realtime.close();
});

type Method = 'get' | 'post' | 'delete';

async function candidate(email = 'asha@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: Method, path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { accessToken, userId: String(user.id), call };
}
type Call = Awaited<ReturnType<typeof candidate>>['call'];

async function adminAs(roles: AdminRole[], email = `${roles[0]!.toLowerCase()}@codebegun.com`) {
  const user = await UserModel.create({ primaryEmail: email, adminRoles: roles });
  await UserProfileModel.create({ userId: user._id });
  const { accessToken } = await signInWithEmail(t.app, t.email.sent, email, 'admin');
  return (method: Method, path: string) =>
    request(t.app)
      [method](`/api/v1/admin${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
}

/** A READY interview on the standard template, or on a copy with a different proctoring policy. */
async function readyInterview(
  userId: string,
  mode: 'TEXT' | 'VOICE' | 'VIDEO',
  policy?: { recording: 'OFF' | 'OPTIONAL' | 'REQUIRED'; tabSwitchTracking: boolean },
) {
  let template = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
  if (policy) {
    const [copy] = await InterviewTemplateModel.create([
      {
        key: `policy-${policy.recording}-${policy.tabSwitchTracking}`,
        version: 1,
        status: 'ACTIVE',
        content: { ...template!.content, proctoringPolicy: policy },
      },
    ]);
    template = copy!.toObject();
  }
  const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
  const blueprint = await RoleBlueprintModel.findById(role!.activeBlueprintId).lean();
  const target = await JobTargetModel.create({
    userId,
    source: 'ROLE_ONLY',
    roleId: role!._id,
    roleTitle: role!.title,
    extraction: { status: 'READY' },
  });
  const s = await InterviewSessionModel.create({
    userId,
    jobTargetId: target._id,
    templateId: template!._id,
    blueprintId: blueprint!._id,
    state: 'READY',
    mode,
  });
  return String(s._id);
}

const check = (overrides: Partial<DeviceCheckBody> = {}): DeviceCheckBody => ({
  microphone: 'PASS',
  recorder: 'PASS',
  speaker: 'PASS',
  network: 'PASS',
  speechService: 'PASS',
  mimeType: 'audio/webm;codecs=opus',
  camera: 'PASS',
  videoMimeType: 'video/webm;codecs=vp8,opus',
  rttMs: 90,
  browser: 'Chrome 140',
  ...overrides,
});

async function consents(call: Call, id: string) {
  return SessionConsents.parse(
    (await call('get', `/interviews/${id}/consents`).expect(200)).body.data,
  );
}

/** Decides every consent: accepted unless listed in `decline`. */
async function decide(call: Call, id: string, decline: string[] = []) {
  const current = await consents(call, id);
  const res = await call('post', `/interviews/${id}/consents`)
    .send({
      decisions: current.items.map((i) => ({
        consentTextId: i.text.id,
        accepted: !decline.includes(i.type),
      })),
    })
    .expect(200);
  return SessionConsents.parse(res.body.data);
}

async function startVideo(call: Call, id: string, decline: string[] = []) {
  await call('post', `/interviews/${id}/device-check`).send(check()).expect(200);
  await decide(call, id, decline);
  await call('post', `/interviews/${id}/start`).expect(200);
}

/** A MediaRecorder-like WebM stream split into segments (only the first has the header). */
const segments = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    Buffer.concat([
      i === 0 ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) : Buffer.alloc(0),
      Buffer.from(`cluster-${i}-`.repeat(50)),
    ]),
  );

const upload = (call: Call, id: string, idx: number, body: Buffer) =>
  call('post', `/interviews/${id}/media/segments/${idx}`)
    .set('Content-Type', 'video/webm')
    .send(body);

async function join(token: string, sessionId: string) {
  const socket = connect(`${baseUrl}${RT_NAMESPACE}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const ack = (await socket
    .timeout(15_000)
    .emitWithAck(RtEvent.JOIN, { sessionId, lastSeq: 0 })) as RtAck;
  if (!ack.ok) throw new Error(`join failed: ${ack.code}`);
  return { socket, snapshot: ack.snapshot as InterviewSnapshot };
}

describe('consents', () => {
  it('asks each mode for what it needs and gates the start on it', async () => {
    const { userId, call } = await candidate();
    const text = await readyInterview(userId, 'TEXT');
    expect((await consents(call, text)).items).toEqual([]);

    const video = await readyInterview(userId, 'VIDEO');
    const needed = await consents(call, video);
    expect(needed.items.map((i) => [i.type, i.required])).toEqual([
      ['VOICE_PROCESSING', true],
      ['RECORDING', false], // standard templates make recording optional
    ]);
    // A video interview needs a camera.
    const noCam = await call('post', `/interviews/${video}/device-check`)
      .send(check({ camera: 'FAIL' }))
      .expect(200);
    expect(noCam.body.data).toMatchObject({ ready: false, deviceCheck: { passed: false } });
    await call('post', `/interviews/${video}/start`).expect(409);
    await call('post', `/interviews/${video}/device-check`).send(check()).expect(200);
    const started = await call('post', `/interviews/${video}/start`).expect(409);
    expect(started.body.error.message).toMatch(/consent/i);

    // Declining the optional recording still lets the interview start, without recording.
    const decided = await decide(call, video, ['RECORDING']);
    expect(decided.complete).toBe(true);
    await call('post', `/interviews/${video}/start`).expect(200);
    const s = (await InterviewSessionModel.findById(video).lean())!;
    expect(s.recording).toEqual({ enabled: false });
    await upload(call, video, 0, segments(1)[0]!).expect(409);

    // A required consent that is declined blocks the start.
    const tracked = await readyInterview(userId, 'TEXT', {
      recording: 'OFF',
      tabSwitchTracking: true,
    });
    await decide(call, tracked, ['INTEGRITY']);
    const blocked = await call('post', `/interviews/${tracked}/start`).expect(409);
    expect(blocked.body.error.message).toMatch(/consent/i);

    const history = await call('get', '/users/me/consents').expect(200);
    expect(
      history.body.data.map((h: { type: string; accepted: boolean }) => `${h.type}:${h.accepted}`),
    ).toEqual(
      expect.arrayContaining(['RECORDING:false', 'VOICE_PROCESSING:true', 'INTEGRITY:false']),
    );
    expect(await AuditLogModel.countDocuments({ action: 'interview.consent' })).toBe(2);
  });

  it('asks again after an admin activates a new version of a text', async () => {
    const { userId, call } = await candidate();
    const id = await readyInterview(userId, 'VOICE');
    await call('post', `/interviews/${id}/device-check`)
      .send(check({ camera: null }))
      .expect(200);
    expect((await decide(call, id)).complete).toBe(true);

    const root = await adminAs(['SUPER_ADMIN']);
    const created = await root('post', '/consent-texts')
      .send({
        type: 'VOICE_PROCESSING',
        locale: 'en',
        title: 'Speaking your answers (updated)',
        body: 'Your recorded answers are sent to our speech providers to create transcripts.',
        reason: 'Legal review',
      })
      .expect(201);
    expect(created.body.data).toMatchObject({ version: 2, active: false });
    const content = await adminAs(['CONTENT_ADMIN']);
    await content('get', '/consent-texts').expect(200);
    await content('post', `/consent-texts/${created.body.data.id}/activate`)
      .send({ reason: 'x'.repeat(5) })
      .expect(403);
    await root('post', `/consent-texts/${created.body.data.id}/activate`)
      .send({ reason: 'Approved' })
      .expect(200);

    const again = await consents(call, id);
    expect(again).toMatchObject({
      complete: false,
      items: [{ text: { version: 2 }, decision: null }],
    });
    await call('post', `/interviews/${id}/start`).expect(409);
  });
});

describe('recording upload resilience', () => {
  it('survives storage failures, retries and lost segments without affecting the interview', async () => {
    const { userId, accessToken, call } = await candidate();
    const id = await readyInterview(userId, 'VIDEO');
    await startVideo(call, id);
    const { snapshot } = await join(accessToken, id);
    expect(snapshot).toMatchObject({ mode: 'VIDEO', recording: true, voiceEnabled: true });

    const parts = segments(5);
    await upload(call, id, 0, parts[0]!).expect(201);
    await upload(call, id, 1, parts[1]!).expect(201);

    // Storage is down for one request: the segment is refused with 503 and the browser retries.
    const realPut = t.storage.storage.put.bind(t.storage.storage);
    let failNext = true;
    t.storage.storage.put = async (key, body, type) => {
      if (failNext) {
        failNext = false;
        throw new Error('storage unavailable');
      }
      return realPut(key, body, type);
    };
    const failed = await upload(call, id, 2, parts[2]!).expect(503);
    expect(failed.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    await upload(call, id, 2, parts[2]!).expect(201);
    // A retry of an acknowledged segment (lost response) is a harmless duplicate.
    const dup = await upload(call, id, 2, parts[2]!).expect(200);
    expect(dup.body.data).toMatchObject({ duplicate: true, received: 3 });
    // Different bytes for a stored index are refused.
    await upload(call, id, 2, parts[3]!).expect(409);
    // Segment 3 never arrives (the tab lost it); 4 does.
    await upload(call, id, 4, parts[4]!).expect(201);
    // Uploads never touched the interview.
    expect((await InterviewSessionModel.findById(id).lean())!.state).toBe('ACTIVE');

    // The candidate ends early; the recording is closed as PARTIAL.
    await call('post', `/interviews/${id}/end`).expect(200);
    const fin = await call('post', `/interviews/${id}/media/finalize`)
      .send({ segmentCount: 5, durationMs: 50_000 })
      .expect(200);
    expect(MediaAssetSummary.parse(fin.body.data)).toMatchObject({
      status: 'PARTIAL',
      missingSegments: [3],
      segmentCount: 4,
    });
    // The queued segment arrives later, within the grace period: now COMPLETE.
    await upload(call, id, 3, parts[3]!).expect(201);
    const mine = MediaAssetSummary.parse((await call('get', `/interviews/${id}/media`)).body.data);
    expect(mine).toMatchObject({ status: 'COMPLETE', missingSegments: [], segmentCount: 5 });

    // Playback: a signed link streams the segments in order as one file.
    const link = PlaybackUrl.parse(
      (await call('get', `/interviews/${id}/media/playback-url`)).body.data,
    );
    const played = await request(t.app)
      .get(link.url)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(played.headers['content-type']).toBe('video/webm');
    expect(Buffer.compare(played.body as Buffer, Buffer.concat(parts))).toBe(0);
    await request(t.app)
      .get(link.url.replace(/sig=[^&]+/, 'sig=forged'))
      .expect(403);
    await request(t.app)
      .get(link.url.replace(/exp=\d+/, 'exp=1'))
      .expect(403);

    // Another candidate cannot see or delete it.
    const other = await candidate('ravi@example.com');
    await other.call('get', `/interviews/${id}/media`).expect(404);

    // The candidate deletes it: objects removed, link dead, record kept as evidence.
    const deleted = await call('delete', `/interviews/${id}/media`).expect(200);
    expect(deleted.body.data.deletion).toMatchObject({
      status: 'DELETED',
      reason: 'Deleted by the candidate',
    });
    expect([...t.storage.objects.keys()].filter((k) => k.startsWith('media/'))).toEqual([]);
    await request(t.app).get(link.url).expect(404);
  });

  it('never fails the interview when every upload fails', async () => {
    const { userId, accessToken, call } = await candidate();
    const id = await readyInterview(userId, 'VIDEO');
    await startVideo(call, id);
    await join(accessToken, id);
    t.storage.storage.put = async () => {
      throw new Error('storage down');
    };
    for (const [i, part] of segments(3).entries()) await upload(call, id, i, part).expect(503);
    const ended = await call('post', `/interviews/${id}/end`).expect(200);
    expect(['PROCESSING', 'EXPIRED', 'COMPLETING']).toContain(ended.body.data.state);
    const fin = await call('post', `/interviews/${id}/media/finalize`)
      .send({ segmentCount: 3, durationMs: 30_000 })
      .expect(200);
    expect(fin.body.data).toMatchObject({ status: 'FAILED', segmentCount: 0 });
  });

  it('closes uploads after the grace period and rejects foreign formats', async () => {
    const { userId, call } = await candidate();
    const id = await readyInterview(userId, 'VIDEO');
    await startVideo(call, id);
    await call('post', `/interviews/${id}/media/segments/0`)
      .set('Content-Type', 'video/webm')
      .send(Buffer.from('%PDF-1.7 not a video'))
      .expect(415);
    await call('post', `/interviews/${id}/media/segments/0`)
      .set('Content-Type', 'text/plain')
      .send('hello')
      .expect(415);
    await call('post', `/interviews/${id}/end`).expect(200);
    await InterviewSessionModel.updateOne(
      { _id: id },
      { $set: { endedAt: new Date(Date.now() - 31 * 60_000) } },
    );
    await upload(call, id, 0, segments(1)[0]!).expect(409);
  });
});

describe('integrity observations and admin', () => {
  it('stores observations only when tracked and acknowledged, and shows them to admins', async () => {
    const { userId, accessToken, call } = await candidate();
    const id = await readyInterview(userId, 'VIDEO', {
      recording: 'REQUIRED',
      tabSwitchTracking: true,
    });
    const needed = await consents(call, id);
    expect(needed.items.map((i) => [i.type, i.required])).toEqual([
      ['VOICE_PROCESSING', true],
      ['RECORDING', true],
      ['INTEGRITY', true],
    ]);
    await startVideo(call, id);
    const { socket, snapshot } = await join(accessToken, id);
    expect(snapshot.integrityTracking).toBe(true);
    const at = new Date().toISOString();
    for (const type of ['TAB_HIDDEN', 'TAB_VISIBLE', 'PASTE']) {
      const ack = (await socket
        .timeout(5000)
        .emitWithAck(RtEvent.INTEGRITY, { sessionId: id, type, at, value: 1200 })) as RtAck;
      expect(ack).toEqual({ ok: true });
    }
    const bad = (await socket
      .timeout(5000)
      .emitWithAck(RtEvent.INTEGRITY, { sessionId: id, type: 'CHEATING', at })) as RtAck;
    expect(bad).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    // A burst beyond 5 a second is dropped.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        socket
          .timeout(5000)
          .emitWithAck(RtEvent.INTEGRITY, { sessionId: id, type: 'WINDOW_BLUR', at }),
      ),
    );
    expect(await IntegrityEventModel.countDocuments({ sessionId: id })).toBeLessThanOrEqual(8);

    await upload(call, id, 0, segments(1)[0]!).expect(201);
    await call('post', `/interviews/${id}/media/finalize`)
      .send({ segmentCount: 1, durationMs: 9000 })
      .expect(200);

    const support = await adminAs(['SUPPORT_ADMIN']);
    await support('get', '/media').expect(403);
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const list = z
      .array(AdminMediaAsset)
      .parse((await ops('get', '/media?q=asha@example.com').expect(200)).body.data);
    expect(list).toHaveLength(1);
    const events = z
      .array(AdminIntegrityEvent)
      .parse((await ops('get', `/interviews/${id}/integrity`).expect(200)).body.data);
    expect(events.slice(0, 3).map((e) => e.type)).toEqual(['TAB_HIDDEN', 'TAB_VISIBLE', 'PASTE']);

    const link = await ops('post', `/media/${list[0]!.id}/playback`).expect(200);
    await request(t.app).get(link.body.data.url).expect(200);
    expect(await AuditLogModel.countDocuments({ action: 'media.playback' })).toBe(1);
    const purged = await ops('post', `/media/${list[0]!.id}/purge`)
      .send({ reason: 'Data request' })
      .expect(200);
    expect(purged.body.data.deletion).toMatchObject({ status: 'DELETED', reason: 'Data request' });
    await ops('post', `/media/${list[0]!.id}/purge`).send({ reason: 'Again' }).expect(409);
    expect((await MediaAssetModel.findById(list[0]!.id).lean())!.segments).toEqual([]);
    expect(await AuditLogModel.countDocuments({ action: 'media.purged' })).toBe(1);
  });
});
