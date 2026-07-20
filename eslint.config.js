import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'bench/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentionally-unused identifiers prefixed with `_`
      // (stub params, placeholder bindings).
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  // Disable formatting rules that conflict with Prettier. Keep last.
  prettier,
  {
    // `site/` is the MkDocs build output (generated, minified assets).
    ignores: ['node_modules/**', 'coverage/**', 'site/**', '.venv/**'],
  },
];
