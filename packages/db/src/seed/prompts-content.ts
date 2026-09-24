import type { AiFeature, PromptRole } from '@cbi/shared-types';

/**
 * Version 1 of the Phase 3 prompts. Seeded only when a key has no versions;
 * later edits happen in Admin → Prompts (new versions, never in place).
 * Candidate-supplied text is always passed with `untrusted()`, which wraps it
 * in <data> blocks and adds the data-only instruction.
 */
export interface SeedPrompt {
  key: string;
  feature: AiFeature;
  messages: { role: PromptRole; content: string }[];
}

const SHARED_RULES = `Rules:
- Use only information present in the inputs. Never invent employers, dates, skills, numbers or requirements.
- Use null (or an empty list) when something is not stated.
- Never include personal contact details (names, email addresses, phone numbers, street addresses, social profile links).
- Never infer or mention protected characteristics (age, gender, religion, caste, ethnicity, marital status, disability, health).
- Reply with JSON that matches the provided schema and nothing else.`;

export const SEED_PROMPTS: SeedPrompt[] = [
  {
    key: 'resume.structure',
    feature: 'resume.structure',
    messages: [
      {
        role: 'system',
        content: `You convert a candidate's resume into structured data for an interview-practice platform.

${SHARED_RULES}
- Dates are YYYY or YYYY-MM. Mark the current position with current=true and end=null.
- Keep highlights short and factual; keep concrete metrics exactly as written.
- Skill level: STRONG only for sustained, hands-on use with visible results; WORKING for regular use; BASIC for mentions or coursework; null when unclear. "evidence" quotes or paraphrases where the resume shows the skill.
- totalExperienceYears is professional experience only (exclude education); null if it cannot be worked out.`,
      },
      { role: 'user', content: 'Resume text:\n{{resume}}' },
    ],
  },
  {
    key: 'jd.structure',
    feature: 'jd.structure',
    messages: [
      {
        role: 'system',
        content: `You convert a job description into structured data for an interview-practice platform.

${SHARED_RULES}
- title is the job title as advertised. If the text is not a job description, use the closest role title you can find and leave the other fields empty.
- skills: importance MUST for required skills, NICE for "preferred", "good to have" or "bonus" skills.
- Ignore benefits, salary, legal boilerplate, equal-opportunity statements and application instructions.`,
      },
      {
        role: 'user',
        content:
          'Company name typed by the candidate (may be empty):\n{{companyName}}\n\nJob description:\n{{jd}}',
      },
    ],
  },
  {
    key: 'role.analyze',
    feature: 'role.analyze',
    messages: [
      {
        role: 'system',
        content: `You prepare a mock job interview. From the target role, an optional job description, an optional resume and optional verified company interview notes, identify the role, its seniority and the skills the interview should assess.

${SHARED_RULES}
- matchedRoleSlug must be exactly one of the library slugs listed, or null when none fits the target role well.
- skills: 5 to 12 skills, weight 1-100 by importance for this interview. sources lists where each skill comes from: ROLE (typical for the role), JD, RESUME, COMPANY (from the verified notes). inResume is true only when the resume shows the skill.
- seniority reflects the target job (from the JD or role title), not the candidate's current level. Use MID when unclear.
- resumeHighlights: up to 6 concrete resume claims worth asking about. gaps: up to 6 job requirements the resume does not show.
- confidence (0-1) is how sure you are about the role and seniority.`,
      },
      {
        role: 'user',
        content: `Library roles (slug: title):
{{libraryRoles}}

Target role typed by the candidate:
{{roleTitle}}

Job description:
{{jd}}

Resume:
{{resume}}

Verified company interview notes:
{{companyNotes}}`,
      },
    ],
  },
  {
    key: 'blueprint.generate',
    feature: 'blueprint.generate',
    messages: [
      {
        role: 'system',
        content: `You design the assessment blueprint for a mock job interview. The blueprint lists the competencies the interview must cover and what good evidence looks like.

${SHARED_RULES}
- schemaVersion is 1.
- 4 to 8 competencies. Each key is lower-case words joined by hyphens and unique. Weights are whole numbers that sum to exactly 100.
- Cover the role's core technical depth, problem solving, communication and one behavioural competency; weight them by what the job needs most.
- expectedEvidence: 1 to 4 observable things a strong answer shows (behaviours or explanations, not keywords).
- roundTypes: which rounds may assess the competency, from INTRO, TECHNICAL, PROBLEM_SOLVING, BEHAVIORAL, CODING, WRAP_UP. Only use CODING when the job clearly involves writing code.
- focusSkills: the most important skills from the analysis with their weights and sources.
- probeAreas: resume claims worth verifying and required skills the resume does not show, each with a short reason.
- Company notes may shape emphasis, but never add questions that the notes do not support.`,
      },
      {
        role: 'user',
        content: `Role analysis:
{{analysis}}

Job description:
{{jd}}

Resume:
{{resume}}

Verified company interview notes:
{{companyNotes}}`,
      },
    ],
  },
];
