// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/', '**/node_modules/', '**/*.js.map', '**/coverage/'],
  },

  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'warn',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        // tsconfig.json covers src; the root config files are linted with a default project.
        projectService: { allowDefaultProject: ['tsup.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },

  {
    files: ['**/*.spec.ts', '**/jest.config.js'],
    languageOptions: { globals: { ...globals.jest } },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
  },

  {
    files: ['scripts/**', 'test/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },

  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dynamic-entity/*', 'ngx-dynamic-entity', 'ngx-dynamic-entity-builder'],
              message: 'sheet-to-schema must not depend on Dynamic Entity.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['src/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.fixtures.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dynamic-entity/*', 'ngx-dynamic-entity', 'ngx-dynamic-entity-builder'],
              message: 'sheet-to-schema must not depend on Dynamic Entity.',
            },
            { group: ['./node', './node/*'], message: 'The main entry is browser-safe: it must not import /node.' },
            { group: ['node:*', 'fs', 'path', 'stream', 'zlib', 'crypto', 'http', 'https', 'buffer'], message: 'The main entry is browser-safe: no Node built-ins.' },
            { group: ['exceljs', 'busboy', 'express'], message: 'The main entry is browser-safe: these packages only Node has.' },
          ],
        },
      ],
    },
  },

  {
    files: ['src/node/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dynamic-entity/*', 'ngx-dynamic-entity', 'ngx-dynamic-entity-builder'],
              message: 'sheet-to-schema must not depend on Dynamic Entity.',
            },
            {
              group: ['../*', '!../shared', '!../shared/*'],
              message: 'Import the main entry as "sheet-to-schema", so /node carries no second copy of it. ../shared is the exception: it is not the main entry.',
            },
          ],
        },
      ],
    },
  },

  {
    // What the server's readers and the browser reader share. Bundled into each of them, so it
    // is held to the browser's rules, and reaches the main entry by name like /node does.
    files: ['src/shared/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.fixtures.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dynamic-entity/*', 'ngx-dynamic-entity', 'ngx-dynamic-entity-builder'],
              message: 'sheet-to-schema must not depend on Dynamic Entity.',
            },
            { group: ['../*'], message: 'Shared code imports the main entry as "sheet-to-schema", and never /node or /browser.' },
            { group: ['node:*', 'fs', 'path', 'stream', 'zlib', 'crypto', 'http', 'https', 'buffer'], message: 'Shared code runs in a browser: no Node built-ins.' },
            { group: ['exceljs', 'busboy', 'express'], message: 'Shared code loads no peer: the entry that needs one loads it.' },
          ],
        },
      ],
    },
  },
);
