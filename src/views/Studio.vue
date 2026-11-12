<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import Train from './Train.vue';
import Settings from './Settings.vue';
import GuideOverlay from '../components/GuideOverlay.vue';
import Book from './Book.vue';
import Cover from './Cover.vue';
import Profile from './Profile.vue';

const props = defineProps({ phase: { type: String, default: 'starting' } });

const ready = ref(props.phase === 'ready');
const voices = ref([]);
const currentVoice = ref(null);
const voiceApplied = ref(false);
const refs = ref([]);
const currentRef = ref(null);
const refText = ref('');
const text = ref('');
const running = ref(false);
const elapsed = ref(0);
const result = ref(null);
const history = ref([]);
const error = ref('');
const log = ref([]);
const showLog = ref(false);

// ---- 批量 ----
const hashMode = (String(location.hash || '').match(/mode=(\w+)/) || [])[1];
const ICON = {
  single: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke-linejoin="round"/></svg>',
  batch: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4.5h10M3 8h10M3 11.5h6" stroke-linecap="round"/></svg>',
  book: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 3.2h4.2c.6 0 1 .4 1 1v8.6c0-.6-.5-1-1-1H3zM13 3.2H8.8c-.6 0-1 .4-1 1v8.6c0-.6.5-1 1-1H13z" stroke-linejoin="round"/></svg>',
  profile: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 8h1.6l1.2-3.4L6.6 12l1.6-8 1.4 6.6L11 6.4l1 1.6H14" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cover: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="6" y="2.4" width="4" height="7" rx="2"/><path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2" stroke-linecap="round"/></svg>',
  train: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2.4l1.6 3.4 3.6.5-2.6 2.6.6 3.7L8 10.9l-3.2 1.7.6-3.7L2.8 6.3l3.6-.5z" stroke-linejoin="round"/></svg>',
  settings: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2"/><path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M3.9 3.9l1.1 1.1M11 11l1.1 1.1M12.1 3.9L11 5M5 11l-1.1 1.1" stroke-linecap="round"/></svg>'
};

const MODES = [
  { id: 'single', label: '单句合成', icon: ICON.single },
  { id: 'batch', label: '批量合成', icon: ICON.batch },
  { id: 'book', label: '音频书', icon: ICON.book },
  { id: 'profile', label: '测声', icon: ICON.profile },
  { id: 'cover', label: '翻唱', icon: ICON.cover },
  { id: 'train', label: '训练', icon: ICON.train },
  { id: 'settings', label: '设置', icon: ICON.settings }
];

const PAGE = {
  single: ['单句合成', '输入一段话，用当前音色读出来'],
  batch: ['批量合成', '一次排好几十句，逐句合成后打包'],
  book: ['音频书', '长文分章，逐句合成并导出带字幕的音轨'],
  profile: ['测声', '测出你的音域，看哪些歌适合你'],
  cover: ['翻唱', '把人声换成你的音色，再和伴奏合起来'],
  train: ['训练', '用你的录音训练一个新音色'],
  settings: ['设置', '音色、权重、主题与使用指南']
};

const sideInfo = computed(() => ['single', 'batch', 'book'].includes(mode.value));
const refInfo = computed(() => mode.value === 'single' || mode.value === 'batch');
const bodyEl = ref(null);

const pageTitle = computed(() => (PAGE[mode.value] || ['织声', ''])[0]);
const pageSubtitle = computed(() => (PAGE[mode.value] || ['', ''])[1]);
const showGuide = ref(false);
const coverPitch = ref(null);

async function openOutput() {
  const r = await window.api.openOutput();
  if (r && r.ok === false) error.value = '打开输出目录失败：' + (r.error || '未知错误');
}

const mode = ref(['single', 'batch', 'book', 'profile', 'cover', 'train', 'settings'].includes(hashMode) ? hashMode : 'single');
const queue = ref([]);
const batchRunning = ref(false);
const batchDir = ref('');
const batchDoneCount = ref(0);
const batchTotal = ref(0);
const batchCanceling = ref(false);

// ---- 自动更新 ----
const updateState = ref({ status: 'idle', percent: 0, version: '' });
const updateLabel = computed(() => {
  const s = updateState.value || {};
  if (s.status === 'checking') return '检查中…';
  if (s.status === 'available') return '发现新版本';
  if (s.status === 'downloading') return `下载 ${s.percent}%`;
  if (s.status === 'downloaded') return '重启更新';
  if (s.status === 'latest') return '已是最新';
  if (s.status === 'error') return '检查更新';
  return '检查更新';
});

