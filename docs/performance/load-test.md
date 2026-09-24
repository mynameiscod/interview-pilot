# Load test: 200 concurrent interviews (Phase 12)

The design (§14) calls for 200 concurrent interviews on one KVM 8 VPS, confirmed with k6 in the hardening phase. The load test is in [`tests/load/`](../../tests/load/). It exercises the whole interview path with mock AI providers:

1. HTTP: start the interview.
2. Socket.IO: join the room.
3. Answer 4 questions, with 1–3 s of "thinking" before each.
4. HTTP: end the interview.
5. Wait for the evaluation queue to turn every interview into a report.

## How to run

```sh
corepack pnpm infra:up           # MongoDB replica set + Redis
corepack pnpm build
node tests/load/run.mjs --vus 200 --answers 4
```

The runner does the following:

- starts the compiled API and worker on a throwaway database;
- seeds N candidates with READY text interviews through the app's own models;
- mints access tokens for them, so sign-in is not part of the test;
- runs [`interview.k6.js`](../../tests/load/interview.k6.js);
- waits for the evaluation queue to drain;
- writes k6 and queue summaries to `tests/load/results/` (gitignored).

Each simulated candidate sends its own `X-Forwarded-For` and the API trusts one hop, as it does behind NGINX, so per-IP rate limits apply to each candidate as in production. Arrivals are spread over 20 s.

Diagnostics:

- `LOAD_PROFILE=<dir>`: CPU profile of the API.
- `LOAD_ELD=1`: event-loop delay every 2 s.
- `LOAD_DB_PROFILE=1 LOAD_SLOWMS=200`: slow MongoDB operations.
- `LOAD_PING=1`: MongoDB round-trip times during the run.
- `LOAD_LOGS=1 LOG_LEVEL=info`: API logs.

## Results on the development laptop (2026-09-24)

**Machine:** Windows 11, 8 logical CPUs, 7.6 GB RAM for Docker. The API, worker, k6, and MongoDB and Redis in Docker Desktop all share the machine.

| Metric (200 candidates, 800 answers)    | Result                                 |
| --------------------------------------- | -------------------------------------- |
| Interview flows completed               | **200 / 200 (100%)**                   |
| HTTP errors / socket errors             | **0 / 0**                              |
| Room join p50 / p95                     | 0.5 s / 0.95 s                         |
| Interview start p50 / p95               | 1.1–2.9 s / 3.6–6.6 s (varies by run)  |
| Answer acknowledged p50 / p95           | 1.2–3.6 s / 2.9–6.1 s                  |
| Next question after an answer p50 / p95 | 1.2–3.7 s / 3.4–6.3 s                  |
| Evaluation queue: all 200 reports ready | 20–35 s after the last interview ended |

**Correctness holds at 200 concurrent interviews.** Every interview completed, every report was produced, and nothing failed.

**Latency on this machine is bounded by the environment, not by the API:**

- **The API is not CPU-bound.** Event-loop delay peaked at about 135 ms (p99) at the height of the run, and the API was 42% idle over the run.
- **MongoDB executes operations quickly.** At 200 concurrent interviews, only 5 operations took over 200 ms on the server.
- **Round trips are slow.** On this laptop they go through Docker Desktop's port forwarding into a VM:
  - a MongoDB ping takes 3.6 ms at idle;
  - under load it takes 6 ms at the median, 50 ms at p95 and up to 196 ms.

  A start or an answer makes dozens of sequential database round trips, so this latency adds up to seconds. On the production VPS, the API and MongoDB talk over a Docker bridge on the same Linux host, where round trips are sub-millisecond.

- **Timing matches on both sides.** The server-side response time for `/start` (p50 1.45 s, p95 3.4 s in one run) matches what k6 measured, so the time is spent waiting inside the API rather than on the client.

## What the load test changed

| Finding                                                                                                                                                       | Fix                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The MongoDB driver pool was hard-coded to 20 connections per process. Every live turn runs a short transaction, so requests queued for a connection.          | `MONGODB_MAX_POOL_SIZE` (default 100) for the API and the worker.                                                                                                    |
| With every client behind one address, the public limit (300 requests per minute per IP) turned most `/end` calls into 429s.                                   | The API must trust NGINX's hop in staging and production. Environment validation now refuses `TRUST_PROXY_HOPS=0` there. See the security review for NAT'd networks. |
| The first client double-answered a question that arrived both in the join snapshot and as a pushed event. The server correctly refused it (`STALE_QUESTION`). | Client-side fix in the scenario. The server behaviour was correct.                                                                                                   |

## Production acceptance (staging, before launch)

Run the same test against **staging on the production VPS size**, with the API and MongoDB on the same host (see [`docs/deployment/launch-checklist.md`](../deployment/launch-checklist.md)). Point `LOAD_MONGODB_URI` and `LOAD_REDIS_URL` at a staging scratch database, or run the runner on the host. Targets, which are the k6 thresholds:

- flows completed > 99%;
- HTTP errors < 1%;
- 0 socket errors;
- start p95 < 2 s;
- join p95 < 1.5 s;
- answer acknowledged p95 < 1 s;
- next question p95 < 3 s (mock AI);
- evaluation queue drains within 5 minutes.

Real AI providers add model latency on top. Watch provider health and the AI cost dashboard during a pilot.
