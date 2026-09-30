import {
  defaultFontDir,
  fontsAvailable,
  pdfSafe,
  registerScriptFonts,
  STANDARD_FONTS,
  writeScriptText,
  type Style,
} from '@cbi/pdf-fonts';
import {
  DELIVERY_TARGETS,
  INTEGRITY_NOTE,
  STAR_PARTS,
  type AssessmentPanel,
  type ReportContent,
} from '@cbi/shared-types';
import PDFDocument from 'pdfkit';
import { outputLanguage, type OutputLanguage } from './language.js';
import { REPORT_DISCLAIMER } from './report-content.js';
import { fill, pdfMessages } from './report-messages.js';

/** `REPORT_FONT_DIR`, else the fonts shipped with @cbi/pdf-fonts. */
export function fontDir(): string {
  return process.env.REPORT_FONT_DIR || defaultFontDir();
}

/** English band labels (certificates are issued in English). */
export const BAND_LABELS = pdfMessages('en').bands;

export { fontsAvailable, pdfSafe };

export type TextWriter = (
  text: string,
  style: Style,
  size: number,
  opts?: PDFKit.Mixins.TextOptions,
) => PDFKit.PDFDocument;

/**
 * Registers the embedded fonts on `doc` (when `dir` is set) and returns a
 * writer for one paragraph: a run per script, chained with `continued` so
 * lines still wrap. Without fonts it writes {@link pdfSafe} text in the
 * standard fonts. Shared by reports and certificates.
 */
export function createTextWriter(doc: PDFKit.PDFDocument, dir: string | null): TextWriter {
  if (dir !== null) registerScriptFonts(doc, dir);
  return (t, style, size, opts = {}) => {
    if (dir === null) return doc.fontSize(size).font(STANDARD_FONTS[style]).text(pdfSafe(t), opts);
    return writeScriptText(doc, t, style, size, opts);
  };
}

/** Long text cut at a word boundary for the compact PDF. */
const clip = (t: string, max: number) =>
  t.length <= max
    ? t
    : `${t.slice(0, t.lastIndexOf(' ', max) > 0 ? t.lastIndexOf(' ', max) : max)}...`;

const date = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '-');

export interface RenderOptions {
  /** Font directory; null forces the standard-font fallback. Defaults to {@link fontDir}. */
  fontDir?: string | null;
  /** Compress page streams (tests turn it off to inspect the output). */
  compress?: boolean;
  /** The language of headings and labels; defaults to {@link reportLanguage}. */
  language?: OutputLanguage;
}

/**
 * The language of the PDF's fixed text: the session's language, or for an
 * automatic one the script the report's summary was written in (the summary
 * is written in the candidate's output language).
 */
export function reportLanguage(content: ReportContent): OutputLanguage {
  return outputLanguage(content.header.language, [content.summary]);
}

/**
 * Renders the readiness report as an A4 PDF, its headings and labels in the
 * report's language (English, Hindi or Telugu; the fallback fonts print
 * English ones). With the embedded fonts present any mix of English, Hindi
 * and Telugu renders; without them (or if shaping
 * fails on some unusual text) it falls back to the standard fonts and
 * {@link pdfSafe}, so a report always gets a PDF.
 */
export async function renderReportPdf(
  content: ReportContent,
  options: RenderOptions = {},
): Promise<Buffer> {
  const dir = options.fontDir === undefined ? fontDir() : options.fontDir;
  const language = options.language ?? reportLanguage(content);
  // The standard fonts cannot print Hindi or Telugu labels: English ones then.
  if (dir === null || !fontsAvailable(dir)) return render(content, null, options, 'en');
  try {
    return await render(content, dir, options, language);
  } catch {
    return render(content, null, options, 'en');
  }
}

