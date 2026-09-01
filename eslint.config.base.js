import tseslint from 'typescript-eslint';

/**
 * 全仓共享的 eslint 基线配置。
 *
 * 只放**跨全部成员都成立**的规则。目前只有一条：花括号强制。
 * `packages/*` 与 `examples` 各自的 eslint.config.js 直接引这份，
 * 需要额外忽略项时在自己那边追加一个 `{ ignores: [...] }` 配置块。
 *
 * 刻意**不**引入 prettier / import-sort / 各框架插件那一套：
 * 两个 app（apps/web、apps/node-server）有自己完整的配置，
 * 它们不引这份基线——那边的 curly 直接写在各自配置里（且必须排在
 * eslint-config-prettier 之后，否则会被它关掉）。
 */
export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    languageOptions: {
      // 只为能解析 TS 语法，不开类型感知（type-aware）检查——
      // curly 是纯语法规则，不需要 program，避免每个包都要配 tsconfig 路径。
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // if / else / for / while / do 的语句体一律写花括号，哪怕只有一行。
      curly: ['error', 'all'],
    },
  },
];