async function checkUpdate() {
  const s = updateState.value || {};
  if (s.status === 'downloaded') {
    await window.api.updaterInstall();
    return;
  }
  const res = await window.api.updaterCheck();
  if (!res.ok) {
    updateState.value = { status: 'error', percent: 0, error: res.error };
    error.value = res.error;
  }
}

// ---- 参考音频裁剪 ----
const cvEl = ref(null);
const peaks = ref([]);
const waveDur = ref(0);
const selStart = ref(0);
const selEnd = ref(0);
const trimming = ref(false);
const previewUrl = ref('');
let dragAnchor = null;
let dragging = false;

const params = ref({
  speed: 1.0,
  steps: 8,
  topK: 15,
  topP: 1.0,
  temperature: 1.0,
  split: 'cut0'
});

const splitOptions = [
  { value: 'cut0', label: '不切（推荐：一句一句合）' },
  { value: 'cut5', label: '按标点切' },
  { value: 'cut2', label: '凑 50 字一切' },
  { value: 'cut1', label: '凑四句一切' }
];

let timer = null;

watch(mode, () => {
  error.value = '';
  const readMode = mode.value === 'single' || mode.value === 'batch' || mode.value === 'book';
  if (!readMode) return;
  if (!currentVoice.value || currentVoice.value.role !== 'sing') return;
  const read = voices.value.find((v) => v.role === 'read');
  if (read) pickVoice(read);
});

const charCount = computed(() => text.value.replace(/\s/g, '').length);
const canRun = computed(() => ready.value && !running.value && text.value.trim() && currentRef.value && currentVoice.value);
const selDur = computed(() => Math.max(0, selEnd.value - selStart.value));
const selValid = computed(() => selDur.value >= 3 && selDur.value <= 10);

async function loadWave() {
  peaks.value = [];
  waveDur.value = 0;
  previewUrl.value = '';
  if (!currentRef.value) return;
  const res = await window.api.readAudio({ path: currentRef.value.path });
  if (!res.ok) return;
  const bin = atob(res.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const ch = buf.getChannelData(0);
    const buckets = 700;
    const step = Math.max(1, Math.floor(ch.length / buckets));
    const out = [];
    for (let i = 0; i < buckets; i += 1) {
      let peak = 0;
      const start = i * step;
      for (let j = start; j < Math.min(ch.length, start + step); j += 4) {
        const v = Math.abs(ch[j]);
        if (v > peak) peak = v;
      }
      out.push(peak);
    }
    peaks.value = out;
    waveDur.value = buf.duration;
    selStart.value = 0;
    selEnd.value = Math.min(buf.duration, 10);
    ctx.close();
    draw();
  } catch (err) {
    error.value = '读取波形失败：' + (err.message || err);
  }
}

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (_) { return fallback; }
}
function draw() {
  const cv = cvEl.value;
  if (!cv || !peaks.value.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);

  const toX = (t) => (t / (waveDur.value || 1)) * w;
  const x0 = toX(selStart.value);
  const x1 = toX(selEnd.value);

  // 选区背景
  g.fillStyle = cssVar('--accent-soft', 'rgba(255,138,61,0.10)');
  g.fillRect(x0, 0, Math.max(1, x1 - x0), h);

  // 波形
  const n = peaks.value.length;
  const barW = w / n;
  for (let i = 0; i < n; i += 1) {
    const x = i * barW;
    const inSel = x >= x0 && x <= x1;
    const amp = Math.max(0.02, peaks.value[i]);
    const bh = amp * (h - 6);
    g.fillStyle = inSel ? cssVar('--accent', '#ff8a3d') : cssVar('--muted-2', 'rgba(180,190,205,0.42)');
    g.fillRect(x, (h - bh) / 2, Math.max(0.6, barW - 0.6), bh);
  }

  // 边界线
  g.fillStyle = cssVar('--accent', '#ff8a3d');
  g.fillRect(x0 - 1, 0, 2, h);
  g.fillRect(x1 - 1, 0, 2, h);
}

function pointerTime(ev) {
  const cv = cvEl.value;
  const rect = cv.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  return ratio * waveDur.value;
}

function onWaveDown(ev) {
  if (!waveDur.value) return;
  dragging = true;
  dragAnchor = pointerTime(ev);
  selStart.value = dragAnchor;
  selEnd.value = dragAnchor;
  window.addEventListener('mousemove', onWaveMove);
  window.addEventListener('mouseup', onWaveUp);
}

function onWaveMove(ev) {
  if (!dragging) return;
  const t = pointerTime(ev);
  selStart.value = Math.min(dragAnchor, t);
  selEnd.value = Math.max(dragAnchor, t);
  draw();
}

