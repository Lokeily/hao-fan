import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'dist/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  {
    // 扩展源码（内容脚本 / 后台 / 页面）运行在浏览器环境。
    files: ['**/*.ts', '**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    // Node 脚本与测试。
    files: ['scripts/**/*.mjs', 'tests/*.mjs', 'tests/browser/server.mjs', '*.config.*'],
    languageOptions: { globals: globals.node },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 内容脚本需要跨浏览器桥接，显式 any 是常见且必要的写法。
      '@typescript-eslint/no-explicit-any': 'off',
      // 未使用变量保留为警告（CI 不因警告失败，方便渐进清理）。
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 翻译链路中大量使用"可忽略的失败"空 catch（如 storage 监听不可用时的降级）。
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  prettier,
);
