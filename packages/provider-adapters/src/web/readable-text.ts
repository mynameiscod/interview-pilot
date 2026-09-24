import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

/** Collapses whitespace but keeps paragraph breaks. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v\u00A0\u2000-\u200B]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const STRIP = 'script, style, noscript, template, svg, iframe, object, embed';
const BLOCK = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TR',
  'UL',
]);

interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
}

/** Text of a subtree with line breaks at block boundaries (textContent runs blocks together). */
function textOf(node: DomNode): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return '';
  if (node.nodeName === 'BR') return '\n';
  let out = '';
  for (let i = 0; i < node.childNodes.length; i++) out += textOf(node.childNodes[i]!);
  return BLOCK.has(node.nodeName) ? `\n${node.nodeName === 'LI' ? '- ' : ''}${out}\n` : out;
}

/** linkedom needs a full document; bare fragments are wrapped. */
function parseDocument(html: string) {
  const full = /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><head></head><body>${html.replace(/<\/?body[^>]*>/gi, '')}</body></html>`;
  const { document } = parseHTML(full);
  for (const el of document.querySelectorAll(STRIP)) el.remove();
  return document;
}

/**
 * Main readable text of an HTML page (Mozilla Readability, as used by
 * Firefox Reader View), falling back to the whole body for short pages.
 * Scripts, styles and markup never reach the result.
 */
export function extractReadableText(html: string): { title: string | null; text: string } {
  const document = parseDocument(html);
  const title = document.title?.trim() || null;
  let text = '';
  try {
    const article = new Readability(document as never, { charThreshold: 200 }).parse();
    if (article?.content)
      text = normalizeText(textOf(parseDocument(article.content).body as unknown as DomNode));
  } catch {
    text = '';
  }
  if (text.length < 200) {
    // Short pages (plain job boards) are often better read whole.
    const fresh = parseDocument(html);
    for (const el of fresh.querySelectorAll('nav, footer, header')) el.remove();
    const body = normalizeText(textOf((fresh.body ?? fresh.documentElement) as unknown as DomNode));
    if (body.length > text.length) text = body;
  }
  return { title, text };
}
