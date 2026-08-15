<script setup lang="ts">
import { computed } from 'vue';
import { useData } from 'vitepress';

const { frontmatter } = useData();

/** 归位：层 · 模块 —— front matter 里本来就有，这里只是显示出来 */
const placement = computed(() => {
  const { layer, module: mod } = frontmatter.value as { layer?: string; module?: string };
  return [layer, mod && mod !== '—' ? mod : null].filter(Boolean).join(' · ');
});

const packages = computed<string[]>(() => {
  const p = (frontmatter.value as { packages?: unknown }).packages;
  return Array.isArray(p) ? (p as string[]) : [];
});

const tags = computed<string[]>(() => {
  const t = (frontmatter.value as { tags?: unknown }).tags;
  return Array.isArray(t) ? (t as string[]) : [];
});

const show = computed(() => placement.value || packages.value.length > 0);
</script>

<template>
  <div v-if="show" class="doc-meta">
    <span v-if="placement" class="doc-meta__placement">{{ placement }}</span>
    <code v-for="p in packages" :key="p" class="doc-meta__pkg">{{ p }}</code>
    <span v-for="t in tags" :key="t" class="doc-meta__tag">{{ t }}</span>
  </div>
</template>

<style scoped>
.doc-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 20px;
  font-size: 12px;
  line-height: 20px;
}

.doc-meta__placement {
  padding: 1px 8px;
  border-radius: 10px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.doc-meta__pkg {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--vp-c-text-2);
  background: var(--vp-c-default-soft);
}

.doc-meta__tag {
  padding: 1px 8px;
  border-radius: 10px;
  color: var(--vp-c-text-3);
  border: 1px solid var(--vp-c-divider);
}
</style>