function onWaveUp() {
  dragging = false;
  window.removeEventListener('mousemove', onWaveMove);
  window.removeEventListener('mouseup', onWaveUp);
  if (selDur.value < 0.2) {
    selStart.value = 0;
    selEnd.value = Math.min(waveDur.value, 10);
  }
  draw();
}

function resetSel() {
  selStart.value = 0;
  selEnd.value = Math.min(waveDur.value, 10);
  draw();
}

async function previewSel() {
  if (!currentRef.value || !waveDur.value) return;
  trimming.value = true;
  const res = await window.api.trimRef({
    src: currentRef.value.path, start: selStart.value, end: selEnd.value, save: false
  });
  trimming.value = false;
  if (!res.ok) { error.value = res.error; return; }
  previewUrl.value = 'data:audio/wav;base64,' + res.base64;
}

async function saveSelAsRef() {
  if (!currentRef.value || !waveDur.value) return;
  trimming.value = true;
  const res = await window.api.trimRef({
    src: currentRef.value.path,
    start: selStart.value,
    end: selEnd.value,
    save: true,
    name: currentRef.value.name + '_clip'
  });
  trimming.value = false;
  if (!res.ok) { error.value = res.error; return; }
  refs.value = await window.api.refs();
  const item = refs.value.find((r) => r.path === res.item.path);
  if (item) selectRef(item);
}

onMounted(async () => {
  window.addEventListener('vs-theme', () => { try { draw(); } catch (_) {} });
  window.addEventListener('vs-open-cover', (e) => {
    const d = e && e.detail ? e.detail : {};
    coverPitch.value = typeof d.pitch === 'number' ? d.pitch : null;
    mode.value = 'cover';
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F1') { e.preventDefault(); showGuide.value = !showGuide.value; }
  });
  window.api.on('phase', (p) => {
    if (p.phase === 'ready') {
      const first = !ready.value;
      ready.value = true;
      error.value = '';
      // 服务刚就绪：把选中/首个音色应用到后端
      if (first && voices.value.length && !voiceApplied) {
        const target = currentVoice.value || voices.value.find((x) => x.role === 'read') || voices.value[0];
        pickVoice(target);
      }
    }
  });
  window.api.on('log', (l) => {
    log.value.push(l);
    if (log.value.length > 300) log.value.splice(0, 60);
  });
  window.api.on('batch:item', (p) => {
    const item = queue.value[p.index];
    if (!item) return;
    item.status = p.status;
    if (p.status === 'done') {
      item.dur = p.dur;
      item.path = p.path;
      item.elapsed = p.elapsed;
      batchDoneCount.value += 1;
    }
    if (p.status === 'failed') item.error = p.error;
  });
  window.api.on('batch:done', (p) => {
    batchRunning.value = false;
    batchCanceling.value = false;
    batchDir.value = p.dir;
    batchDoneCount.value = p.ok;
    batchTotal.value = p.total;
  });
  window.api.on('updater', (s) => { updateState.value = s || {}; });
  window.api.updaterState().then((s) => { if (s) updateState.value = s; }).catch(() => {});

  const v = await window.api.voices();
  voices.value = v.pairs || [];
  // 服务没就绪时不要调 /set_*_weights，否则会报 ECONNREFUSED；
  // 等 phase=ready 事件到来再应用。
  const initial = voices.value.find((x) => x.role === 'read') || voices.value[0];
  if (ready.value && initial) await pickVoice(initial);
  else if (initial) currentVoice.value = initial;

  const r = await window.api.refs();
  refs.value = r || [];
  if (refs.value.length) selectRef(refs.value[0]);

  if (props.phase === 'ready') ready.value = true;
});

onUnmounted(() => clearInterval(timer));

async function pickVoice(pair) {
  currentVoice.value = pair;
  if (!ready.value) return; // 服务未就绪，等 ready 事件再应用
  const res = await window.api.selectVoice({ sovits: pair.sovits, gpt: pair.gpt });
  if (res.ok) {
    voiceApplied.value = true;
    return;
  }
  // 服务刚重启时的连接拒绝不弹窗，等 ready 后会自动重试
  if (!/ECONNREFUSED|ECONNRESET/.test(res.error || '')) {
    error.value = '切换音色失败：' + res.error;
  }
}

async function reloadVoices() {
  const v = await window.api.voices();
  voices.value = v.pairs || [];
  const cur = currentVoice.value;
  const still = cur && voices.value.find((p) => p.sovits === cur.sovits);
  if (still) return;
  if (voices.value.length) await pickVoice(voices.value[0]);
}

async function deleteRef(r) {
  const res = await window.api.deleteRef({ path: r.path });
  if (!res.ok) { error.value = res.error; return; }
  refs.value = await window.api.refs();
  if (currentRef.value && currentRef.value.path === r.path) {
    selectRef(refs.value[0] || null);
  }
}

