<script setup>
import { ref, onMounted } from 'vue';
import Setup from './views/Setup.vue';
import Studio from './views/Studio.vue';

const phase = ref('checking');
const error = ref('');

onMounted(async () => {
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
