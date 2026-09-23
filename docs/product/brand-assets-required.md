# Brand assets required for production

> **Status: RELEASE BLOCKER.** Production UI sign-off can't happen until every item below is supplied and `pnpm brand:check` passes. The CI pipeline reports missing assets as a warning on every run.

The official CodeBegun logo files and the complete CodeBegun System Style Guide aren't in this repository yet. Engineering proceeds on the approved baseline below. **No logo artwork has been created, redrawn, approximated or generated**, and none may be.

## 1. Approved baseline (in use now)

| Item               | Value                                                                                                                                                               | Source   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Brand              | CodeBegun                                                                                                                                                           | Approved |
| Product            | CareerPilot Interview                                                                                                                                               | Approved |
| Secondary branding | "by CodeBegun"                                                                                                                                                      | Approved |
| Primary Navy       | `#051D64` → `--cb-primary`                                                                                                                                          | Approved |
| Accent Teal        | `#359AAD` → `--cb-secondary`                                                                                                                                        | Approved |
| Background         | `#FFFFFF` → `--cb-background`                                                                                                                                       | Approved |
| UI framework       | Bootstrap 5                                                                                                                                                         | Approved |
| Style              | Clean, professional, premium, modern, minimal, trustworthy, enterprise-ready, student-friendly. No excessive gradients, decorative effects or unnecessary animation | Approved |

All other tokens (`--cb-surface`, `--cb-surface-muted`, `--cb-text-primary`, `--cb-text-secondary`, `--cb-border`, `--cb-success`, `--cb-warning`, `--cb-danger`, `--cb-info`) currently hold **provisional neutral defaults**. They're engineering placeholders, not brand rules, and will be replaced by the style guide (item 10). They're defined in exactly one file: [`packages/design-system/src/styles/_tokens.scss`](../../packages/design-system/src/styles/_tokens.scss).

**Accessibility note for the style guide:** Accent Teal on white has a contrast ratio of about 3.3:1, which is below WCAG AA (4.5:1) for body text. The UI therefore uses teal for accents, icons, borders and focus rings, not for body text. Please confirm or adjust this in the style guide.

## 2. Assets still required

| #   | Asset                                           | Preferred format                                | Expected location(s)                                                                                   | Status                                               |
| --- | ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 1   | Official CodeBegun primary logo                 | SVG (plus PNG fallback)                         | `apps/candidate-web/public/brand/codebegun-logo.svg`, `apps/admin-web/public/brand/codebegun-logo.svg` | **Missing**                                          |
| 2   | Official CodeBegun white/reversed logo          | SVG                                             | `apps/*/public/brand/codebegun-logo-reversed.svg`                                                      | **Missing**                                          |
| 3   | Official CodeBegun icon/mark (if available)     | SVG                                             | `apps/*/public/brand/codebegun-mark.svg` (registry entry to be added on receipt)                       | **Missing**                                          |
| 4   | CareerPilot logo (if applicable)                | SVG                                             | `apps/*/public/brand/careerpilot-interview-logo.svg`                                                   | **Missing**                                          |
| 5   | Favicon                                         | SVG and/or ICO (+ 180×180 PNG apple-touch-icon) | `apps/*/public/favicon.svg` or `favicon.ico`                                                           | **Missing**                                          |
| 6   | Social / Open Graph image                       | PNG, 1200×630                                   | `apps/candidate-web/public/brand/og-image.png`                                                         | **Missing**                                          |
| 7   | Complete CodeBegun System Style Guide           | PDF or Figma                                    | `docs/product/` (reference)                                                                            | **Missing**                                          |
| 8   | Approved font family / files or web-font source | WOFF2 files or approved CDN                     | `packages/design-system/`                                                                              | **Missing**. The system font stack is used meanwhile |
| 9   | Minimum logo clear-space and sizing rules       | From style guide                                | Applied in `.cb-brand-logo`                                                                            | **Missing**                                          |
| 10  | Approved secondary/status colours               | From style guide                                | `_tokens.scss`                                                                                         | **Missing**. Provisional values in use               |

## 3. How logos are wired (no code change needed on delivery)

- **One registry:** [`packages/design-system/src/brand/brand-assets.ts`](../../packages/design-system/src/brand/brand-assets.ts) defines every brand asset path. No component references a logo path directly.
- **`<BrandLogo asset="…" />`** renders the official file from `public/brand/`. If the file is missing, it renders **`BrandLogoPlaceholder`** instead: a dashed "[logo pending]" marker that is visibly a missing-asset indicator. It isn't a logo and must never be styled to resemble one. It carries `data-brand-placeholder="true"`.
- **To go live:** copy the official files to the locations in §2 and run `pnpm brand:check`. No application code changes are needed.
- The production static server returns 404 for missing `/brand/*` files rather than the SPA page, so the placeholder fallback behaves the same in development and production.

## 4. Release gate

```bash
pnpm brand:check          # exits 1 while anything is missing (use before production UI sign-off)
pnpm brand:check --report # exits 0; used by CI to surface the gap on every run
```

The production deployment workflow (Phase 12) will run `pnpm brand:check` without `--report`, so a production deploy is blocked until the assets are supplied.

## 5. Rules

- Do not invent brand rules (spacing, colours, typography, tone) that the style guide hasn't specified.
- Do not recreate, trace, redraw, approximate or AI-generate the CodeBegun logo, including with text or CSS.
- Keep raw colour values out of components. ESLint rejects hex literals in web code, and tokens live only in `_tokens.scss`.