function render(
  content: ReportContent,
  dir: string | null,
  options: RenderOptions,
  language: OutputLanguage,
) {
  const m = pdfMessages(language);
  return new Promise<Buffer>((resolve, reject) => {
    const embedded = dir !== null;
    const title = `${m.title} - ${content.header.title}`;
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      compress: options.compress ?? true,
      // Info strings are written as UTF-16 when needed, so only the fallback needs pdfSafe.
      info: { Title: embedded ? title : pdfSafe(title) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const write = createTextWriter(doc, dir);

    const h1 = (t: string) => write(t, 'bold', 18).moveDown(0.3);
    const h2 = (t: string) => {
      doc.moveDown(0.8);
      return write(t, 'bold', 13).moveDown(0.3);
    };
    const p = (t: string, size = 10) => write(t, 'regular', size).moveDown(0.2);
    const bullet = (t: string) => write(`- ${t}`, 'regular', 10, { indent: 10 }).moveDown(0.1);

    const { header, overall } = content;
    h1(m.title);
    p(
      header.companyName
        ? fill(m.atCompany, { title: header.title, company: header.companyName })
        : header.title,
      12,
    );
    p(
      `${m.date}: ${date(header.endedAt ?? header.startedAt)}   ${m.mode}: ${m.modes[header.mode]}   ${m.duration}: ${fill(m.minutes, { n: Math.round(header.durationSec / 60) })}`,
    );

    h2(m.overall);
    p(
      `${overall.score === null ? m.noOverall : `${overall.score} / 100`} - ${m.bands[overall.band]}`,
      12,
    );
    p(`${m.confidence}: ${m.confidenceLevels[overall.confidence.level]}`);
    if (content.benchmark) {
      const b = content.benchmark;
      p(
        fill(m.benchmark, {
          percentile: b.percentile,
          sample: b.sampleSize,
          role: b.roleTitle ?? b.family ?? '-',
          days: b.windowDays,
        }),
      );
    }
    p(content.summary);

    h2(m.dimensions);
    for (const d of content.dimensions) {
      write(
        `${d.name}: ${d.score === null ? m.notAssessed : `${d.score} / 100`} (${m.weight} ${d.weight}%)`,
        'bold',
        10,
      );
      if (d.rationale) p(d.rationale, 9);
      for (const e of d.evidence.slice(0, 2)) bullet(e.claim);
      doc.moveDown(0.3);
    }

    if (content.strengths.length) {
      h2(m.strengths);
      content.strengths.forEach((s) => bullet(s.text));
    }
    if (content.gaps.length) {
      h2(m.gaps);
      content.gaps.forEach((g) => bullet(g.text));
    }

    h2(m.plan);
    for (const [label, items] of [
      [m.next24h, content.plan.next24h],
      [m.next3Days, content.plan.next3Days],
      [m.next7Days, content.plan.next7Days],
    ] as const) {
      write(label, 'bold', 10);
      items.forEach((i) => bullet(`${i.action} (${i.why})`));
      doc.moveDown(0.2);
    }

    if (content.questions?.length) {
      h2(m.answers);
      for (const q of content.questions) {
        write(`Q${q.seq}. ${clip(q.question, 220)}`, 'bold', 10);
        p(`${m.verdict}: ${m.verdicts[q.verdict]}`, 9);
        if (q.star) {
          const covered = STAR_PARTS.filter((part) => q.star![part]).map((x) => m.starParts[x]);
          const missing = STAR_PARTS.filter((part) => !q.star![part]).map((x) => m.starParts[x]);
          p(
            fill(m.starLine, { covered: covered.join(', ') || m.starNone }) +
              (missing.length ? fill(m.starMissing, { missing: missing.join(', ') }) : ''),
            9,
          );
        }
        q.whatWorked.slice(0, 2).forEach((w) => bullet(`${m.worked}: ${w}`));
        q.missing
          .slice(0, 2)
          .forEach((x) => bullet(`${q.fallback ? m.cover : m.missingLabel}: ${x}`));
        if (q.improvedAnswer) {
          write(`${m.example}: ${clip(q.improvedAnswer, 700)}`, 'italic', 9);
        }
        doc.moveDown(0.4);
      }
      if (content.structure) {
        const st = content.structure;
        p(
          fill(m.structureSummary, { complete: st.complete, total: st.behaviouralAnswers }) +
            (st.weakest
              ? fill(m.structureWeakest, { part: m.starParts[st.weakest].toLowerCase() })
              : ''),
        );
      }
    }

    if (content.delivery) {
      const d = content.delivery.summary;
      const target = { min: DELIVERY_TARGETS.wpm.min, max: DELIVERY_TARGETS.wpm.max };
      h2(m.delivery);
      p(
        fill(m.deliveryLine, {
          wpm: d.wpm ?? '-',
          ...target,
          fillers: d.fillerCount,
          rate: d.fillerRate,
          hedges: d.hedgeCount,
        }) + (d.longPauses !== null ? fill(m.longPauses, { n: d.longPauses }) : ''),
      );
      content.delivery.tips.forEach((tip) => bullet(fill(m.deliveryTips[tip], target)));
      write(m.deliveryNote, 'italic', 8).fontSize(10);
    }

    if (content.previous) {
      h2(m.progress);
      p(
        fill(m.previousOverall, {
          score: content.previous.overall ?? '-',
          date: date(content.previous.endedAt),
        }),
      );
      content.previous.deltas.forEach((d) =>
        bullet(`${d.name}: ${d.delta > 0 ? '+' : ''}${d.delta}`),
      );
    }

    if (content.coding?.length) {
      h2(m.coding);
      for (const c of content.coding) {
        const outcome = c.judgeUnavailable
          ? m.judgeUnavailable
          : c.passed !== null
            ? fill(m.testsPassed, { passed: c.passed, total: c.total ?? '-' })
            : m.noSolution;
        bullet(
          `${c.title} (${m.difficulties[c.difficulty]}${c.language ? `, ${c.language}` : ''}${c.aiAssisted ? `, ${m.aiAssisted}` : ''}): ${outcome}${c.submitted ? '' : ` - ${m.notSubmitted}`}`,
        );
      }
    }

    // Panels are reported beside the dimensions, never in the overall score.
    const panel = (title: string, x: AssessmentPanel) => {
      h2(title);
      write(m.panelNote, 'italic', 8).fontSize(10);
      if (x.fallback) {
        p(m.panelUnavailable);
        return;
      }
      p(
        `${x.score === null ? m.notScored : `${x.score} / 100`}${x.subjects.length ? ` - ${x.subjects.join(', ')}` : ''}`,
        11,
      );
      if (x.summary) p(x.summary, 9);
      for (const d of x.dimensions) {
        write(`${d.name}: ${d.score === null ? m.notAssessed : `${d.score} / 100`}`, 'bold', 10);
        if (d.rationale) p(d.rationale, 9);
      }
    };
    if (content.systemDesign) panel(m.systemDesign, content.systemDesign);
    if (content.aiCollaboration) panel(m.aiCollaboration, content.aiCollaboration);

    if (content.integrity) {
      h2(m.observations);
      const counts = Object.entries(content.integrity.counts).filter(
        ([type]) => type !== 'TAB_VISIBLE' && type !== 'WINDOW_FOCUS',
      );
      if (counts.length === 0) p(m.noObservations);
      counts.forEach(([type, n]) => bullet(`${m.integrity[type] ?? type}: ${n}`));
      if (content.integrity.awaySec > 0) {
        bullet(fill(m.timeAway, { n: Math.round(content.integrity.awaySec / 60) }));
      }
      // The standard note and disclaimer are shown in the report's language.
      const note =
        content.integrity.note === INTEGRITY_NOTE ? m.integrityNote : content.integrity.note;
      write(note, 'italic', 8).fontSize(10);
    }

    doc.moveDown(1);
    write(
      content.disclaimer === REPORT_DISCLAIMER ? m.disclaimer : content.disclaimer,
      'italic',
      8,
    );
    doc.end();
  });
}
