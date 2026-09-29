import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  headTags,
  jsonForScript,
  PRODUCTION_ORIGIN,
  readColorToken,
  renderPageHtml,
  robotsTxt,
  seoPages,
  type SeoSite,
  sitemapXml,
  webManifest,
} from './seo';

const strings = {
  productName: 'CareerPilot Interview',
  endorsement: 'by CodeBegun',
  tagline: 'AI interview practice by CodeBegun',
  homeDescription: 'Take a realistic AI interview.',
  pricingTitle: 'Pricing',
  pricingDescription: 'Buy interview credits.',
  faq: [
    { question: 'Is it free?', answer: 'Yes, one credit is free.' },
    { question: 'Tags like </script>?', answer: 'Escaped & safe.' },
  ],
};
// Tests run from apps/candidate-web.
const tokensScss = readFileSync('../../packages/design-system/src/styles/_tokens.scss', 'utf8');
const SITE_NAME = 'CareerPilot Interview by CodeBegun';
const production: SeoSite = { origin: PRODUCTION_ORIGIN, indexable: true };
const staging: SeoSite = { origin: 'https://interview-staging.codebegun.com', indexable: false };

const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="description"
      content="Default description"
    />
    <title>Default title</title>
    <script type="module" src="/assets/index.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map(
    (m) => JSON.parse(m[1]!) as Record<string, unknown>,
  );
}

describe('seoPages', () => {
  const [home, pricing] = seoPages(strings, PRODUCTION_ORIGIN);

  it('describes the home and pricing pages', () => {
    expect(home).toMatchObject({
      path: '/',
      file: 'index.html',
      title: 'CareerPilot Interview — AI interview practice by CodeBegun',
      description: 'Take a realistic AI interview.',
    });
    expect(pricing).toMatchObject({
      path: '/pricing',
      file: 'pricing/index.html',
      title: 'Pricing — CareerPilot Interview by CodeBegun',
      description: 'Buy interview credits.',
    });
  });

  it('builds FAQPage data from the FAQ copy, only for the home page', () => {
    const faq = home!.jsonLd.find((d) => (d as { '@type': string })['@type'] === 'FAQPage');
    expect(faq).toMatchObject({
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Is it free?',
          acceptedAnswer: { '@type': 'Answer', text: 'Yes, one credit is free.' },
        },
        expect.anything(),
      ],
    });
    expect(pricing!.jsonLd.map((d) => (d as { '@type': string })['@type'])).toEqual([
      'Organization',
      'SoftwareApplication',
    ]);
  });
});

describe('renderPageHtml', () => {
  const [home, pricing] = seoPages(strings, PRODUCTION_ORIGIN);

  it('replaces the title and description and adds canonical, social tags and JSON-LD', () => {
    const html = renderPageHtml(TEMPLATE, pricing!, production, SITE_NAME);
    expect(html).toContain('<title>Pricing — CareerPilot Interview by CodeBegun</title>');
    expect(html).not.toContain('Default title');
    expect(html).not.toContain('Default description');
    expect(html).toContain('<meta name="description" content="Buy interview credits." />');
    expect(html).toContain(
      '<link rel="canonical" href="https://interview.codebegun.com/pricing" />',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://interview.codebegun.com/pricing" />',
    );
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('noindex');
    expect(html.indexOf('application/ld+json')).toBeLessThan(html.indexOf('</head>'));
    // The app bundle stays in place.
    expect(html).toContain('<script type="module" src="/assets/index.js"></script>');
  });

  it('embeds JSON-LD that parses back and cannot close the script element early', () => {
    const html = renderPageHtml(TEMPLATE, home!, production, SITE_NAME);
    const data = jsonLd(html);
    expect(data.map((d) => d['@type'])).toEqual(['Organization', 'SoftwareApplication', 'FAQPage']);
    expect(JSON.stringify(data[2])).toContain('Tags like </script>?');
    expect(html).not.toContain('Tags like </script>');
  });

  it('adds the social image when available and noindex outside production', () => {
    const html = renderPageHtml(
      TEMPLATE,
      home!,
      { ...staging, ogImage: '/brand/og-image.png' },
      SITE_NAME,
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://interview-staging.codebegun.com/brand/og-image.png" />',
    );
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it('escapes page text in attributes', () => {
    const tags = headTags(
      { ...home!, title: 'A "quoted" <title>', description: 'x & y' },
      production,
      SITE_NAME,
    );
    expect(tags[0]).toBe('<title>A &quot;quoted&quot; &lt;title&gt;</title>');
    expect(tags[1]).toBe('<meta name="description" content="x &amp; y" />');
  });

  it('fails loudly when the template has no title to replace', () => {
    expect(() =>
      renderPageHtml('<html><head></head></html>', home!, production, SITE_NAME),
    ).toThrow(/<title>/);
  });
});

describe('robots.txt and sitemap.xml', () => {
  it('lets production crawlers see public pages only and points at the sitemap', () => {
    const robots = robotsTxt(production);
    expect(robots).toContain('Allow: /\n');
    for (const path of ['/app$', '/app/', '/onboarding', '/login', '/campaign/', '/proof/']) {
      expect(robots).toContain(`Disallow: ${path}\n`);
    }
    expect(robots).toContain('Sitemap: https://interview.codebegun.com/sitemap.xml');
  });

  it('blocks everything outside production', () => {
    expect(robotsTxt(staging)).toBe('User-agent: *\nDisallow: /\n');
  });

  it('lists the public pages', () => {
    const xml = sitemapXml(production);
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1])).toEqual([
      'https://interview.codebegun.com/',
      'https://interview.codebegun.com/pricing',
    ]);
  });
});

describe('web manifest', () => {
  it('uses the design-token colours', () => {
    const primary = readColorToken(tokensScss, 'primary');
    const background = readColorToken(tokensScss, 'background');
    expect(primary).toMatch(/^#[0-9a-f]{6}$/);
    const manifest = JSON.parse(
      webManifest({
        name: SITE_NAME,
        shortName: 'CareerPilot Interview',
        description: 'd',
        themeColor: primary,
        backgroundColor: background,
        icons: [],
      }),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: SITE_NAME,
      short_name: 'CareerPilot Interview',
      start_url: '/',
      display: 'standalone',
      theme_color: primary,
      background_color: background,
      icons: [],
    });
  });

  it('rejects an unknown token', () => {
    expect(() => readColorToken(tokensScss, 'no-such-token')).toThrow(/no-such-token/);
  });
});

describe('jsonForScript', () => {
  it('escapes characters that could end the script element', () => {
    expect(jsonForScript({ a: '</script><!--&' })).toBe(
      '{"a":"\\u003c/script\\u003e\\u003c!--\\u0026"}',
    );
  });
});
