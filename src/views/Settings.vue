<script setup>
import { computed, onMounted, ref } from 'vue';

defineProps({ voicesCount: { type: Number, default: 0 } });
const emit = defineEmits(['guide']);

const models = ref([]);
const outputs = ref([]);
const busy = ref('');
const playing = ref('');
const error = ref('');
const payloadPath = ref('');
const version = ref('');
const audioEl = ref(null);

const showAll = ref(false);
const totalModelMB = computed(() => models.value.reduce((s, m) => s + m.sizeMB, 0));

// 按音色分组：在用的那一对 vs 历史检查点
const modelGroups = computed(() => {
  const map = new Map();
  for (const m of models.value) {
    const key = m.voice || 'other';
    if (!map.has(key)) map.set(key, { voice: key, role: m.role, active: [], history: [] });
    (m.active ? map.get(key).active : map.get(key).history).push(m);
  }
  return [...map.values()].sort((a, b) => a.voice.localeCompare(b.voice));
});
const activeCount = computed(() => modelGroups.value.reduce((s, g) => s + g.active.length, 0));
const historyCount = computed(() => modelGroups.value.reduce((s, g) => s + g.history.length, 0));

async function setRole(name, role) {
  await window.api.setVoiceRole({ name, role });
  await refresh();
}

async function cleanHistory() {
  const targets = modelGroups.value.flatMap((g) => g.history);
  if (!targets.length) return;
  if (!window.confirm('删除 ' + targets.length + ' 个历史检查点？\\n当前音色在用的 ' + activeCount.value + ' 个会保留。')) return;
  for (const t of targets) await window.api.deleteModel({ path: t.path });
  await refresh();
}
const totalOutputMB = computed(() => outputs.value.reduce((s, o) => s + o.sizeMB, 0));

onMounted(async () => {
  const st = await window.api.state();
  payloadPath.value = st.payload || '';
  version.value = st.version || '';
  await refresh();
});

async function refresh() {
  busy.value = 'refresh';
  try {
    models.value = await window.api.listModels();
    outputs.value = await window.api.listOutputs();
  } finally {
    busy.value = '';
  }
}
// Settings.vue 没有 defineExpose，refresh 只在本组件内使用

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch (_) { return ''; }
}

async function play(item) {
  playing.value = item.path;
  const res = await window.api.readAudio({ path: item.path });
  if (!res.ok) { error.value = res.error; return; }
  await new Promise((r) => setTimeout(r, 30));
  if (audioEl.value) {
    audioEl.value.src = 'data:audio/wav;base64,' + res.base64;
    audioEl.value.play().catch(() => {});
  }
}

async function removeOutput(item) {
  if (!window.confirm(`删除生成记录？\n${item.name}`)) return;
  const res = await window.api.deleteOutput({ path: item.path });
  if (!res.ok) { error.value = res.error; return; }
  await refresh();
}

async function removeModel(item) {
  if (!window.confirm(`删除模型文件？删除后无法恢复。\n${item.file}`)) return;
  const res = await window.api.deleteModel({ path: item.path });
  if (!res.ok) { error.value = res.error; return; }
  await refresh();
}

const themes = [{ key: 'warm', label: '暖调' }, { key: 'cool', label: '冷调' }, { key: 'light', label: '浅色' }];
const current = ref((typeof localStorage !== 'undefined' && localStorage.getItem('vs-theme')) || 'warm');
function setTheme(k) {
  current.value = k;
  window.dispatchEvent(new CustomEvent('vs-theme', { detail: k }));
}

function openOutput() { window.api.openOutput(); }
function openFolder() { window.api.openFolder(); }
function openLogs() { window.api.openLogs(); }
function openHelp() { emit('guide'); }

async function checkUpdate() {
  const res = await window.api.updaterCheck();
  if (!res.ok) error.value = res.error;
  else error.value = '';
}
</script>

