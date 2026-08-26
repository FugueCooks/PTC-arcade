import eslintPlugin from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    files: ['server/**/*.ts', 'shared/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser,
      parserOptions: { project: './tsconfig.json' }
    },
    plugins: { '@typescript-eslint': eslintPlugin },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error'
    }
  }
];
