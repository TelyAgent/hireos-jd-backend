import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
      },
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      // Base ESLint's no-undef/no-redeclare don't understand Node's ambient globals (Buffer, NodeJS.*)
      // or TS declaration merging (interface + class of the same name, used to type an EventEmitter's
      // overloaded `on()`); TypeScript's own compiler already catches genuinely undefined identifiers.
      'no-undef': 'off',
      'no-redeclare': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