async function tidyRefs() {
  const res = await window.api.tidyRefs();
  if (!res.ok) { error.value = res.error; return; }
  refs.value = await window.api.refs();
  if (!refs.value.find((x) => currentRef.value && x.path === currentRef.value.path)) {
    selectRef(refs.value[0] || null);
  }
  error.value = '';
}

async function importRef() {
  const res = await window.api.importRef();
  if (res.ok) {
    refs.value = await window.api.refs();
    const idx = refs.value.findIndex((r) => r.path === res.item.path);
    if (idx >= 0) selectRef(refs.value[idx]);
  }
}

function selectRef(r) {
  currentRef.value = r;
  refText.value = (r && r.text) || '';
  loadWave();
}

async function saveRefText() {
  if (!currentRef.value) return;
  currentRef.value.text = refText.value;
  await window.api.updateRefText({ path: currentRef.value.path, text: refText.value });
}

async function synthesize() {
  if (!canRun.value) return;
  error.value = '';
  result.value = null;
  running.value = true;
  elapsed.value = 0;
  const t0 = Date.now();
  timer = setInterval(() => { elapsed.value = ((Date.now() - t0) / 1000).toFixed(1); }, 100);

  const res = await window.api.tts({
    text: text.value.trim(),
    refPath: currentRef.value.path,
    refText: refText.value,
    speed: Number(params.value.speed),
    sampleSteps: Number(params.value.steps),
    topK: Number(params.value.topK),
    topP: Number(params.value.topP),
    temperature: Number(params.value.temperature),
    splitMethod: params.value.split
  });

  clearInterval(timer);
  running.value = false;

  if (!res.ok) {
    error.value = res.error;
    return;
  }
  result.value = {
    url: 'data:audio/wav;base64,' + res.base64,
    path: res.path,
    bytes: res.bytes,
    elapsed: res.elapsed
  };
  history.value.unshift({
    url: result.value.url,
    path: res.path,
    text: text.value.trim().slice(0, 40),
    voice: currentVoice.value ? currentVoice.value.name : '',
    time: new Date().toLocaleTimeString().slice(0, 5)
  });
  if (history.value.length > 12) history.value.pop();
}

// ---------- 批量队列 ----------

function splitText(t) {
  const lines = String(t).split(/\r?\n+/);
  const sentences = [];
  for (const line of lines) {
    for (const seg of line.split(/(?<=[。！？；!?;])/)) {
      const s = seg.trim();
      if (s) sentences.push(s);
    }
  }
  const out = [];
  for (const s of sentences) {
    if (s.length <= 40) { out.push(s); continue; }
    let buf = '';
    for (const c of s.split(/(?<=[，、,])/)) {
      if ((buf + c).length <= 40) buf += c;
      else { if (buf) out.push(buf); buf = c; }
    }
    if (buf) out.push(buf);
  }
  return out;
}

function buildQueue() {
  const parts = splitText(text.value);
  if (!parts.length) { error.value = '先在文本框里写点东西'; return; }
  queue.value = parts.map((s) => ({ text: s, status: 'idle', dur: 0, path: '', error: '' }));
  batchDoneCount.value = 0;
  batchTotal.value = parts.length;
  batchDir.value = '';
  mode.value = 'batch';
}

async function runBatch(onlyFailed = false) {
  if (!currentRef.value || !queue.value.length || batchRunning.value) return;
  error.value = '';
  const items = [];
  queue.value.forEach((q, i) => {
    if (onlyFailed && q.status === 'done') return;
    q.status = 'idle';
    q.error = '';
    q.dur = 0;
    items.push({ index: i, text: q.text });
  });
  if (!items.length) return;
  batchRunning.value = true;
  batchCanceling.value = false;
  batchDoneCount.value = 0;
  batchTotal.value = items.length;
  await window.api.batchRun({
    items,
    refPath: currentRef.value.path,
    refText: refText.value,
    speed: Number(params.value.speed),
    sampleSteps: Number(params.value.steps),
    topK: Number(params.value.topK),
    topP: Number(params.value.topP),
    temperature: Number(params.value.temperature)
  });
  batchRunning.value = false;
}

async function cancelBatch() {
  batchCanceling.value = true;
  await window.api.batchCancel();
}

async function exportBatch() {
  if (!batchDir.value) return;
  const res = await window.api.batchExport({ dir: batchDir.value });
  if (!res.ok) error.value = res.error;
}

async function playItem(item) {
  if (!item.path) return;
  const res = await window.api.readAudio({ path: item.path });
  if (res.ok) result.value = { url: 'data:audio/wav;base64,' + res.base64, path: item.path, bytes: 0, elapsed: item.elapsed };
}

