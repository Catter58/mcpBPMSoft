// ESLint v9 flat config — ESM
// Applies to TypeScript sources in src/ and tests/.

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['build/**', 'node_modules/**', '**/*.d.ts', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Code base contains some legitimate `any` (OData payloads, error objects).
      // Demote to warning instead of erroring builds.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Allow intentionally-unused identifiers when prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // The MCP server runs over stdio; console.error is the project's
      // approved logging channel (stdout is reserved for the MCP transport).
      'no-console': 'off',
    },
  }
);
