# Resume tools

Resume tools help a candidate see and improve how their resume reads for one job, with or without an interview. They build on the input pipeline described in [inputs and role analysis](inputs-and-role-analysis.md).

| Tool                    | Where                                                      | AI?                   | Cost to the candidate            |
| ----------------------- | ---------------------------------------------------------- | --------------------- | -------------------------------- |
| Scanned-PDF OCR         | Worker, during extraction                                  | Yes (`ocr.document`)  | Free                             |
| LinkedIn import         | Worker (PDF export), `POST /resumes/text` (pasted text)    | No                    | Free                             |
| Parsed preview and edit | Wizard resume/JD steps, analysis step, `/app/resume-check` | No                    | Free                             |
| Resume match score      | Analysis step ("Resume match"), `/app/resume-check`        | No (deterministic)    | Free, rate-limited               |
| Tailoring suggestions   | Analysis step, `/app/resume-check`                         | Yes (`resume.tailor`) | Free, rate-limited + daily quota |

## Scanned PDFs (OCR)

A PDF whose text layer has fewer than 200 characters is sent, whole, to the `ocr.document` route (Claude Sonnet 5.5 PDF input, then Gemini and OpenAI file input). Details, limits (`OCR_MAX_PAGES`, `OCR_MAX_MB`, `OCR_ENABLED`) and metering are in [the provider layer](../ai/provider-layer.md#scanned-documents-ocr). The recognised text replaces the empty text layer, `extraction.ocrUsed` is set and the wizard tells the candidate an AI service read the scan so they check the parse. A scan cannot be masked before it is sent; the Privacy Notice says so (en/hi/te). When OCR is off, over the limits or unavailable, the document fails with `NO_TEXT` as before.

## Layout signals

Extraction records `layout` on each resume (`DocumentLayout`): pages, words, `tablesSuspected`, `columnsSuspected` and `imageOnly`. They are heuristics, never a rendering:

- **PDF.** Text runs are grouped into visual rows and cells (a gap wider than 8% of the page splits cells). Three or more rows with three or more cells suggest a table. A second column is a cell start shared by at least six rows in the middle band of the page, with text to its left; right-aligned dates start at different places, so they do not count. A two-column PDF is then read column by column, so sections are not interleaved line by line.
- **DOCX.** `<w:tbl>` in `word/document.xml` (after the zip-bomb checks) and section columns (`<w:cols w:num="2">`).
- **Text.** Three or more lines with two or more tab-separated cells.
- **Image-only.** No usable text layer (whether or not OCR then read it).

## LinkedIn profiles

The platform never contacts linkedin.com. Candidates either upload the profile's **Save to PDF** export or paste their profile text (`POST /resumes/text`, stored as a `.txt` resume with `source: PASTE`; the same upload limits and daily quota apply).

`parseLinkedInProfile` (`@cbi/documents`) recognises both formats: the PDF export by its "Top Skills" sidebar or profile link plus "(N years M months)" durations; pasted text by an "About" heading plus "· N yrs M mos" durations. Ordinary resumes with Experience/Education headings are not mistaken for either. It reads the summary, roles (including a company's grouped roles, in PDF and web order), education (school, degree, end year), top skills and certifications into `ResumeStructured`, computes total years with overlaps counted once, and skips the Contact block and the name. A recognised profile is structured **without an AI call** (`format: LINKEDIN`); if the parse finds no roles and no schooling, the AI structuring runs as usual. Fixtures are generated in code (`buildLinkedInProfilePdf`, `LINKEDIN_PASTED_TEXT`), with invented people and companies.

## Parsed preview and candidate edits

After a resume or JD is read, the wizard shows what was read with an **Edit** mode:

- **Resume:** headline, total years, skills as editable chips, experience entries (title, organisation, start/end as `YYYY` or `YYYY-MM`, current, highlights), education, projects (with technology chips).
- **JD:** title, seniority, must-have and nice-to-have skills as chips, responsibilities.

`PUT /resumes/:id/structured` and `PUT /jobs/:id/structured` store the whole corrected revision as `edited` (with `editedAt`) beside the AI parse, which is never overwritten; `DELETE` on the same path returns to the AI version. Only READY inputs can be edited (409 otherwise; role-only targets have nothing to edit). Each change is audited (`resume.edited`, `job_target.edited`, `…edit_reverted`). Revisions are validated with the same bounded schemas as the parse.

Everything downstream prefers the revision: role analysis puts it ahead of the extracted text as "corrections confirmed by the candidate" (and takes the JD title from it), the match score scores it, and tailoring grounds against it. It is candidate text, so it is masked and passed through `untrusted()` like the rest. A revision saved after an interview was analysed applies the next time that interview is analysed.

## Resume match score

`scoreResumeMatch` in `@cbi/scoring-core` is pure and deterministic; `POST /resume-tools/match {resumeId, jobTargetId}` computes it on request (rate limit `resumeMatch`: 60 per 10 minutes per user). No AI is called and nothing is stored.

| Component  | Max | How                                                                                                                                                                                                                            |
| ---------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Skills     | 50  | Each JD skill is looked up in the resume's skills and project technologies, then as a whole word in its text. Must-haves weigh 3, nice-to-haves 1. A JD without structured skills falls back to known skills found in its text |
| Experience | 20  | Candidate years (parsed total, else dated roles) against the JD's years (structured, else "3+ years" in the text, else the seniority's usual band). Below: pro rata. Far above the band: 16. Unknown: 10                       |
| Sections   | 15  | 3 each: contact details present (detected, never read out), summary heading, skills, experience with dates, education                                                                                                          |
| Formatting | 15  | Minus 7 image-only, 4 tables, 4 columns, 3 very long (> 3 pages or 1,500 words), 3 very short (< 150 words)                                                                                                                    |

The **alias map** covers common tech skills and their usual spellings (JS/JavaScript, TS, Node/NodeJS, Postgres/psql, k8s, Golang/Go, AWS/Amazon Web Services, CI/CD, REST/RESTful, ML, DSA, OOP, Power BI, …). Ambiguous short names ("go", "rest", "ai", "express", "spring", "excel") only match a skills-list entry, never free text, so "go-live" or "the rest of the team" do not count. A component with nothing to judge is left out and the rest are scaled to 100. Bands: 80+ strong, 65+ good, 45+ fair.

Every point is itemised as a reason (`MatchReasonCode` plus parameters); clients show one localized sentence per code. The report also says whether edited revisions were used.

## Tailoring suggestions

`POST /resume-tools/tailorings {resumeId, jobTargetId}` creates a `resumeTailorings` record and queues `resume.tailor` on the analysis queue (202). Asking again with unchanged inputs (same documents, same read and edit times) within 7 days returns the earlier record (200) instead of another billed call. Limits: `resumeTailor` 10 per hour per user and `RESUME_TAILOR_DAILY_LIMIT` (default 10) per rolling 24 hours. Records expire after 30 days, are included in the data export and are erased with the account. `GET /resume-tools/tailorings/:id` is polled until READY or FAILED.

The worker masks both documents (with the candidate's revisions first), sends them as `untrusted()` data with the must-have skills to the `resume.tailor` prompt (seeded version 1, effort `medium`), validates the reply against `ResumeTailoringAi`, then applies a deterministic **guard**:

- numbers the resume does not contain become placeholders (`[X]`, `[X%]`);
- a rewrite whose quoted original is not in the resume is dropped;
- a rewrite (or summary) naming an employer the structured resume does not list, or a tool the resume does not mention, is dropped (the summary falls back to a fact-only one); employers are checked against the structured experience rather than the free text, so a name injected into the resume body is not enough;
- the missing-keyword list comes from the deterministic match score, keeping the model's guidance where it agrees; the model's extra keywords are kept only if the resume really lacks them;
- masked personal details (`[EMAIL]`, `[NAME]`, …) are stripped.

What was changed is reported (`guardNotes`) and shown. If AI is unavailable, a **deterministic fallback** returns a summary built only from the structured facts and the missing keywords (`source: FALLBACK`).

The UI shows a visible note that suggestions are never applied, only reuse resume facts and that placeholders must be filled in or removed. The candidate copies what is true, or exports a **plain-text or Markdown draft** (the candidate's structured resume with the suggested summary and each rewrite in place of its original bullet, headed by a "review every line" notice; no DOCX library is part of the web app). Contact details are not in the structured resume and are added back by hand.

`apps/worker/src/ai-evals` runs the tailoring fixtures (`--suite=tailoring`), which fail a model that invents employers, metrics or skills; see [the evaluation suite](../ai/evaluation-regression.md#resume-tailoring---suitetailoring).

## Candidate UI

- **Wizard, resume step:** the upload box mentions LinkedIn's Save to PDF; "Or paste your resume or LinkedIn profile text"; a LinkedIn badge on recognised profiles; the parsed preview with Edit once the resume is read.
- **Wizard, JD step:** the parsed JD with Edit for uploaded and linked JDs once read.
- **Analysis step:** the JD preview with Edit (pasted JDs are created at submit time, so they are edited here), the **Resume match** panel and tailoring suggestions.
- **`/app/resume-check`** ("Resume check" in the navigation): pick any read resume and JD; the same previews, score and suggestions, no interview or credit needed.

All strings are in English, Hindi and Telugu.
