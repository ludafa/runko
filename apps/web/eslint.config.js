import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import prettierPlugin from 'eslint-plugin-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      '.tanstack',
      'src/gen/**',
      'src/routeTree.gen.ts',
      // ai-elements 是从 registry 取来的第三方组件（`npx ai-elements@latest add`
      // 或 shadcn CLI），和 `src/gen/**` 同属「可重新生成」的代码。它用了几处本仓库
      // 规则不允许的上游惯例（render 期读 ref、any、未使用的解构参数），逐个改会
      // 让下次重新 add 组件变成一场手工合并。**类型安全仍由 tsc 覆盖**，不受影响；
      // 本仓库对这些文件做的改动（base-ui 适配 + sm 档密度）都写在各文件头部。
      'src/components/ai-elements/**',
      // 同理：`npx shadcn add sidebar` 带进来的 hook，本仓库一行没改。它在
      // effect 里 `setState` 订阅 `matchMedia`（`react-hooks/set-state-in-effect`
      // 不允许），但那是这个 hook 的全部职责——改写它等于自己维护一份，下次重新
      // add 就要手工合并。`src/components/ui/**` 不整体忽略：那里的文件带着本仓库
      // 的密度调校（见 §4），仍需受检。
      'src/hooks/use-mobile.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      import: importPlugin,
      'simple-import-sort': simpleImportSort,
      prettier: prettierPlugin,
    },
    rules: {
      ...(reactHooks.configs['recommended-latest']?.rules ??
        reactHooks.configs.recommended.rules),
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',
      'import/no-duplicates': 'warn',
      'prettier/prettier': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': 'allow-with-description',
          'ts-expect-error': 'allow-with-description',
        },
      ],
    },
  },
  {
    // Service Worker（docs/tech/push-notification.md §7）跑在完全另一套全局环境里
    // ——`self` 是 `ServiceWorkerGlobalScope`，`clients`/`registration` 都是它的成员，
    // 浏览器全局那一套（`window`/`document`）反而一个都没有。不整体 ignore 它：这份
    // 文件没有类型检查兜底（裸 JS，见附录 B.1），eslint 是它唯一的静态检查。
    files: ['public/sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
  prettierConfig,
);