function statusLabel(s) {
  return ({ idle: '待合成', running: '合成中', done: '完成', failed: '失败', canceled: '已取消' })[s] || s;
}

function useSample() {
  text.value = '古之学者必有师。师者，所以传道受业解惑也。人非生而知之者，孰能无惑？';
}

function copyPath() {
  if (result.value) navigator.clipboard.writeText(result.value.path);
}

function replay(item) {
  result.value = { url: item.url, path: item.path, bytes: 0, elapsed: '-' };
}
</script>

<template>
  <div class="studio">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo">
          <svg width="26" height="26" viewBox="0 0 34 34" fill="none">
            <rect x="6" y="12" width="3.4" height="10" rx="1.7" fill="currentColor" opacity=".55"/>
            <rect x="12.2" y="8" width="3.4" height="18" rx="1.7" fill="currentColor" opacity=".8"/>
            <rect x="18.4" y="5" width="3.4" height="24" rx="1.7" fill="currentColor"/>
            <rect x="24.6" y="9.5" width="3.4" height="15" rx="1.7" fill="currentColor" opacity=".7"/>
          </svg>
        </div>
        <div class="brand-text">
          <div class="brand-name">织声</div>
          <div class="brand-sub">WeaveVoice</div>
        </div>
      </div>

      <nav class="nav">
        <button
          v-for="m in MODES" :key="m.id"
          class="nav-item" :class="{ on: mode === m.id }"
          @click="mode = m.id"
        >
          <span class="nav-icon" v-html="m.icon"></span>
          <span class="nav-label">{{ m.label }}</span>
          <span class="nav-badge" v-if="m.id === 'single' && running">●</span>
        </button>
      </nav>

      <div class="side-group" v-if="sideInfo">
        <div class="side-head">音色</div>
        <div class="side-list">
          <button
            v-for="v in voices" :key="v.sovits"
            class="voice-row" :class="{ on: currentVoice && currentVoice.sovits === v.sovits }"
            @click="pickVoice(v)"
          >
            <span class="voice-dot"></span>
            <span class="voice-name">{{ v.name }}</span>
            <span class="voice-role" :class="v.role">{{ v.role === 'sing' ? '唱' : '读' }}</span>
          </button>
          <div v-if="!voices.length" class="empty">没有找到模型权重</div>
        </div>
      </div>

      <div class="side-group grow" v-if="refInfo">
        <div class="side-head">
          参考音频
          <span class="head-actions">
            <button class="mini" @click="tidyRefs" :disabled="!refs.length">整理</button>
            <button class="mini" @click="importRef">导入</button>
          </span>
        </div>
        <div class="side-list scroll">
          <div v-for="r in refs" :key="r.path" class="ref-item">
            <button
              class="ref-row" :class="{ on: currentRef && currentRef.path === r.path }"
              @click="selectRef(r)" :title="r.text || '缺参考文本'"
            >
              <span class="ref-name">{{ r.name }}</span>
              <span class="ref-state" :class="{ ok: r.text }">{{ r.text ? '已填词' : '缺词' }}</span>
            </button>
            <button class="ref-del" title="删除" @click.stop="deleteRef(r)">×</button>
          </div>
          <div v-if="!refs.length" class="empty">还没有参考音频</div>
        </div>
      </div>

      <div class="side-foot">
        <div class="status" :class="{ ok: ready }">
          <span class="dot"></span>{{ ready ? '服务就绪' : '启动中…' }}
        </div>
        <div class="foot-row">
          <button class="ghost mini" @click="openOutput">输出目录</button>
          <button class="ghost mini" @click="checkUpdate">{{ updateLabel }}</button>
        </div>
      </div>
      <pre v-if="showLog" class="log mono">{{ log.join('\n') }}</pre>
    </aside>

    <main class="main">
      <header class="page-head">
        <div class="page-title">
          <h1>{{ pageTitle }}</h1>
          <p>{{ pageSubtitle }}</p>
        </div>
        <div class="page-meta">
          <span class="pill" v-if="currentVoice">
            {{ currentVoice.name }} · {{ currentVoice.role === 'sing' ? '唱歌' : '朗读' }}
          </span>
          <span class="pill" v-if="mode === 'single' && running">合成中 {{ elapsed }}s</span>
        </div>
      </header>

      <div class="page-body" ref="bodyEl">
        <Train v-if="mode === 'train'" @refresh="reloadVoices" />
        <Book v-else-if="mode === 'book'" :ready="ready" />
        <Profile v-else-if="mode === 'profile'" />
        <Cover v-else-if="mode === 'cover'" :ready="ready" :pitch-hint="coverPitch" />
        <Settings v-else-if="mode === 'settings'" :voices-count="voices.length" @guide="showGuide = true" />

        <div v-else class="synth">
          <div class="synth-main">
            <section class="card editor">
              <div class="editor-head">
                <span>合成文本</span>
                <div class="editor-actions">
                  <span class="count mono">{{ charCount }} 字</span>
                  <button class="mini" @click="useSample">示例</button>
                  <button class="mini" @click="text = ''">清空</button>
                </div>
              </div>
              <textarea
                v-model="text"
                class="text"
                placeholder="输入要合成的文字…（建议一次一句，30 字以内最稳）"
                spellcheck="false"
                @keydown.ctrl.enter.prevent="synthesize"
              ></textarea>
            </section>

            <section class="card">
              <div class="editor-head">
                <span>参考音频文本 <em>（必须与音频逐字对应）</em></span>
                <span class="muted mono">{{ currentRef ? currentRef.name : '未选择' }}</span>
              </div>
              <input
                v-if="currentRef"
                v-model="refText"
                type="text"
                class="mono wide"
                placeholder="这段参考音频里说的原话，例如：嗟乎，师道之不传也久矣"
                @blur="saveRefText"
              />
            </section>

            <section v-if="currentRef" class="card">
              <div class="editor-head">
                <span>参考音频裁剪 <em>（拖动波形取 3~10 秒）</em></span>
                <span class="muted mono">
                  {{ selDur.toFixed(2) }}s / {{ waveDur ? waveDur.toFixed(1) + 's' : '—' }}
                  <em :class="selValid ? 'ok' : 'warn'">{{ selValid ? '合规' : '需 3~10 秒' }}</em>
                </span>
              </div>
              <canvas ref="cvEl" class="wave-cv" @mousedown.prevent="onWaveDown"></canvas>
              <div class="wave-actions">
                <button class="mini" :disabled="trimming || !selValid" @click="previewSel">试听选区</button>
                <button class="mini" :disabled="trimming || !selValid" @click="saveSelAsRef">存为新参考</button>
                <button class="mini" :disabled="!waveDur" @click="resetSel">重置</button>
                <span class="muted" v-if="trimming">处理中…</span>
              </div>
              <audio v-if="previewUrl" :src="previewUrl" controls autoplay class="preview-audio"></audio>
            </section>

            <section v-if="mode === 'batch'" class="card">
              <div class="editor-head">
                <span>批量队列 <em>（{{ queue.length }} 句）</em></span>
                <span class="muted mono" v-if="batchRunning">{{ batchDoneCount }} / {{ batchTotal }}</span>
              </div>
              <div class="q-list">
                <div v-for="(q, i) in queue" :key="i" class="q-row" :class="q.status" :title="q.error || ''">
                  <span class="q-index mono">{{ String(i + 1).padStart(2, '0') }}</span>
                  <span class="q-text">{{ q.text }}</span>
                  <span class="q-dur mono" v-if="q.dur">{{ q.dur.toFixed(1) }}s</span>
                  <span class="q-state" :class="q.status">{{ statusLabel(q.status) }}</span>
                  <button v-if="q.path" class="mini" @click="playItem(q)">试听</button>
                </div>
                <div v-if="!queue.length" class="empty">点右侧「重建队列」，按句号/问号自动拆句</div>
              </div>
            </section>

            <section v-if="mode === 'single' && result" class="card">
              <div class="editor-head">
                <span>合成结果</span>
                <span class="muted mono">{{ result.elapsed }}s · {{ (result.bytes / 1024).toFixed(0) }} KB</span>
              </div>
              <audio :src="result.url" controls autoplay></audio>
              <div class="path-row">
                <span class="mono path">{{ result.path }}</span>
                <button class="mini" @click="copyPath">复制路径</button>
                <button class="mini" @click="openOutput">打开目录</button>
              </div>
            </section>

            <section v-if="mode === 'single' && history.length" class="card">
              <div class="editor-head"><span>本次生成</span></div>
              <div class="hist-list">
                <button v-for="h in history" :key="h.path" class="hist" @click="replay(h)">
                  <span class="hist-time mono">{{ h.time }}</span>
                  <span class="hist-text">{{ h.text }}</span>
                  <span class="hist-voice">{{ h.voice }}</span>
                </button>
              </div>
            </section>

            <div v-if="error" class="alert">{{ error }}</div>
          </div>

          <aside class="synth-side">
            <section class="inspector">
              <div class="inspector-head">生成参数</div>

              <div class="field">
                <div class="field-label"><span>语速</span><b class="mono">{{ params.speed.toFixed(2) }}</b></div>
                <input type="range" min="0.6" max="1.65" step="0.05" v-model.number="params.speed" />
              </div>

              <div class="field">
                <div class="field-label"><span>采样步数</span><b class="mono">{{ params.steps }}</b></div>
                <select v-model.number="params.steps">
                  <option :value="4">4（最快）</option>
                  <option :value="8">8（推荐）</option>
                  <option :value="16">16</option>
                  <option :value="32">32（最慢）</option>
                </select>
              </div>

              <div class="inspector-sep"></div>

              <div class="field">
                <div class="field-label"><span>top_k</span><b class="mono">{{ params.topK }}</b></div>
                <input type="range" min="1" max="100" step="1" v-model.number="params.topK" />
              </div>

              <div class="field">
                <div class="field-label"><span>top_p</span><b class="mono">{{ params.topP.toFixed(2) }}</b></div>
                <input type="range" min="0" max="1" step="0.05" v-model.number="params.topP" />
              </div>

              <div class="field">
                <div class="field-label"><span>temperature</span><b class="mono">{{ params.temperature.toFixed(2) }}</b></div>
                <input type="range" min="0" max="1" step="0.05" v-model.number="params.temperature" />
              </div>

              <div class="inspector-sep"></div>

              <div class="field">
                <div class="field-label"><span>切分方式</span></div>
                <select v-model="params.split">
                  <option v-for="o in splitOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </div>

              <div class="inspector-sep"></div>

              <div class="run-box">
                <template v-if="mode === 'single'">
                  <button class="primary wide" :disabled="!canRun" @click="synthesize">
                    {{ running ? '合成中…' : '合成语音' }}
                  </button>
                  <span class="kbd-hint">Ctrl + Enter</span>
                </template>
                <template v-else>
                  <button class="primary wide" :disabled="!queue.length || !currentRef || batchRunning" @click="runBatch(false)">
                    {{ batchRunning ? `合成中 ${batchDoneCount}/${batchTotal}` : '开始批量合成' }}
                  </button>
                  <button class="wide" :disabled="batchRunning" @click="buildQueue">重建队列</button>
                  <button v-if="batchRunning" class="wide" :disabled="batchCanceling" @click="cancelBatch">取消</button>
                  <button v-else class="wide" :disabled="!queue.length" @click="runBatch(true)">只重试未完成</button>
                  <button class="wide" :disabled="!batchDir" @click="exportBatch">导出 zip</button>
                </template>
              </div>
            </section>

          </aside>
        </div>
      </div>
    </main>

    <GuideOverlay :open="showGuide" @close="showGuide = false" />
  </div>