<template>
  <div class="settings">
    <section class="card">
      <div class="editor-head">
        <span>
          音色与权重
          <em class="muted">{{ modelGroups.length }} 个音色 · 在用 {{ activeCount }} 个文件 · 共 {{ totalModelMB.toFixed(0) }} MB</em>
        </span>
        <button class="mini" @click="refresh" :disabled="busy === 'refresh'">刷新</button>
      </div>
      <div class="list">
        <div v-for="g in modelGroups" :key="g.voice" class="voice-group">
          <div class="group-head">
            <b>{{ g.voice }}</b>
            <span class="tag">使用中</span>
            <select class="role-select" :value="g.role" @change="setRole(g.voice, $event.target.value)">
              <option value="read">朗读用</option>
              <option value="sing">唱歌用</option>
            </select>
            <span class="muted" v-if="g.active.length === 2">SoVITS + GPT 成对</span>
            <span class="muted" v-else>缺少配对文件，可能无法合成</span>
          </div>
          <div v-for="m in g.active" :key="m.path" class="row">
            <span class="badge" :class="m.kind">{{ m.kind === 'sovits' ? 'SoVITS' : 'GPT' }}</span>
            <span class="name mono" :title="m.path">{{ m.file }}</span>
            <span class="meta">{{ m.sizeMB }} MB</span>
            <span class="meta">{{ fmtDate(m.mtime) }}</span>
          </div>
        </div>
        <div v-if="!models.length" class="empty">
          <b>还没有训练好的模型</b>
          去「训练」页跑一次，完成后这里会出现音色
        </div>

        <div v-if="historyCount" class="hist-actions">
          <button class="mini" @click="showAll = !showAll">
            {{ showAll ? '收起历史检查点' : '显示 ' + historyCount + ' 个历史检查点' }}
          </button>
          <button v-if="showAll" class="mini danger" @click="cleanHistory">清理全部历史检查点</button>
        </div>

        <template v-if="showAll">
          <div v-for="g in modelGroups" :key="'h' + g.voice" class="voice-group">
            <div class="group-head hist"><b>{{ g.voice }}</b><span class="muted">历史检查点 · 可删</span></div>
            <div v-for="m in g.history" :key="m.path" class="row hist">
              <span class="badge" :class="m.kind">{{ m.kind === 'sovits' ? 'SoVITS' : 'GPT' }}</span>
              <span class="name mono" :title="m.path">{{ m.file }}</span>
              <span class="meta">{{ m.sizeMB }} MB</span>
              <span class="meta">{{ fmtDate(m.mtime) }}</span>
              <button class="mini danger" @click="removeModel(m)">删除</button>
            </div>
          </div>
        </template>
      </div>
    </section>

    <section class="card">
      <div class="editor-head">
        <span>生成记录 <em class="muted">{{ outputs.length }} 个 · {{ totalOutputMB.toFixed(1) }} MB</em></span>
        <div class="head-actions">
          <button class="mini" @click="openOutput">打开目录</button>
          <button class="mini" @click="refresh" :disabled="busy === 'refresh'">刷新</button>
        </div>
      </div>
      <div class="list">
        <div v-for="o in outputs" :key="o.path" class="row" :class="{ playing: playing === o.path }">
          <span class="badge batch">{{ o.group }}</span>
          <span class="name mono" :title="o.path">{{ o.name }}</span>
          <span class="meta">{{ o.dur }}s</span>
          <span class="meta">{{ o.sizeMB }} MB</span>
          <span class="meta">{{ fmtDate(o.mtime) }}</span>
          <button class="mini" @click="play(o)">播放</button>
          <button class="mini danger" @click="removeOutput(o)">删除</button>
        </div>
        <div v-if="!outputs.length" class="empty">还没有生成过语音</div>
      </div>
      <audio ref="audioEl" style="display:none"></audio>
    </section>

    <section class="card">
      <div class="editor-head"><span>关于</span></div>
      <div class="kv"><span>版本</span><b class="mono">{{ version }}</b></div>
      <div class="kv">
        <span>外观</span>
        <span class="theme-row">
          <button class="mini" v-for="t in themes" :key="t.key" :class="{ on: current === t.key }" @click="setTheme(t.key)">{{ t.label }}</button>
        </span>
      </div>
      <div class="kv"><span>音色</span><b>{{ voicesCount }} 个</b></div>
      <div class="kv"><span>运行环境</span><b class="mono ellipsis" :title="payloadPath">{{ payloadPath }}</b></div>
      <div class="actions">
        <button class="mini" @click="openFolder">打开安装目录</button>
        <button class="mini" @click="openLogs">打开日志</button>
        <button class="mini" @click="openHelp">使用指南</button>
        <button class="mini" @click="openOutput">打开输出目录</button>
        <button class="mini" @click="checkUpdate">检查更新</button>
      </div>
      <div v-if="error" class="alert">{{ error }}</div>
    </section>
  </div>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 12px; }
.editor-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 24px; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--line-soft); font-size: 11px; letter-spacing: .06em; color: var(--muted); }
.editor-head em { font-style: normal; margin-left: 8px; }
.head-actions { display: flex; gap: 6px; }
.list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow: auto; }
.row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; border: 1px solid transparent; }
.row:hover { background: var(--panel-2); }
.row.playing { background: rgba(255, 138, 61, .08); border-color: rgba(255, 138, 61, .25); }
.badge { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); flex: 0 0 auto; }
.badge.sovits { color: #7fd3ff; border-color: rgba(127, 211, 255, .35); }
.badge.gpt { color: #ffb26b; border-color: rgba(255, 178, 107, .35); }
.badge.batch { color: var(--muted-2); }
.name { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: 11px; color: var(--muted-2); flex: 0 0 auto; }
.mini { height: 24px; padding: 0 8px; font-size: 11.5px; border-radius: 8px; background: transparent; border: 1px solid transparent; color: var(--muted); }
.mini.danger { color: var(--muted-2); border-color: transparent; }
.mini.danger:hover { color: var(--err); background: rgba(228, 103, 95, .1); border-color: rgba(228, 103, 95, .28); }
.empty { color: var(--muted-2); font-size: 12px; padding: 14px 8px; }
.kv { display: flex; gap: 12px; padding: 5px 2px; font-size: 12.5px; }
.kv span { color: var(--muted); flex: 0 0 70px; }
.kv b { font-weight: 500; min-width: 0; }
.theme-row { display: flex; gap: 6px; }
.theme-row .mini.on { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
.alert { margin-top: 10px; border: 1px solid rgba(228, 103, 95, .32); background: rgba(228, 103, 95, .07); color: #e6a3a0; border-radius: 8px; padding: 8px 10px; font-size: 12px; }

.voice-group { border-top: 1px solid var(--line-soft); padding-top: 8px; margin-top: 4px; }
.voice-group:first-child { border-top: none; margin-top: 0; padding-top: 0; }
.group-head { display: flex; align-items: baseline; gap: 8px; padding: 2px 6px 4px; }
.group-head b { font-size: 12.5px; font-weight: 650; }
.group-head .tag {
  font-size: 10px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--accent);
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
}
.group-head .muted { font-size: 10.5px; color: var(--muted-2); }
.role-select { height: 22px; font-size: 10.5px; padding: 0 4px; border-radius: 6px; }
.group-head.hist b { color: var(--muted); }
.row.hist { opacity: .7; }
.hist-actions { display: flex; gap: 6px; padding: 10px 6px 2px; }
</style>
