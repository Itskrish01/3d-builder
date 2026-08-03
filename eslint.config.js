import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'legacy/**', 'node_modules/**'] },

  /* ---- the React chrome ---- */
  {
    files: ['src/**/*.{js,jsx}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',       // the automatic runtime handles it
      'react/prop-types': 'off',               // this is JS, not a typed API surface
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },

  /* ---- the engine: ported from ES5, deliberately not modernised ---- */
  {
    files: ['src/engine/**/*.js'],
    rules: {
      'no-var': 'off',
      'prefer-const': 'off',
      // The scene graph is one mutually recursive system; several modules are
      // legitimately circular and a few `var`s are assigned after creation.
      'no-use-before-define': 'off'
    }
  },

  /* ---- migration tools and the serverless function run on node ---- */
  {
    files: ['tools/**/*.mjs', 'api/**/*.js', 'vite.config.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node }
  }
];
