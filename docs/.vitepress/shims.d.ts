/**
 * 让 `tsc --noEmit` 认得 .vue 单文件组件。
 *
 * 站点只有一个 .vue（DocMeta，40 行模板），不值得为它引 vue-tsc——那要跟本仓的
 * typescript@7（tsgo）配版本，风险大于收益。真正有逻辑的是 .vitepress 下的
 * 那几个 .ts，它们照常受 typecheck 保护。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
