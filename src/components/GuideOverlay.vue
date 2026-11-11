<script setup>
/**
 * 使用指南浮层
 *
 * 左侧章节、右侧条目、顶部搜索。入口：设置 → 关于 → 使用指南，或 F1。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { GUIDE_SECTIONS } from '../data/guide.js';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);

const query = ref('');
const activeId = ref(GUIDE_SECTIONS[0].id);

const filtered = computed(() => {
  const k = query.value.trim().toLowerCase();
  if (!k) return GUIDE_SECTIONS;
  return GUIDE_SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter(
      (it) =>
        it.title.toLowerCase().includes(k) ||
        it.body.toLowerCase().includes(k) ||
        s.title.toLowerCase().includes(k),
    ),
  })).filter((s) => s.items.length > 0);
});

const active = computed(
  () => filtered.value.find((s) => s.id === activeId.value) || filtered.value[0],
);

watch(filtered, (list) => {
  if (!list.length) return;
  if (!list.some((s) => s.id === activeId.value)) activeId.value = list[0].id;
});

watch(
  () => props.open,
  (v) => {
    if (v) query.value = '';
  },
);

function onKey(e) {
  if (!props.open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div v-if="open" class="guide-backdrop" @click.self="emit('close')">
    <div class="guide" role="dialog" aria-label="使用指南">
      <header class="guide-head">
        <div class="guide-title">
          <b>使用指南</b>
          <span>按你会卡住的地方找，不用从头读</span>
        </div>
        <div class="guide-search">
          <input v-model="query" type="text" placeholder="搜索，例如「参考音频」「静音」「字幕」" />
        </div>
        <button class="mini" @click="emit('close')">关闭 · Esc</button>
      </header>

      <div class="guide-body">
        <nav class="guide-nav">
          <button
            v-for="s in filtered"
            :key="s.id"
            class="nav-item"
            :class="{ on: active && active.id === s.id }"
            @click="activeId = s.id"
          >
            <span class="nav-title">{{ s.title }}</span>
            <span class="nav-sum">{{ s.summary }}</span>
          </button>
          <p v-if="!filtered.length" class="empty">没有匹配的内容</p>
        </nav>

        <section v-if="active" class="guide-content">
          <div class="content-head">
            <h3>{{ active.title }}</h3>
            <span>{{ active.summary }}</span>
          </div>
          <article v-for="it in active.items" :key="it.title" class="item">
            <h4>{{ it.title }}</h4>
            <p>{{ it.body }}</p>
          </article>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: rgba(4, 6, 9, 0.62);
  backdrop-filter: blur(6px);
  animation: fade 140ms var(--ease);
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.guide {
  width: min(980px, calc(100vw - 64px));
  height: min(720px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}

.guide-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line-soft);
}
.guide-title { display: flex; flex-direction: column; gap: 2px; }
.guide-title b { font-size: 13.5px; font-weight: 650; }
.guide-title span { font-size: 11px; color: var(--muted-2); }
.guide-search { flex: 1; display: flex; justify-content: flex-end; }
.guide-search input { width: 100%; max-width: 360px; }

.guide-body { flex: 1; min-height: 0; display: flex; }

.guide-nav {
  width: 232px;
  flex: 0 0 232px;
  overflow-y: auto;
  padding: 10px;
  border-right: 1px solid var(--line-soft);
  background: var(--rail);
}
.nav-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  height: auto;
  padding: 8px 10px;
  margin-bottom: 2px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  align-items: flex-start;
  justify-content: flex-start;
}
.nav-item:hover:not(.on) { background: var(--panel-2); border-color: transparent; }
.nav-item.on { background: var(--accent-soft); border-color: var(--accent-line); }
.nav-title { font-size: 12.5px; font-weight: 600; color: var(--text); }
.nav-sum { font-size: 10.5px; color: var(--muted-2); line-height: 1.4; white-space: normal; }

.guide-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 22px 24px;
}
.content-head { padding-bottom: 10px; margin-bottom: 6px; border-bottom: 1px solid var(--line-soft); }
.content-head h3 { margin: 0 0 4px; font-size: 15px; font-weight: 650; }
.content-head span { font-size: 11.5px; color: var(--muted-2); }

.item { padding: 14px 0; border-bottom: 1px solid var(--line-soft); }
.item:last-child { border-bottom: none; }
.item h4 { margin: 0 0 5px; font-size: 12.5px; font-weight: 600; color: var(--text); }
.item p { margin: 0; font-size: 12px; line-height: 1.85; color: var(--muted); max-width: 72ch; user-select: text; }

.empty { color: var(--muted-2); font-size: 11.5px; padding: 12px 8px; }
</style>
