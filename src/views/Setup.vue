<script setup>
import { computed, onMounted, ref } from 'vue';

const props = defineProps({
  phase: { type: String, default: 'checking' },
  error: { type: String, default: '' }
});

const busy = ref(false);
const progress = ref(0);
const detail = ref('');
const logs = ref([]);
const showLog = ref(false);

const title = computed(() => ({
  checking: '正在检查运行环境',
  'need-payload': '需要安装运行环境',
  installing: '正在解压运行环境',
  'need-models': '首次启动：需要下载模型',
  downloading: '正在下载模型',
  extracting: '正在解压模型',
  error: '出错了'
}[props.phase] || '准备中…'));

const hint = computed(() => ({
  'need-payload': '把 payload.7z，或分卷 payload.7z.001 ~ .004（共约 3.3 GB）放到桌面/下载文件夹，程序会自动找到并拼合；也可以手动选择 .001。',
  'need-models': '预训练模型约 5.32 GB，从 ModelScope 国内源下载，只需一次，之后离线可用。',
  error: props.error || '请查看下方日志。'
}[props.phase] || ''));

const mainLabel = computed(() => ({
  'need-payload': '选择运行时包',
  'need-models': '下载模型（5.32 GB）',
  error: '重试'
}[props.phase] || '请稍候'));

onMounted(() => {
  window.api.on('download-progress', (p) => {
    progress.value = p.percent;
    detail.value = `${p.percent.toFixed(1)}% · ${(p.doneBytes / 1024 ** 3).toFixed(2)} / ${(p.totalBytes / 1024 ** 3).toFixed(2)} GB`;
  });
  window.api.on('install-progress', (p) => {
    progress.value = p.percent;
    detail.value = '解压 ' + p.percent + '%';
  });
  window.api.on('phase', (p) => {
    if (p.item) detail.value = p.item;
  });
  window.api.on('log', (l) => {
    logs.value.push(l);
    if (logs.value.length > 400) logs.value.splice(0, 100);
  });
});

async function run() {
  if (busy.value) return;
  busy.value = true;
  try {
    if (props.phase === 'need-payload') await window.api.pickPayload();
    else if (props.phase === 'need-models') await window.api.downloadModels();
    else await window.api.boot();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="setup">
    <div class="card">
      <div class="brand">
        <div class="logo">
          <svg width="30" height="30" viewBox="0 0 34 34" fill="none">
            <rect x="6" y="12" width="3.2" height="10" rx="1.6" fill="#ff8a3d"/>
            <rect x="12.2" y="8" width="3.2" height="18" rx="1.6" fill="#ff8a3d"/>
            <rect x="18.4" y="5" width="3.2" height="24" rx="1.6" fill="#ffb26b"/>
            <rect x="24.6" y="9.5" width="3.2" height="15" rx="1.6" fill="#ff8a3d"/>
          </svg>
        </div>
        <div>
          <div class="name">织声</div>
          <div class="sub">WeaveVoice · 本地语音合成</div>
        </div>
      </div>

      <h1>{{ title }}</h1>
      <p class="hint">{{ hint }}</p>

      <div class="bar" :class="{ indet: busy || phase === 'installing' }">
        <i :style="{ width: (busy || phase === 'installing') ? '' : progress + '%' }"></i>
      </div>
      <div class="detail mono">{{ detail }}</div>

      <div class="actions">
        <button class="primary" :disabled="busy || phase === 'installing'" @click="run">{{ mainLabel }}</button>
        <button class="ghost" @click="showLog = !showLog">{{ showLog ? '收起日志' : '查看日志' }}</button>
      </div>

      <pre v-if="showLog" class="log mono">{{ logs.join('\n') }}</pre>
    </div>
  </div>
</template>

<style scoped>
.setup {
  height: 100%;
  display: grid;
  place-items: center;
  background:
    radial-gradient(900px 480px at 12% -8%, rgba(255, 138, 61, .10), transparent 60%),
    radial-gradient(700px 420px at 108% 112%, rgba(69, 200, 160, .07), transparent 55%),
    var(--bg);
}
.card {
  width: 640px;
  max-width: 92vw;
  background: linear-gradient(180deg, var(--panel), var(--panel-2));
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 28px 30px 24px;
  box-shadow: var(--shadow);
}
.brand { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
.logo {
  width: 52px; height: 52px; border-radius: 15px;
  background: linear-gradient(160deg, #262b34, #171a20);
  border: 1px solid var(--accent-line);
  display: grid; place-items: center;
  box-shadow: inset 0 0 18px rgba(255, 138, 61, .10);
}
.name { font-size: 17px; font-weight: 700; letter-spacing: .4px; }
.sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
h1 { font-size: 20px; margin: 0 0 8px; }
.hint { margin: 0 0 18px; }
.bar { height: 8px; border-radius: 999px; background: #0e1115; border: 1px solid #252b34; overflow: hidden; }
.bar > i {
  display: block; height: 100%; width: 0; border-radius: 999px;
  background: linear-gradient(90deg, #ff8a3d, #ffb26b);
  transition: width .25s ease;
}
.bar.indet > i { width: 35%; animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }
.detail { margin-top: 8px; font-size: 11.5px; color: var(--muted); height: 16px; }
.actions { display: flex; gap: 10px; margin-top: 18px; }
.actions button { flex: 1; height: 42px; }
.actions .ghost { flex: 0 0 120px; }
.log {
  margin: 16px 0 0; height: 160px; overflow: auto; background: #0d1014;
  border: 1px solid #242a33; border-radius: 10px; padding: 10px 12px;
  font-size: 11.5px; line-height: 1.55; color: #909cae; white-space: pre-wrap;
  user-select: text;
}
</style>
