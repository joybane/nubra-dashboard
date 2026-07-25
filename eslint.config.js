import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config.
 *
 * Philosophy: this is a mature, single-author codebase. We enable the rules that
 * catch *real* bugs (React hook dependencies, unsafe patterns) as errors, and
 * demote stylistic / legacy-noise rules to warnings so `npm run lint` stays a
 * useful signal rather than a wall of red. Formatting is owned entirely by
 * Prettier (the `prettier` config below turns off every rule that would fight it).
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '_archive/**',
      'scratch/**',
      'public/**',
      '*.config.js',
      '*.config.ts',
    ],
  },

  // ── Frontend (browser) ──────────────────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.worker },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Unused symbols: warn (don't block), allow leading-underscore intentional discards.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `any` shows up in the large legacy views; surface it as a warning to trend down over time.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Ternary/short-circuit used for side effects is an intentional idiom here
      // (e.g. `set.has(x) ? set.delete(x) : set.add(x)`); still flag genuine dead expressions.
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
      // `{}` is used to mean "no props" in a few forwardRef components — allow it.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  // ── Backend (Node) ──────────────────────────────────────────────────
  {
    files: ['server/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  // Prettier must be last: it disables all formatting-related lint rules.
  prettier,
);
