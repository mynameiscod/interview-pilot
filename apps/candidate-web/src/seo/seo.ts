/**
 * Build-time SEO for the public candidate pages (pure functions, no Node or
 * DOM APIs). The Vite plugin in vite.config.ts feeds these with the English
 * copy and writes the results into dist/:
 *
 * - dist/index.html and dist/pricing/index.html with route-specific <title>,
 *   description, canonical, Open Graph / Twitter tags and JSON-LD;
 * - robots.txt, sitemap.xml and manifest.webmanifest.
 *
 * The pages stay client-rendered; only the <head> is prerendered, which is what
 * crawlers and link previews read.
 */

export const PRODUCTION_ORIGIN = 'https://interview.codebegun.com';

/** Public, indexable routes. Everything else is either private or an invite/share link. */
export const PUBLIC_PATHS = ['/', '/pricing'] as const;
export type PublicPath = (typeof PUBLIC_PATHS)[number];

/** Signed-in areas and personal links that crawlers must not index. */
export const DISALLOWED_PATHS = [
  '/app$',
  '/app/',
  '/onboarding',
  '/login',
  '/campaign/',
  '/proof/',
] as const;

export interface SeoStrings {
  productName: string;
  endorsement: string;
  tagline: string;
  homeDescription: string;
  pricingTitle: string;
  pricingDescription: string;
  faq: { question: string; answer: string }[];
}

export interface SeoPage {
  path: PublicPath;
  /** Output file relative to dist/. */
  file: string;
  title: string;
  description: string;
  jsonLd: object[];
}

export interface SeoSite {
  origin: string;
  /** Only production is indexed; staging and local builds get noindex + Disallow: /. */
  indexable: boolean;
  /** Absolute path of the social preview image, when the asset exists. */
  ogImage?: string;
}

export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}

/** The public pages with their head metadata. FAQ structured data mirrors the page copy. */
export function seoPages(strings: SeoStrings, origin: string): SeoPage[] {
  const siteName = `${strings.productName} ${strings.endorsement}`;
  const organization = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${absoluteUrl(origin, '/')}#organization`,
    name: 'CodeBegun',
    url: 'https://codebegun.com',
  };
  const application = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: strings.productName,
    url: absoluteUrl(origin, '/'),
    description: strings.homeDescription,
    applicationCategory: 'EducationalApplication',
    operatingSystem: 'Web',
    inLanguage: ['en', 'hi', 'te'],
    publisher: { '@id': organization['@id'] },
  };
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: strings.faq.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
  return [
    {
      path: '/',
      file: 'index.html',
      title: `${strings.productName} — ${strings.tagline}`,
      description: strings.homeDescription,
      jsonLd: [organization, application, faq],
    },
    {
      path: '/pricing',
      file: 'pricing/index.html',
      title: `${strings.pricingTitle} — ${siteName}`,
      description: strings.pricingDescription,
      jsonLd: [organization, application],
    },
  ];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** JSON safe to embed in a <script> element (no "</script>" or "<!--" break-out). */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** <head> tags for one page, one per line. */
export function headTags(page: SeoPage, site: SeoSite, siteName: string): string[] {
  const url = absoluteUrl(site.origin, page.path);
  const meta = (attr: 'name' | 'property', key: string, content: string) =>
    `<meta ${attr}="${key}" content="${escapeHtml(content)}" />`;
  const tags = [
    `<title>${escapeHtml(page.title)}</title>`,
    meta('name', 'description', page.description),
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', siteName),
    meta('property', 'og:title', page.title),
    meta('property', 'og:description', page.description),
    meta('property', 'og:url', url),
    meta('property', 'og:locale', 'en_IN'),
    meta('name', 'twitter:card', site.ogImage ? 'summary_large_image' : 'summary'),
    meta('name', 'twitter:title', page.title),
    meta('name', 'twitter:description', page.description),
  ];
  if (site.ogImage) {
    const image = absoluteUrl(site.origin, site.ogImage);
    tags.push(meta('property', 'og:image', image), meta('name', 'twitter:image', image));
  }
  if (!site.indexable) tags.push(meta('name', 'robots', 'noindex, nofollow'));
  for (const data of page.jsonLd) {
    tags.push(`<script type="application/ld+json">${jsonForScript(data)}</script>`);
  }
  return tags;
}

/**
 * Replaces the template's <title> and description with the page's and adds the
 * remaining tags before </head>. Throws if the template lacks either anchor, so
 * a changed index.html fails the build instead of shipping without metadata.
 */
export function renderPageHtml(
  template: string,
  page: SeoPage,
  site: SeoSite,
  siteName: string,
): string {
  const titleRe = /<title>[\s\S]*?<\/title>/;
  const descriptionRe = /<meta\s+name="description"[\s\S]*?\/?>/;
  if (!titleRe.test(template) || !descriptionRe.test(template) || !template.includes('</head>')) {
    throw new Error('index.html needs a <title>, a description meta tag and </head>');
  }
  const [title, description, ...rest] = headTags(page, site, siteName);
  return template
    .replace(titleRe, () => title!)
    .replace(descriptionRe, () => description!)
    .replace('</head>', () => `  ${rest.join('\n    ')}\n  </head>`);
}

export function robotsTxt(site: SeoSite): string {
  if (!site.indexable) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    'Allow: /',
    ...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
    '',
    `Sitemap: ${absoluteUrl(site.origin, '/sitemap.xml')}`,
    '',
  ].join('\n');
}

export function sitemapXml(site: SeoSite, paths: readonly string[] = PUBLIC_PATHS): string {
  const urls = paths
    .map(
      (path) => `  <url>\n    <loc>${escapeHtml(absoluteUrl(site.origin, path))}</loc>\n  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

export function webManifest(opts: {
  name: string;
  shortName: string;
  description: string;
  themeColor: string;
  backgroundColor: string;
  icons: ManifestIcon[];
}): string {
  const manifest = {
    name: opts.name,
    short_name: opts.shortName,
    description: opts.description,
    lang: 'en',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: opts.themeColor,
    background_color: opts.backgroundColor,
    icons: opts.icons,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Reads a colour from the design-token map in _tokens.scss (the only home of raw colours). */
export function readColorToken(tokensScss: string, name: string): string {
  const match = new RegExp(`'${name}':\\s*(#[0-9a-fA-F]{3,8})`).exec(tokensScss);
  if (!match) throw new Error(`Design token '${name}' not found in _tokens.scss`);
  return match[1]!.toLowerCase();
}
