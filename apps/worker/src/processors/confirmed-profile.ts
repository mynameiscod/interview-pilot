import type { JdStructured, ResumeStructured } from '@cbi/shared-types';

/**
 * Candidate-edited revisions as text for prompts. Analysis and tailoring put
 * them ahead of the extracted text, marked as the candidate's own
 * corrections, so the model prefers them where the two disagree. The result
 * is untrusted text: callers mask it and pass it through `untrusted()`.
 */

const range = (e: ResumeStructured['experience'][number]) =>
  [e.start ?? '?', e.current ? 'present' : (e.end ?? '?')].join(' to ');

export function resumeRevisionText(r: ResumeStructured): string {
  const lines: string[] = [];
  if (r.headline) lines.push(`Headline: ${r.headline}`);
  if (r.totalExperienceYears !== null)
    lines.push(`Total experience: ${r.totalExperienceYears} years`);
  if (r.skills.length) lines.push(`Skills: ${r.skills.map((s) => s.name).join(', ')}`);
  for (const e of r.experience) {
    lines.push(
      `Experience: ${e.title}${e.organization ? ` at ${e.organization}` : ''} (${range(e)})`,
    );
    for (const h of e.highlights) lines.push(`  - ${h}`);
  }
  for (const p of r.projects) {
    const tech = p.technologies.length ? ` [${p.technologies.join(', ')}]` : '';
    lines.push(`Project: ${p.name}${p.summary ? `: ${p.summary}` : ''}${tech}`);
  }
  for (const e of r.education) {
    const parts = [e.qualification, e.institution, e.year].filter(Boolean);
    lines.push(`Education: ${parts.join(', ')}`);
  }
  if (r.certifications.length) lines.push(`Certifications: ${r.certifications.join(', ')}`);
  return lines.join('\n');
}

export function jdRevisionText(j: JdStructured): string {
  const must = j.skills.filter((s) => s.importance === 'MUST').map((s) => s.name);
  const nice = j.skills.filter((s) => s.importance === 'NICE').map((s) => s.name);
  const lines = [`Title: ${j.title}`];
  if (j.seniority) lines.push(`Seniority: ${j.seniority}`);
  if (j.experienceYears?.min != null || j.experienceYears?.max != null) {
    lines.push(
      `Experience: ${j.experienceYears?.min ?? '?'} to ${j.experienceYears?.max ?? '?'} years`,
    );
  }
  if (must.length) lines.push(`Must-have skills: ${must.join(', ')}`);
  if (nice.length) lines.push(`Nice-to-have skills: ${nice.join(', ')}`);
  for (const r of j.responsibilities) lines.push(`Responsibility: ${r}`);
  return lines.join('\n');
}

/**
 * The candidate's revision first (when there is one), then as much of the
 * extracted text as fits in `maxChars`.
 */
export function withRevision(revision: string | null, raw: string, maxChars: number): string {
  if (!revision) return raw.slice(0, maxChars);
  const head =
    `Corrections confirmed by the candidate (prefer these where they differ from the text below):\n${revision}`.slice(
      0,
      maxChars,
    );
  const room = maxChars - head.length - 2;
  return room > 0 && raw ? `${head}\n\n${raw.slice(0, room)}` : head;
}
