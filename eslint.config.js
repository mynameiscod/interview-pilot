// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
    },
  },
  {
    files: [
      'apps/api/**/*.ts',
      'apps/worker/**/*.ts',
      'packages/config/**/*.ts',
      'packages/shared-types/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      'apps/candidate-web/**/*.{ts,tsx}',
      'apps/admin-web/**/*.{ts,tsx}',
      'packages/design-system/**/*.{ts,tsx}',
    ],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Raw hex colours belong in the design-system tokens only.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message: 'Use design tokens (var(--cb-*)) instead of raw hex colours.',
        },
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{6}/]',
          message: 'Use design tokens (var(--cb-*)) instead of raw hex colours.',
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{6}/]',
          message: 'Use design tokens (var(--cb-*)) instead of raw hex colours.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.config.{js,ts}', 'infrastructure/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  prettier,
);
