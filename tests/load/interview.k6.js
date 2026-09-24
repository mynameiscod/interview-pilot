// k6 scenario: N candidates each start a text interview over HTTP, join the
// Socket.IO room (engine.io v4 frames over a raw WebSocket), answer a few
// questions, then end the interview. Run through tests/load/run.mjs, which
// seeds the data and passes DATA_FILE.
import http from 'k6/http';
import ws from 'k6/ws';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const API = __ENV.API;
const ORIGIN = __ENV.ORIGIN;
const VUS = Number(__ENV.VUS || 200);
const ANSWERS = Number(__ENV.ANSWERS || 4);
const users = JSON.parse(open(__ENV.DATA_FILE));

const startLatency = new Trend('interview_start_ms', true);
const joinLatency = new Trend('room_join_ms', true);
const questionLatency = new Trend('next_question_ms', true);
const answerAck = new Trend('answer_ack_ms', true);
const completed = new Rate('interview_flow_completed');
const wsErrors = new Counter('ws_errors');

export const options = {
  scenarios: {
    interviews: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '15m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    interview_start_ms: ['p(95)<2000'],
    room_join_ms: ['p(95)<1500'],
    answer_ack_ms: ['p(95)<1000'],
    // Mock AI answers instantly; this measures the platform (planner, ledger, Mongo, Redis).
    next_question_ms: ['p(95)<3000'],
    interview_flow_completed: ['rate>0.99'],
    ws_errors: ['count<1'],
  },
};

// Each candidate has their own address (behind NGINX, which sets X-Forwarded-For).
const ip = () => `10.${Math.floor(exec.vu.idInTest / 250)}.${exec.vu.idInTest % 250}.7`;
const headers = (token) => ({
  headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip() },
});

export default function () {
  const me = users[exec.vu.idInTest - 1];
  // Spread arrivals over the first 20 s, like candidates arriving, not a single spike.
  sleep(Math.random() * 20);

  const res = http.post(`${API}/api/v1/interviews/${me.sessionId}/start`, null, headers(me.token));
  startLatency.add(res.timings.duration);
  if (!check(res, { 'start 200': (r) => r.status === 200 })) {
    completed.add(false);
    fail(`start ${res.status} ${res.body}`);
  }

  const url = `${API.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket`;
  let answered = 0;
  let ackId = 0;
  let joinSentAt = 0;
  let answerSentAt = 0;
  let waitingForQuestion = false;
  let done = false;
  const pending = new Map();

  const result = ws.connect(
    url,
    { headers: { Origin: ORIGIN, 'X-Forwarded-For': ip() } },
    (socket) => {
      const emit = (event, payload, onAck) => {
        ackId += 1;
        pending.set(ackId, onAck);
        socket.send(`42/rt,${ackId}${JSON.stringify([event, payload])}`);
      };

      const answer = (question) => {
        answerSentAt = Date.now();
        emit(
          'answer:text',
          {
            sessionId: me.sessionId,
            questionId: question.questionId,
            text: `Answer ${answered + 1}: I designed an idempotent payments API, added indexes for the hot queries and cut p95 latency by 40% after load testing.`,
            clientMsgId: `load-${exec.vu.idInTest}-${answered + 1}`.padEnd(12, '0'),
          },
          (ack) => {
            answerAck.add(Date.now() - answerSentAt);
            if (!ack || !ack.ok) {
              console.warn(`answer rejected: ${JSON.stringify(ack)}`);
              wsErrors.add(1);
              socket.close();
              return;
            }
            answered += 1;
            waitingForQuestion = answered < ANSWERS;
            if (!waitingForQuestion) finish();
          },
        );
      };

      const finish = () => {
        done = true;
        socket.close();
      };

      const seen = new Set();
      const onQuestion = (question) => {
        // The join snapshot and the pushed event can carry the same question: answer it once.
        if (seen.has(question.questionId)) return;
        seen.add(question.questionId);
        if (waitingForQuestion) {
          questionLatency.add(Date.now() - answerSentAt);
          waitingForQuestion = false;
        }
        if (!done && answered < ANSWERS) {
          // Candidate "thinking" time before answering.
          socket.setTimeout(() => answer(question), 1000 + Math.random() * 2000);
        }
      };

      socket.on('message', (msg) => {
        if (__ENV.DEBUG_WS) console.log('<<', msg.slice(0, 160));
        if (msg === '2') {
          socket.send('3'); // engine.io ping → pong
        } else if (msg.startsWith('0')) {
          socket.send(`40/rt,${JSON.stringify({ token: me.token })}`);
        } else if (msg.startsWith('40/rt,')) {
          joinSentAt = Date.now();
          emit('interview:join', { sessionId: me.sessionId, lastSeq: 0 }, (ack) => {
            joinLatency.add(Date.now() - joinSentAt);
            if (!ack || !ack.ok) {
              console.warn(`join rejected: ${JSON.stringify(ack)}`);
              wsErrors.add(1);
              socket.close();
              return;
            }
            if (ack.snapshot && ack.snapshot.currentQuestion)
              onQuestion(ack.snapshot.currentQuestion);
          });
        } else if (msg.startsWith('44/rt,')) {
          wsErrors.add(1);
          socket.close();
        } else if (msg.startsWith('43/rt,')) {
          const m = /^43\/rt,(\d+)(.*)$/.exec(msg);
          const cb = m && pending.get(Number(m[1]));
          if (cb) {
            pending.delete(Number(m[1]));
            cb(JSON.parse(m[2])[0]);
          }
        } else if (msg.startsWith('42/rt,')) {
          const [event, payload] = JSON.parse(msg.slice(6));
          if (event === 'interview:question') onQuestion(payload);
          if (event === 'interview:error') {
            console.warn(`room error: ${JSON.stringify(payload)}`);
            wsErrors.add(1);
          }
        }
      });
      socket.on('error', () => wsErrors.add(1));
      socket.setTimeout(
        () => {
          if (!done) {
            console.warn(`timed out after ${answered} answers`);
            wsErrors.add(1);
            socket.close();
          }
        },
        Number(__ENV.WS_TIMEOUT_MS || 240000),
      );
    },
  );
  check(result, { 'ws upgraded': (r) => r && r.status === 101 });

  const end = http.post(`${API}/api/v1/interviews/${me.sessionId}/end`, null, headers(me.token));
  check(end, { 'end 200': (r) => r.status === 200 });
  completed.add(done && end.status === 200);
}