</template>

<style scoped>
.studio {
  display: flex;
  height: 100%;
  background: var(--bg);
}

/* ---------- 侧栏 ---------- */
.sidebar {
  width: 274px;
  flex: 0 0 274px;
  display: flex;
  flex-direction: column;
  padding: 16px 12px 12px;
  gap: 14px;
  background: var(--rail);
  border-right: 1px solid var(--line);
  backdrop-filter: blur(24px) saturate(180%);
}

.brand { display: flex; align-items: center; gap: 10px; padding: 2px 6px 0; }
.logo { color: var(--accent); display: flex; }
.brand-name { font-size: 15px; font-weight: 650; letter-spacing: 0.02em; }
.brand-sub { font-size: 10.5px; color: var(--muted-2); letter-spacing: 0.04em; }

.nav { display: flex; flex-direction: column; gap: 1px; }
.nav-item {
  justify-content: flex-start;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font-weight: 480;
}
.nav-item:hover:not(.on) { background: var(--panel-2); }
.nav-item.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 560;
}
.nav-icon { display: flex; width: 17px; height: 17px; opacity: 0.9; }
.nav-icon svg { width: 17px; height: 17px; }
.nav-label { flex: 1; text-align: left; }
.nav-badge { font-size: 8px; color: var(--ok); }

