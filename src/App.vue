<script setup>
import { ref, onMounted } from 'vue';
import Setup from './views/Setup.vue';
import Studio from './views/Studio.vue';

const phase = ref('checking');
const error = ref('');
const theme = ref('light');

function applyTheme(name) {
  const t = ['light', 'graphite'].includes(name) ? name : 'light';
  theme.value = t;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('vs-theme', t); } catch (_) {}
}

onMounted(async () => {
  // 截图/测试时可通过 ?theme= 强制指定
  const forced = new URLSearchParams(location.search).get('theme');
  const saved = forced || localStorage.getItem('vs-theme') || 'light';
  applyTheme(saved);
  window.addEventListener('vs-theme', (e) => applyTheme(e.detail));

  const s = await window.api.state();
  phase.value = s.phase;
  error.value = s.error || '';

  window.api.on('phase', (p) => {
    if (p.phase === 'downloading' || p.phase === 'extracting' || p.phase === 'installing') {
      phase.value = p.phase;
    } else {
      phase.value = p.phase;
    }
    if (p.error) error.value = p.error;
  });
});
</script>

<template>
  <Studio v-if="phase === 'ready' || phase === 'starting'" :phase="phase" />
  <Setup v-else :phase="phase" :error="error" />
</template>
