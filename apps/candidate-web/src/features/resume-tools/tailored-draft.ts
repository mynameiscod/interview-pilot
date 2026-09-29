import type { ResumeStructured, TailoringSuggestions } from '@cbi/shared-types';

export interface DraftLabels {
  notice: string;
  summary: string;
  skills: string;
  experience: string;
  projects: string;
  education: string;
  certifications: string;
  present: string;
}

type Line = { kind: 'entry' | 'bullet' | 'text'; value: string };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A tailored resume draft built from the candidate's own structured resume:
 * the suggested summary, and each suggested rewrite in place of the bullet it
 * rewrites. Nothing else is added. Contact details are not part of the
 * structured resume, so the candidate adds them back by hand.
 */
export function tailoredDraft(
  resume: ResumeStructured | null,
  s: TailoringSuggestions,
  labels: DraftLabels,
): { text: string; markdown: string } {
  const rewrites = new Map(s.bullets.map((b) => [norm(b.original), b.rewritten]));
  const bullet = (h: string) => rewrites.get(norm(h)) ?? h;
  const r: ResumeStructured = resume ?? {
    headline: null,
    totalExperienceYears: null,
    skills: [],
    experience: [],
    projects: [],
    education: [],
    certifications: [],
  };
  const range = (e: ResumeStructured['experience'][number]) =>
    [e.start ?? '', e.current ? labels.present : (e.end ?? '')].filter(Boolean).join(' - ');

  const sections: { title: string; lines: Line[] }[] = [];
  const add = (title: string, lines: Line[]) => lines.length && sections.push({ title, lines });
  add(labels.summary, s.summary ? [{ kind: 'text', value: s.summary }] : []);
  add(
    labels.skills,
    r.skills.length ? [{ kind: 'text', value: r.skills.map((k) => k.name).join(', ') }] : [],
  );
  add(
    labels.experience,
    r.experience.flatMap((e): Line[] => [
      {
        kind: 'entry',
        value: `${[e.title, e.organization].filter(Boolean).join(', ')}${range(e) ? ` (${range(e)})` : ''}`,
      },
      ...e.highlights.map((h): Line => ({ kind: 'bullet', value: bullet(h) })),
    ]),
  );
  add(
    labels.projects,
    r.projects.map((p): Line => ({
      kind: 'bullet',
      value: `${p.name}${p.summary ? `: ${bullet(p.summary)}` : ''}${p.technologies.length ? ` (${p.technologies.join(', ')})` : ''}`,
    })),
  );
  add(
    labels.education,
    r.education.map((e): Line => ({
      kind: 'bullet',
      value: [e.qualification, e.institution, e.year].filter(Boolean).join(', '),
    })),
  );
  add(
    labels.certifications,
    r.certifications.map((c): Line => ({ kind: 'bullet', value: c })),
  );

  const md = (l: Line) =>
    l.kind === 'entry' ? `**${l.value}**` : l.kind === 'bullet' ? `- ${l.value}` : l.value;
  const txt = (l: Line) => (l.kind === 'bullet' ? `- ${l.value}` : l.value);
  const markdown = [
    `> ${labels.notice}`,
    ...(r.headline ? ['', `# ${r.headline}`] : []),
    ...sections.flatMap((sec) => ['', `## ${sec.title}`, ...sec.lines.map(md)]),
  ].join('\n');
  const text = [
    labels.notice,
    ...(r.headline ? ['', r.headline] : []),
    ...sections.flatMap((sec) => ['', sec.title.toUpperCase(), ...sec.lines.map(txt)]),
  ].join('\n');
  return { text, markdown };
}
