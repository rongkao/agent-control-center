import tseslint from 'typescript-eslint';

// 工程品質閘門（P1-11 / M-34）：只開最要緊的幾條規則——漏掉 await 的 Promise 會讓未處理的拒絕直接帶崩程序（H-2 的根源之一）。
export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-ts/**', '**/node_modules/**', 'docs/**', 'prototypes/**', 'references/**', '**/*.mjs', '**/*.cjs', 'apps/web/vite.config.ts'] },
  {
    files: ['packages/*/src/**/*.ts', 'apps/server/src/**/*.ts', 'apps/desktop/src/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
);
