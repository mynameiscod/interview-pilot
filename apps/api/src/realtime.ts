import type { Server as HttpServer } from 'node:http';
import { AccessTokenError } from '@cbi/auth-core';
import type { Redis } from '@cbi/db';
import {
  AnswerTextPayload,
  HeartbeatPayload,
  JoinPayload,
  RT_NAMESPACE,
  RtEvent,
  type RtAck,
} from '@cbi/shared-types';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, type Socket } from 'socket.io';
import type { Container } from './container.js';
import { LiveError, roomOf } from './modules/live/live.service.js';

interface SocketData {
  userId: string;
  sessionId: string | null;
}

type Ack = (response: RtAck) => void;

/**
 * Realtime interview room (design §5.1). Clients authenticate with their
 * candidate access token in the handshake. Every event is acknowledged;
 * state lives in MongoDB, so any replica can serve a reconnecting client.
 */
export async function createRealtime(opts: {
  server: HttpServer;
  container: Container;
  /** Redis for the adapter (duplicated for pub/sub); omit for a single process (tests). */
  redis?: Redis;
}) {
  const { container: c } = opts;
  const io = new Server(opts.server, {
    path: '/socket.io',
    // WebSocket first, long-polling as the fallback (NGINX ip_hash keeps polling sticky).
    transports: ['websocket', 'polling'],
    cors: { origin: c.env.CORS_ALLOWED_ORIGINS, credentials: true },
    maxHttpBufferSize: 64 * 1024,
    serveClient: false,
  });
  let pub: Redis | null = null;
  let sub: Redis | null = null;
  if (opts.redis) {
    pub = opts.redis.duplicate();
    sub = opts.redis.duplicate();
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
  }
  const rt = io.of(RT_NAMESPACE);
  c.rooms.attach((room, event, payload) => rt.to(room).emit(event, payload));

  rt.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string') throw new Error('missing token');
      const claims = await c.tokens.verify(token, 'candidate');
      const state = await c.userState.get(claims.userId);
      if (!state || state.tokenVersion !== claims.tokenVersion || state.status !== 'ACTIVE') {
        throw new Error('session ended');
      }
      (socket.data as SocketData) = { userId: claims.userId, sessionId: null };
      next();
    } catch (err) {
      const expired = err instanceof AccessTokenError && err.reason === 'expired';
      next(
        Object.assign(new Error(expired ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED'), {
          data: { code: 'UNAUTHENTICATED' },
        }),
      );
    }
  });

  const fail = (ack: Ack | undefined, err: unknown) => {
    if (err instanceof LiveError) return ack?.({ ok: false, code: err.code, message: err.message });
    if ((err as { name?: string })?.name === 'ZodError') {
      return ack?.({ ok: false, code: 'VALIDATION_FAILED', message: 'Invalid message.' });
    }
    if ((err as { status?: number })?.status === 404) {
      return ack?.({ ok: false, code: 'NOT_FOUND', message: 'Interview not found' });
    }
    c.logger.error({ err }, 'realtime handler failed');
    ack?.({ ok: false, code: 'INTERNAL', message: 'Something went wrong. Please try again.' });
  };

  rt.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;

    socket.on(RtEvent.JOIN, async (raw: unknown, ack?: Ack) => {
      try {
        const payload = JoinPayload.parse(raw);
        const room = roomOf(payload.sessionId);
        const previous = data.sessionId;
        // Join the room before reading the snapshot: a question saved after the read is then
        // still delivered as an event (clients de-duplicate by seq), so nothing falls in between.
        await socket.join(room);
        let snapshot;
        try {
          snapshot = await c.live.join(data.userId, payload.sessionId, payload.lastSeq);
        } catch (err) {
          if (previous !== payload.sessionId) await socket.leave(room);
          throw err;
        }
        if (previous && previous !== payload.sessionId) await socket.leave(roomOf(previous));
        data.sessionId = payload.sessionId;
        ack?.({ ok: true, snapshot });
      } catch (err) {
        fail(ack, err);
      }
    });

    socket.on(RtEvent.ANSWER_TEXT, async (raw: unknown, ack?: Ack) => {
      try {
        const payload = AnswerTextPayload.parse(raw);
        if (payload.sessionId !== data.sessionId)
          throw new LiveError('INVALID_STATE', 'Join the interview first.');
        const { duplicate } = await c.live.answer(data.userId, payload);
        ack?.({ ok: true, duplicate });
      } catch (err) {
        fail(ack, err);
      }
    });

    socket.on(RtEvent.HEARTBEAT, async (raw: unknown, ack?: Ack) => {
      try {
        const payload = HeartbeatPayload.parse(raw);
        if (payload.sessionId !== data.sessionId)
          throw new LiveError('INVALID_STATE', 'Join the interview first.');
        await c.live.heartbeat(data.userId, payload.sessionId);
        ack?.({ ok: true });
      } catch (err) {
        fail(ack, err);
      }
    });

    socket.on('disconnect', async () => {
      const sessionId = data.sessionId;
      if (!sessionId) return;
      try {
        // Another tab or a quick reconnect may still hold the room (on any replica).
        const remaining = await rt.in(roomOf(sessionId)).fetchSockets();
        if (remaining.some((s) => (s.data as SocketData).userId === data.userId)) return;
        await c.live.disconnected(sessionId);
      } catch (err) {
        c.logger.warn({ err, sessionId }, 'disconnect handling failed');
      }
    });
  });

  return {
    io,
    /** Tells clients to reconnect elsewhere, then closes (graceful deploys). */
    async close() {
      rt.emit(RtEvent.DRAINING, {});
      c.rooms.detach();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.allSettled([pub?.quit(), sub?.quit()]);
    },
  };
}
