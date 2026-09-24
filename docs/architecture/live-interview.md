# The live interview (text)

Phase 4 runs the interview itself: the session state machine, the question planner, the realtime room, reconnect and resume, and the credits that pay for an interview. Voice and video (Phases 7–8) reuse all of it; only the transport of questions and answers changes.

## Parts

| Part                           | Where                                      | Does                                                                                                                                           |
| ------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| State machine, planner, clock  | `@cbi/interview-engine`                    | Pure functions, no I/O. `transition(state, event, context) → (state, effects)`, `nextStep(planner, blueprint, elapsed)`, clock and usage rules |
| Event runner, credits          | `@cbi/db` (`applySessionEvent`, `credits`) | Applies one engine event and its database effects in a MongoDB transaction, conditional on the session's `stateVersion`                        |
| Live service and realtime room | `apps/api` (`modules/live`, `realtime.ts`) | Starts and ends interviews, runs each turn under a Redis lock, talks to the candidate over Socket.IO                                           |
| Sweep                          | `apps/worker` (`live-sweep`)               | Time-based transitions nobody's action triggers: silent rooms, the reconnect grace period, the resume window, stuck finishes                   |
| Text room                      | `apps/candidate-web`                       | Start, room and completion screens                                                                                                             |

## Session states

```text
READY ──PREPARE──▶ READY_TO_START ──START──▶ ACTIVE ◀──NEXT_ROUND── ROUND_TRANSITION
  (text: no device check or consent)   (reserve credit,  │  ROUND_ENDED (more rounds) ─────────▲
                                        start clock)     │  ROUND_ENDED (last round), END_REQUESTED, TIME_UP
                                                         ▼
      RECONNECTING ◀──DISCONNECTED── ACTIVE          COMPLETING ──FINALIZE──▶ PROCESSING (Phase 5 evaluates)
        │ RECONNECTED → back                               (consume the credit if meaningful, otherwise refund)
        │ GRACE_EXPIRED (10 min)
        ▼
      PAUSED ──RESUME──▶ back to ACTIVE
        │ RESUME_WINDOW_EXPIRED (24 h): settle the credit
        ▼
      EXPIRED ──PROCESS (only if meaningful)──▶ PROCESSING
Any in-progress state ──FAIL──▶ FAILED (the credit is refunded)
```

- The full table (all 16 states × 21 events) is in `packages/interview-engine/src/session-machine.ts`. The tests check it against an independently written specification for every state, event and context combination (about 64,000 cases), prove every state is reachable and can still finish, and run thousands of random walks checking that a credit is reserved at most once, settled at most once and only after being reserved, and that the clock runs exactly while the interview is live.
- Effects are data (`RESERVE_CREDIT`, `PAUSE_CLOCK`, `START_NEXT_ROUND`, …). `applySessionEvent` carries out the database ones in the same transaction as the state change. `ENQUEUE_EVALUATION` is returned to the caller; evaluation arrives in Phase 5, so sessions wait in `PROCESSING` until then.
- **One live interview per candidate**: in-progress states set `live: true`, and a partial unique index on `{userId}` allows one such session.
- `stateHistory` keeps the last 50 transitions; every candidate action is also in `auditLogs`.

## The clock

The server is authoritative. The clock (`{budgetMs, activeMs, runningSince}`) runs only in `ACTIVE` and `ROUND_TRANSITION`, so reconnecting, pauses and server restarts never use up the candidate's time. The budget is the sum of the template's round durations. Each round has its own budget, measured from the clock reading when it started. The room shows `remainingMs` and counts down locally, resynchronising on every snapshot.

## Planning questions

For the active round the planner (`nextStep`) returns either a question target or "end the round":

1. **Follow-up first.** If the last assessment asked for a follow-up and the round's `followUpDepth` allows it, the next question follows up on the same thread, even in the round's last minute. A non-answer never gets a follow-up.
2. **End the round** when its primary question count is reached, its time is up, or less than a minute is left.
3. **Otherwise pick a competency** that this round assesses (by `roundTypes`, falling back to categories), least-covered first, then heaviest. After the first technical question, resume and JD **probe areas** from the blueprint are used once each.
4. **Difficulty**: fixed per round, or `ADAPTIVE`: one step up after a strong answer and one step down after a weak one or a non-answer.

The target carries the objective, expected evidence, source (`ROLE`, `JD`, `RESUME`, `COMPANY`, `FOLLOW_UP`) and follow-up depth. These are stored with the question in `interviewTurns`, which is the question ledger that evaluation (Phase 5) reads.

## A turn

```text
candidate: answer:text {questionId, text, clientMsgId}
API (Redis lock cbi:lock:turn:<session>, shared by every replica):
  duplicate clientMsgId?          → ack {duplicate: true}
  not the current question?       → STALE_QUESTION
  save the answer (conditional on answer = null)
  interview.assessTurn            → sufficiency, followUpNeeded, followUpAngle, evidence (internal only)
  planner.recordAssessment        → coverage, follow-up thread
  advance: next step → round change / finish / interview.question → save turn + plan atomically → emit interview:question
```

