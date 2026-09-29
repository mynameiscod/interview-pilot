import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { webConfig } from '../../vite.shared.ts';
import { englishSeoStrings } from './src/seo/seo-strings.ts';
import {
  type ManifestIcon,
  PRODUCTION_ORIGIN,
  readColorToken,
  renderPageHtml,
  robotsTxt,
  seoPages,
  type SeoSite,
  sitemapXml,
  webManifest,
} from './src/seo/seo.ts';

const publicDir = fileURLToPath(new URL('./public', import.meta.url));
const tokensFile = fileURLToPath(
  new URL('../../packages/design-system/src/styles/_tokens.scss', import.meta.url),
);

/**
 * Production build only: prerenders the <head> of `/` and `/pricing`, and
 * writes robots.txt, sitemap.xml and the web app manifest (see src/seo/seo.ts).
 * Icons and the social image are linked only once the official brand files
 * exist in public/ (docs/product/brand-assets-required.md).
 */
function candidateSeo(mode: string): Plugin {
  const env = loadEnv(mode, '../..', 'VITE_');
  const site: SeoSite = {
    origin: (env.VITE_CANDIDATE_URL || PRODUCTION_ORIGIN).replace(/\/+$/, ''),
    indexable: env.VITE_APP_ENV === 'production',
    ogImage: existsSync(`${publicDir}/brand/og-image.png`) ? '/brand/og-image.png' : undefined,
  };
  const strings = englishSeoStrings();
  const siteName = `${strings.productName} ${strings.endorsement}`;

  return {
    name: 'cbi:candidate-seo',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (index?.type !== 'asset') return;
      const colors = readFileSync(tokensFile, 'utf8');
      const themeColor = readColorToken(colors, 'primary');
      const has = (file: string) => existsSync(`${publicDir}${file}`);

      const extra = [
        `<meta name="theme-color" content="${themeColor}" />`,
        '<link rel="manifest" href="/manifest.webmanifest" />',
      ];
      if (has('/favicon.svg')) {
        extra.push('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
      } else if (has('/favicon.ico')) {
        extra.push('<link rel="icon" href="/favicon.ico" sizes="any" />');
      }
      if (has('/apple-touch-icon.png')) {
        extra.push('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
      }
      const template = String(index.source).replace(
        '</head>',
        () => `  ${extra.join('\n    ')}\n  </head>`,
      );

      for (const page of seoPages(strings, site.origin)) {
        const html = renderPageHtml(template, page, site, siteName);
        if (page.file === 'index.html') index.source = html;
        else this.emitFile({ type: 'asset', fileName: page.file, source: html });
      }

      const icons: ManifestIcon[] = [];
      if (has('/favicon.svg')) {
        icons.push({ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' });
      }
      for (const size of [192, 512]) {
        const src = `/brand/icon-${size}.png`;
        if (has(src)) icons.push({ src, sizes: `${size}x${size}`, type: 'image/png' });
      }
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: webManifest({
          name: siteName,
          shortName: strings.productName,
          description: strings.homeDescription,
          themeColor,
          backgroundColor: readColorToken(colors, 'background'),
          icons,
        }),
      });
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robotsTxt(site) });
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml(site) });
    },
  };
}

export default defineConfig(({ mode }) => webConfig({ port: 5173, plugins: [candidateSeo(mode)] }));
