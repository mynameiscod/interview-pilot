# System design rounds

A template can include a `SYSTEM_DESIGN` round (optional; the seeded **System design practice interview** has one). The round opens with a design prompt; the candidate sketches the design on a whiteboard and fills in structured notes, then submits it, and the interviewer asks follow-up probes about that design.

- Contracts: [`packages/shared-types/src/design.ts`](../../packages/shared-types/src/design.ts)
- API: [`apps/api/src/modules/design/`](../../apps/api/src/modules/design/)
- Room: [`apps/candidate-web/src/features/design/`](../../apps/candidate-web/src/features/design/)
- Evaluation: [`apps/worker/src/evaluation/panels.ts`](../../apps/worker/src/evaluation/panels.ts)

## The design bank

`designPrompts` holds append-only versions per `key`, one active per key: title, prompt, difficulty, tags, **focus areas** (shown to the candidate) and **considerations** (the rubric; never sent to candidates). Eight original prompts are seeded with the same versioned rules as the problem bank (short links, exam results day, notifications, API rate limiting, food-order tracking, a wallet ledger, cab dispatch, group chat). Admins manage them under **Library → System design prompts**.

The round's first question picks an active prompt at the round's difficulty (or any), avoiding the candidate's last 5 prompts, deterministically per interview and round. With an empty bank the round asks ordinary questions.

## In the room

`LiveQuestion.design` marks the design question; the snapshot's `designQuestionId` names the current round's design question.

| Endpoint                                 | What it does                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `GET /interviews/:id/design/:questionId` | The prompt (without the rubric), notes, diagram, autosave and submission |
| `PUT …`                                  | Autosave (every 5 s and when leaving a note)                             |
| `POST …/submit`                          | Saves, locks the design and answers the question (idempotent retry)      |

- **Whiteboard**: a plain SVG boxes-and-arrows editor (up to 40 boxes of 8 kinds and 80 labelled arrows). Boxes are dragged or moved with the arrow keys; everything is also listed as text with its own controls. It loads lazily (about 5 KB gzip) and loads nothing from other origins, so the existing CSP needs no change. Excalidraw was not used: even lazy-loaded it is well over 1 MB and fetches fonts and assets from a CDN by default.
- **Notes**: requirements, API, data model, scaling and reliability, trade-offs (up to 4000 characters each).
- Typed or spoken answers to the design question are refused; the design is its answer (`designAnswerText`: the notes by section and the diagram as text).
- After submitting, the rest of the round are **probes**: each is written by the `interview.designProbe` prompt (feature `interview.question`) from the notes, a text version of the diagram (`diagramText`) and the round's earlier probes and answers, all as data. A templated probe is used when the model is unavailable. The submitted design stays viewable (read-only) beside the probes.

## Evaluation

- A design that was saved but not submitted before time ran out is read as the answer, labelled as not submitted.
- The ordinary evidence extraction reads the design answer and the probe answers.
- A **system design panel** (`evaluation.systemDesign`) scores requirements, API and interfaces, data model and storage, scaling and reliability, and trade-offs (0–100 each) against the prompt's considerations, with quotes from the notes, diagram or answers (quotes that do not appear there are dropped). It is shown in the report and PDF beside the dimensions, is **not** part of the overall score, and is kept unscored when the model is unavailable.