- **Bounded context.** The question prompt receives the round, objective, competency, difficulty and expected evidence, the analysis highlights and gaps, the last 15 questions (to avoid repeats) and, for a follow-up, only the question and answer it builds on. It never receives the whole transcript. Everything the candidate wrote is passed through `untrusted()` data blocks.
- **AI outages do not stop the interview.** If question generation fails, a templated question for the target is used (`fallbackQuestion`). If the assessment fails, the answer counts as adequate with no follow-up, and the turn is flagged `fallback: true` so Phase 5 re-evaluates it. An empty answer counts as `NO_ANSWER` without an AI call.
- **Nothing scored is sent live.** Snapshots and events contain questions, answers, rounds and time only.

## Realtime protocol (`/rt`)

Socket.IO on the API port, path `/socket.io`, WebSocket first with long-polling as the fallback, and the Redis adapter so any API replica can emit to any room. The handshake sends the candidate's access token (`auth.token`); an expired token fails with `TOKEN_EXPIRED` and the client refreshes and reconnects.

| Direction | Event                 | Payload                                      | Notes                                                                         |
| --------- | --------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| C→S       | `interview:join`      | `{sessionId, lastSeq}`                       | Ack carries the snapshot (turns after `lastSeq`). Resumes RECONNECTING/PAUSED |
| C→S       | `answer:text`         | `{sessionId, questionId, text, clientMsgId}` | Idempotent per `clientMsgId` (unique index on the turn)                       |
| C→S       | `presence:heartbeat`  | `{sessionId}`                                | Every 10 s; also ends the interview when its time is up                       |
| S→C       | `interview:thinking`  | `{sessionId}`                                | The next question is being prepared                                           |
| S→C       | `interview:question`  | `LiveQuestion`                               |                                                                               |
| S→C       | `round:transition`    | `{fromRoundIdx, toRoundIdx, toRoundType}`    |                                                                               |
| S→C       | `interview:completed` | `InterviewSnapshot`                          | State `PROCESSING`                                                            |
| S→C       | `server:draining`     | `{}`                                         | The instance is shutting down; the client reconnects to another               |

Every client event is acknowledged with `{ok: true, …}` or `{ok: false, code, message}` (`NOT_FOUND`, `INVALID_STATE`, `STALE_QUESTION`, `BUSY`, `VALIDATION_FAILED`, `INTERNAL`). `GET /interviews/:id/live` returns the same snapshot over REST.

## Reconnect and resume

- When the candidate's last socket for a session closes (checked across replicas with `fetchSockets`), the session moves to `RECONNECTING` and the clock stops. Joining again resumes it (`RECONNECTED`) and returns the turns after the client's `lastSeq`. A pending answer is simply resent with the same `clientMsgId`.
- If the API instance itself dies, the worker sweep notices the missing heartbeats (45 s) and moves the session to `RECONNECTING`.
- After 10 minutes the sweep pauses the interview; the candidate can still resume it for 24 hours or end it early. After 24 hours it expires: a meaningful interview goes on to evaluation and consumes its credit, otherwise the credit is refunded.
- On deploys, the old API instance emits `server:draining`, closes its sockets (which pauses the affected interviews) and clients reconnect to the new one, which rebuilds everything from MongoDB.

The reconnect end-to-end tests (`apps/api/src/modules/live/live.integration.test.ts`) run a real HTTP server and Socket.IO clients against MongoDB and Redis: answer, drop the connection, check the clock stopped, reconnect with `lastSeq`, and continue; pause after the grace period and resume; end early with a refund; and a complete 11-question interview through all five rounds that consumes the credit.

## Credits

| Operation          | Ledger entry                                                   | Idempotency key     |
| ------------------ | -------------------------------------------------------------- | ------------------- |
| Welcome credit     | `FREE_GRANT` +1 (a new lot, no expiry)                         | `free:<userId>`     |
| Start              | `INTERVIEW_RESERVE` −1 available, +1 reserved                  | `reserve:<session>` |
| Meaningful finish  | `INTERVIEW_CONSUME` −1 reserved                                | `settle:<session>`  |
| Early end, failure | `INTERVIEW_REFUND` +1 available, −1 reserved (back to its lot) | `settle:<session>`  |

- The ledger is append-only (the model rejects updates and deletes) and authoritative. `creditAccounts` is a projection updated in the same transaction and can be rebuilt with `recomputeCreditAccount`.
- Consume and refund share one key, so an interview's credit is settled exactly once however many times an event is retried. Reservations use the earliest-expiring lot; expired lots never count.
- **Meaningful** means at least 3 answered questions, or at least 40 % of the time budget used (and at least one answer). Ending early or a platform failure refunds the credit.
- The welcome credit is granted the first time the candidate's balance is read or they start an interview. Purchases arrive in Phase 6.

API: `GET /credits/balance`, `GET /credits/ledger`, `POST /interviews/:id/start` (402 `INSUFFICIENT_CREDITS`, 409 when another interview is in progress), `POST /interviews/:id/end`.

## Configuration

| Setting                          | Default           | Meaning                                             |
| -------------------------------- | ----------------- | --------------------------------------------------- |
| `WORKER_LIVE_SWEEP_INTERVAL_MS`  | 15000             | How often the worker checks live interview timeouts |
| `LIVE_POLICY.reconnectGraceMs`   | 10 min            | RECONNECTING → PAUSED (shared-types constant)       |
| `LIVE_POLICY.resumeWindowMs`     | 24 h              | PAUSED → EXPIRED                                    |
| `LIVE_POLICY.heartbeatTimeoutMs` | 45 s              | No heartbeat for this long counts as disconnected   |
| `DEFAULT_USAGE_POLICY`           | 3 answers or 40 % | Meaningful usage (engine constant)                  |
