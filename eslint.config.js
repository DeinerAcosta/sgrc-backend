// ESLint flat config — backend (Node ESM)
// Pensado para advertir, no bloquear. Las reglas que sí son errores son las
// que indican bugs reales (no `===`, variables no definidas) — el resto queda
// en warning para no romper el flujo cuando se está iterando rápido.

import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['node_modules/**', 'prisma/migrations/**', 'dist/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Bugs frecuentes
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'off', // los jobs/scripts usan console.log a propósito
      // Async safety
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'off',
      // Estilo suave
      'no-multiple-empty-lines': ['warn', { max: 2, maxBOF: 0, maxEOF: 1 }],
    },
  },
]