.side-group { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.side-group.grow { flex: 1; }
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 590;
  letter-spacing: 0.04em;
  color: var(--muted-2);
  text-transform: uppercase;
}
.head-actions { display: flex; gap: 2px; text-transform: none; letter-spacing: 0; }

.side-list { display: flex; flex-direction: column; gap: 1px; }
.side-list.scroll { overflow: auto; min-height: 0; padding-right: 2px; }

.voice-row {
  justify-content: flex-start;
  gap: 8px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-xs);
  background: transparent;
  font-weight: 450;
  color: var(--text-2);
}
.voice-row:hover:not(.on) { background: var(--panel-2); }
.voice-row.on { background: var(--panel); box-shadow: var(--shadow-sm); color: var(--text); font-weight: 560; }
.voice-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-2); flex: 0 0 auto; }
.voice-row.on .voice-dot { background: var(--ok); }
.voice-name { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; }
.voice-role {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--muted);
}
.voice-role.sing { background: var(--accent-soft); color: var(--accent); }

.ref-item { display: flex; align-items: center; gap: 2px; }
.ref-row {
  flex: 1;
  justify-content: space-between;
  gap: 8px;
  height: 30px;
  padding: 0 9px;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-2);
  font-weight: 450;
}
.ref-row:hover:not(.on) { background: var(--panel-2); }
.ref-row.on { background: var(--panel); box-shadow: var(--shadow-sm); color: var(--text); }
.ref-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref-state { font-size: 10px; color: var(--warn); }
.ref-state.ok { color: var(--ok); }
.ref-del {
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  color: var(--muted-2);
  opacity: 0;
  font-size: 14px;
}
.ref-item:hover .ref-del { opacity: 1; }
.ref-del:hover { color: var(--err); background: transparent; }

