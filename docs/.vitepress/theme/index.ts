import { h } from 'vue';
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import DocMeta from './DocMeta.vue';

/**
 * 只做一件事：在每篇正文上方插一行归位信息（层 · 模块 · 包 · tags），
 * 数据直接来自每份文档的 front matter，不另存一份。
 */
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'doc-before': () => h(DocMeta) }),
} satisfies Theme;
