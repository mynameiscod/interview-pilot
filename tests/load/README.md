# Load test (k6)

200 concurrent text interviews with mock AI providers. Each simulated candidate starts an interview over HTTP, joins the Socket.IO room, answers questions, and ends the interview. The runner then waits for every report.

```sh
corepack pnpm infra:up && corepack pnpm build
node tests/load/run.mjs --vus 200 --answers 4
```

Requirements: [k6](https://k6.io) on `PATH` (or `K6_BIN`), plus MongoDB and Redis from the dev stack. The runner uses its own database (`cbi_interview_load`) and Redis DB 14, and drops both when it finishes.

- `run.mjs`: starts the compiled API and worker, seeds candidates and tokens, runs k6, and checks the evaluation queue.
- `interview.k6.js`: the scenario. It speaks engine.io v4 frames over a raw WebSocket and fails on any threshold breach.
- `profiled-api.mjs`: runs the API so that a CPU profile is written on Windows too.

Options (environment variables):

- `LOAD_PROFILE=<dir>`: CPU profile of the API.
- `LOAD_ELD=1`: event-loop delay.
- `LOAD_DB_PROFILE=1 LOAD_SLOWMS=200`: slow MongoDB operations.
- `LOAD_PING=1`: MongoDB round-trip times.
- `LOAD_LOGS=1 LOG_LEVEL=info`: API logs.
- `DEBUG_WS=1`: raw socket frames.

Results and interpretation: [docs/performance/load-test.md](../../docs/performance/load-test.md).