.side-foot {
  border-top: 1px solid var(--line-soft);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  font-size: 11.5px;
  color: var(--muted);
}
.status .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }
.status.ok .dot { background: var(--ok); }
.foot-row { display: flex; gap: 4px; }
.foot-row button { flex: 1; justify-content: flex-start; }
.log {
  max-height: 120px;
  overflow: auto;
  margin: 0;
  padding: 8px;
  border-radius: var(--radius-xs);
  background: var(--inset);
  color: var(--muted);
  font-size: 10.5px;
  user-select: text;
}

/* ---------- 主区 ---------- */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 28px 14px;
}
.page-title h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 680;
  letter-spacing: -0.01em;
}
.page-title p { margin: 3px 0 0; font-size: 12.5px; color: var(--muted); }
.page-meta { display: flex; gap: 8px; align-items: center; }

.page-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 28px 28px;
}
.page-body > * { max-width: 1120px; }

.synth {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.synth-main { flex: 1; min-width: 0; }
.synth-side {
  width: 296px;
  flex: 0 0 296px;
  position: sticky;
  top: 0;
}

.editor .count { color: var(--muted-2); font-size: 11.5px; }
.editor-actions { display: flex; align-items: center; gap: 4px; }
.text {
  width: 100%;
  min-height: 148px;
  border-radius: 10px;
  font-size: 13.5px;
  font-family: var(--font);
}
.wide, input.wide { width: 100%; }

.wave-cv {
  width: 100%;
  height: 84px;
  border-radius: 10px;
  background: var(--inset);
  cursor: crosshair;
  display: block;
}
.wave-actions { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.preview-audio { width: 100%; height: 34px; margin-top: 8px; }
audio { width: 100%; height: 34px; }

.inspector {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 16px 18px 18px;
  box-shadow: var(--shadow-sm);
}
.inspector-head {
  font-size: 12px;
  font-weight: 620;
  letter-spacing: 0.02em;
  color: var(--muted);
  margin-bottom: 14px;
}
.inspector-sep {
  height: 1px;
  background: var(--line-soft);
  margin: 14px 0;
}
.field { display: flex; flex-direction: column; gap: 7px; margin-bottom: 14px; }
.field:last-child { margin-bottom: 0; }
.field-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}
.field-label b {
  color: var(--text);
  font-weight: 560;
  font-size: 12px;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--panel-2);
}

.run-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line-soft);
}
.run-box button.wide { width: 100%; height: 38px; font-size: 13.5px; }
.kbd-hint { text-align: center; font-size: 11px; color: var(--muted-2); }

.path-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--muted-2);
}

.q-list { display: flex; flex-direction: column; gap: 1px; max-height: 40vh; overflow: auto; }
.q-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--radius-xs);
  font-size: 12.5px;
}
.q-row:nth-child(odd) { background: var(--panel-2); }
.q-index { color: var(--muted-2); font-size: 11px; width: 20px; }
.q-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q-dur { color: var(--muted-2); font-size: 11px; }
.q-state { font-size: 11px; color: var(--muted-2); }
.q-state.done { color: var(--ok); }
.q-state.failed { color: var(--err); }
.q-state.running { color: var(--accent); }

.hist-list { display: flex; flex-direction: column; gap: 1px; }
.hist {
  justify-content: flex-start;
  gap: 10px;
  height: 30px;
  padding: 0 8px;
  background: transparent;
  border-radius: var(--radius-xs);
  font-weight: 450;
}
.hist:hover { background: var(--panel-2); }
.hist-time { color: var(--muted-2); font-size: 11px; }
.hist-text { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-voice { color: var(--muted-2); font-size: 11px; }

.ok { color: var(--ok); }
.warn { color: var(--warn); }
</style>
