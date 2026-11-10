<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import Train from './Train.vue';
import Settings from './Settings.vue';
import Book from './Book.vue';

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
const mode = ref(['single', 'batch', 'book', 'train', 'settings'].includes(hashMode) ? hashMode : 'single');
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

watch(mode, () => { error.value = ''; });

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
  g.fillStyle = 'rgba(255,138,61,0.10)';
  g.fillRect(x0, 0, Math.max(1, x1 - x0), h);

  // 波形
  const n = peaks.value.length;
  const barW = w / n;
  for (let i = 0; i < n; i += 1) {
    const x = i * barW;
    const inSel = x >= x0 && x <= x1;
    const amp = Math.max(0.02, peaks.value[i]);
    const bh = amp * (h - 6);
    g.fillStyle = inSel ? '#ff8a3d' : 'rgba(180,190,205,0.42)';
    g.fillRect(x, (h - bh) / 2, Math.max(0.6, barW - 0.6), bh);
  }

  // 边界线
  g.fillStyle = '#ff8a3d';
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
  window.api.on('phase', (p) => {
    if (p.phase === 'ready') {
      const first = !ready.value;
      ready.value = true;
      error.value = '';
      // 服务刚就绪：把选中/首个音色应用到后端
      if (first && voices.value.length && !voiceApplied) pickVoice(voices.value[0]);
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
  if (ready.value && voices.value.length) await pickVoice(voices.value[0]);
  else if (voices.value.length) currentVoice.value = voices.value[0];

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
          <svg width="24" height="24" viewBox="0 0 34 34" fill="none">
            <rect x="6" y="12" width="3.2" height="10" rx="1.6" fill="#ff8a3d"/>
            <rect x="12.2" y="8" width="3.2" height="18" rx="1.6" fill="#ff8a3d"/>
            <rect x="18.4" y="5" width="3.2" height="24" rx="1.6" fill="#ffb26b"/>
            <rect x="24.6" y="9.5" width="3.2" height="15" rx="1.6" fill="#ff8a3d"/>
          </svg>
        </div>
        <div class="brand-text">
          <div class="brand-name">声匠</div>
          <div class="brand-sub">VoiceSmith · 语音合成工作台</div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">音色</div>
        <div class="voice-list">
          <button
            v-for="v in voices" :key="v.sovits"
            class="voice" :class="{ active: currentVoice && currentVoice.sovits === v.sovits }"
            @click="pickVoice(v)"
          >
            <span class="voice-dot"></span>
            <span class="voice-name">{{ v.name }}</span>
            <span class="voice-tag">{{ v.gpt ? '已训练' : '仅 SoVITS' }}</span>
          </button>
          <div v-if="!voices.length" class="empty">没有找到模型权重</div>
        </div>
      </div>

      <div class="section grow">
        <div class="section-head">
          参考音频
          <span class="head-actions">
            <button class="mini" @click="tidyRefs" :disabled="!refs.length">整理</button>
            <button class="mini" @click="importRef">导入</button>
          </span>
        </div>
        <div class="ref-list">
          <div
            v-for="r in refs" :key="r.path"
            class="ref-row"
          >
            <button
              class="ref" :class="{ active: currentRef && currentRef.path === r.path }"
              @click="selectRef(r)" :title="r.text || '缺参考文本'"
            >
              <span class="ref-name">{{ r.name }}</span>
              <span class="ref-state" :class="{ ok: r.text }">{{ r.text ? '已填词' : '缺词' }}</span>
            </button>
            <button class="ref-del" title="删除" @click.stop="deleteRef(r)">×</button>
          </div>
          <div v-if="!refs.length" class="empty">还没有参考音频，点右上角「导入」</div>
        </div>
      </div>

      <div class="sidebar-foot">
        <button class="ghost" @click="window.api.openOutput()">输出目录</button>
        <button class="ghost" @click="checkUpdate">{{ updateLabel }}</button>
      </div>
      <pre v-if="showLog" class="log mono">{{ log.join('\n') }}</pre>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="status" :class="{ ok: ready }">
          <span class="dot"></span>
          {{ ready ? '服务就绪' : '服务启动中…' }}
        </div>
        <div class="current">
          <span class="muted">当前音色</span>
          <b>{{ currentVoice ? currentVoice.name : '—' }}</b>
        </div>
        <div class="seg">
          <button :class="{ on: mode === 'single' }" @click="mode = 'single'">单句</button>
          <button :class="{ on: mode === 'batch' }" @click="mode = 'batch'">批量</button>
          <button :class="{ on: mode === 'book' }" @click="mode = 'book'">音频书</button>
          <button :class="{ on: mode === 'train' }" @click="mode = 'train'">训练</button>
          <button :class="{ on: mode === 'settings' }" @click="mode = 'settings'">设置</button>
        </div>
        <div class="spacer"></div>
        <div class="muted mono" v-if="running">合成中 {{ elapsed }}s</div>
      </header>

      <Train v-if="mode === 'train'" @refresh="reloadVoices" />
      <Book v-else-if="mode === 'book'" :ready="ready" />
      <Settings v-else-if="mode === 'settings'" :voices-count="voices.length" />

      <template v-else>

      <section class="editor card">
        <div class="editor-head">
          <span>合成文本</span>
          <div class="editor-actions">
            <button class="mini" @click="useSample">示例</button>
            <button class="mini" @click="text = ''">清空</button>
            <span class="count mono">{{ charCount }} 字</span>
          </div>
        </div>
        <textarea
          v-model="text"
          class="text mono"
          placeholder="输入要合成的文字…（建议一次一句，30 字以内最稳）"
          spellcheck="false"
          @keydown.ctrl.enter.prevent="synthesize"
        ></textarea>
      </section>

      <section class="ref-editor card">
        <div class="editor-head">
          <span>参考音频文本 <em class="muted">（必须和音频逐字对应，留空则用无参考文本模式）</em></span>
          <span class="muted mono">{{ currentRef ? currentRef.name : '未选择' }}</span>
        </div>
        <input
          v-if="currentRef"
          v-model="refText"
          type="text"
          class="mono"
          placeholder="这段参考音频里说的原话，例如：嗟乎，师道之不传也久矣"
          @blur="saveRefText"
        />
      </section>

      <section v-if="currentRef" class="wave card">
        <div class="editor-head">
          <span>
            参考音频裁剪
            <em class="muted">（拖动波形选区，取 3~10 秒）</em>
          </span>
          <span class="muted mono">
            {{ selDur.toFixed(2) }}s / {{ waveDur ? waveDur.toFixed(1) + 's' : '—' }}
            <em :class="selValid ? 'ok' : 'warn'">{{ selValid ? '范围合规' : '需 3~10 秒' }}</em>
          </span>
        </div>
        <canvas
          ref="cvEl"
          class="wave-cv"
          @mousedown.prevent="onWaveDown"
        ></canvas>
        <div class="wave-actions">
          <button class="mini" :disabled="trimming || !selValid" @click="previewSel">试听选区</button>
          <button class="mini" :disabled="trimming || !selValid" @click="saveSelAsRef">保存为新参考</button>
          <button class="mini" :disabled="!waveDur" @click="resetSel">重置选区</button>
          <span class="muted" v-if="trimming">处理中…</span>
        </div>
        <audio v-if="previewUrl" :src="previewUrl" controls autoplay class="preview-audio"></audio>
      </section>

      <section class="params card">
        <div class="param">
          <label>语速 <b class="mono">{{ params.speed.toFixed(2) }}</b></label>
          <input type="range" min="0.6" max="1.65" step="0.05" v-model.number="params.speed" />
        </div>
        <div class="param">
          <label>采样步数 <b class="mono">{{ params.steps }}</b></label>
          <select v-model.number="params.steps">
            <option :value="4">4（最快）</option>
            <option :value="8">8（推荐）</option>
            <option :value="16">16</option>
            <option :value="32">32（最慢）</option>
          </select>
        </div>
        <div class="param">
          <label>top_k <b class="mono">{{ params.topK }}</b></label>
          <input type="range" min="1" max="100" step="1" v-model.number="params.topK" />
        </div>
        <div class="param">
          <label>top_p <b class="mono">{{ params.topP.toFixed(2) }}</b></label>
          <input type="range" min="0" max="1" step="0.05" v-model.number="params.topP" />
        </div>
        <div class="param">
          <label>temperature <b class="mono">{{ params.temperature.toFixed(2) }}</b></label>
          <input type="range" min="0" max="1" step="0.05" v-model.number="params.temperature" />
        </div>
        <div class="param wide">
          <label>切分方式</label>
          <select v-model="params.split">
            <option v-for="o in splitOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
      </section>

      <div class="run-row">
        <template v-if="mode === 'single'">
          <button class="primary big" :disabled="!canRun" @click="synthesize">
            {{ running ? '合成中…' : '合成语音' }}
            <span class="kbd">Ctrl + Enter</span>
          </button>
        </template>
        <template v-else>
          <button class="ghost" :disabled="batchRunning" @click="buildQueue">按文本重建队列</button>
          <button class="primary" :disabled="!queue.length || !currentRef || batchRunning" @click="runBatch(false)">
            {{ batchRunning ? `合成中 ${batchDoneCount}/${batchTotal}` : '开始批量合成' }}
          </button>
          <button v-if="batchRunning" class="ghost" :disabled="batchCanceling" @click="cancelBatch">取消</button>
          <button v-else class="ghost" :disabled="!queue.length" @click="runBatch(true)">只重试未完成</button>
          <button class="ghost" :disabled="!batchDir" @click="exportBatch">导出 zip</button>
        </template>
      </div>

      <div v-if="error" class="alert">{{ error }}</div>

      <section v-if="mode === 'batch'" class="batch card">
        <div class="editor-head">
          <span>批量队列 <em class="muted">（{{ queue.length }} 句{{ batchDir ? ' · 已输出到 ' + batchDir.split('\\\\').pop() : '' }}）</em></span>
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
          <div v-if="!queue.length" class="empty">点上方「按文本重建队列」——会按句号/问号/感叹号自动拆句，长句再按逗号切到 40 字以内</div>
        </div>
      </section>

      <section v-if="mode === 'single' && result" class="result card">
        <div class="editor-head">
          <span>合成结果</span>
          <span class="muted mono">{{ result.elapsed }}s · {{ (result.bytes / 1024).toFixed(0) }} KB</span>
        </div>
        <audio :src="result.url" controls autoplay></audio>
        <div class="path-row">
          <span class="mono path">{{ result.path }}</span>
          <button class="mini" @click="copyPath">复制路径</button>
          <button class="mini" @click="window.api.openOutput()">打开目录</button>
        </div>
      </section>

      <section v-if="mode === 'single' && history.length" class="history card">
        <div class="editor-head"><span>本次生成</span></div>
        <div class="hist-list">
          <button v-for="h in history" :key="h.path" class="hist" @click="replay(h)">
            <span class="hist-time mono">{{ h.time }}</span>
            <span class="hist-text">{{ h.text }}</span>
            <span class="hist-voice">{{ h.voice }}</span>
          </button>
        </div>
      </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.studio { display: flex; height: 100%; }

.sidebar {
  width: 296px; flex: 0 0 296px;
  background: linear-gradient(180deg, #15181e, #12151a);
  border-right: 1px solid var(--line-soft);
  display: flex; flex-direction: column;
  padding: 18px 14px 12px;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 0 6px 16px; }
.logo {
  width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center;
  background: linear-gradient(160deg, #262b34, #171a20);
  border: 1px solid var(--accent-line);
}
.brand-name { font-weight: 700; font-size: 14.5px; letter-spacing: .3px; }
.brand-sub { color: var(--muted-2); font-size: 11px; margin-top: 1px; }

.section { margin-bottom: 14px; }
.section.grow { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.section-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11.5px; color: var(--muted-2); letter-spacing: .6px;
  padding: 0 6px 8px;
}
.mini {
  padding: 4px 9px; font-size: 11.5px; border-radius: 8px; background: transparent; color: var(--muted);
}
.mini:hover:not(:disabled) { color: var(--text); }

.voice-list, .ref-list { display: flex; flex-direction: column; gap: 4px; overflow: auto; }
.ref-list { flex: 1; min-height: 0; }
.voice, .ref {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 9px 10px; border-radius: 10px; border: 1px solid transparent; background: transparent;
}
.voice:hover, .ref:hover { background: #1c2128; }
.voice.active, .ref.active { background: var(--accent-soft); border-color: var(--accent-line); }
.voice-dot { width: 7px; height: 7px; border-radius: 50%; background: #3c4451; }
.voice.active .voice-dot { background: var(--accent); box-shadow: 0 0 10px rgba(255, 138, 61, .6); }
.voice-name { flex: 1; font-size: 13px; }
.voice-tag { font-size: 10.5px; color: var(--muted-2); }
.ref-row { display: flex; align-items: center; gap: 2px; }
.ref-row .ref { flex: 1; min-width: 0; }
.ref-del {
  flex: 0 0 22px; width: 22px; height: 22px; padding: 0; line-height: 1;
  border-radius: 6px; background: transparent; border: 1px solid transparent;
  color: var(--muted-2); opacity: 0; transition: opacity .12s ease, color .12s ease;
}
.ref-row:hover .ref-del { opacity: 1; }
.ref-del:hover { color: var(--err); border-color: rgba(255,107,107,.35); background: rgba(255,107,107,.08); }
.head-actions { display: flex; gap: 6px; }
.ref-name { flex: 1; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref-state { font-size: 10.5px; color: #c2703a; }
.ref-state.ok { color: var(--ok); }
.empty { color: var(--muted-2); font-size: 12px; padding: 10px 8px; line-height: 1.6; }

.sidebar-foot { display: flex; gap: 8px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
.sidebar-foot button { flex: 1; padding: 8px; font-size: 12px; }
.log {
  margin: 8px 0 0; max-height: 130px; overflow: auto; background: #0d1014;
  border: 1px solid #20262e; border-radius: 8px; padding: 8px 10px;
  font-size: 11px; color: #8b96a8; white-space: pre-wrap; user-select: text;
}

.main { flex: 1; min-width: 0; overflow: auto; padding: 18px 22px 26px; }
.topbar { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.status { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); }
.status .dot { width: 8px; height: 8px; border-radius: 50%; background: #4a5361; }
.status.ok .dot { background: var(--ok); box-shadow: 0 0 10px rgba(69, 200, 160, .5); }
.current { font-size: 12.5px; color: var(--muted); }
.current b { color: var(--text); margin-left: 6px; }
.spacer { flex: 1; }

.card {
  background: linear-gradient(180deg, var(--panel), #1c2027);
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: 16px 18px; margin-bottom: 14px;
}
.editor-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; color: var(--muted); margin-bottom: 10px;
}
.editor-head em { font-style: normal; font-size: 11.5px; }
.editor-actions { display: flex; align-items: center; gap: 6px; }
.count { font-size: 11.5px; color: var(--muted-2); margin-left: 6px; }
.text {
  width: 100%; height: 148px; resize: vertical; line-height: 1.8;
  background: #12151a; border: 1px solid var(--line); border-radius: 10px;
  padding: 12px 14px; font-size: 13.5px;
}
.ref-editor input { width: 100%; }

.params { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px 22px; }
.param { display: flex; flex-direction: column; gap: 7px; }
.param.wide { grid-column: span 3; }
.param label { font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; }
.param label b { color: var(--accent); font-weight: 600; }
.param select { width: 100%; }

.run-row { display: flex; justify-content: flex-end; margin: 4px 0 14px; }
.big { min-width: 280px; height: 46px; font-size: 14.5px; display: flex; align-items: center; justify-content: center; gap: 12px; }
.kbd { font-size: 10.5px; opacity: .6; font-weight: 400; }

.alert {
  border: 1px solid rgba(255, 107, 107, .35); background: rgba(255, 107, 107, .08);
  color: #ffb4b4; border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; font-size: 12.5px;
  user-select: text;
}

.result audio { width: 100%; height: 40px; margin-bottom: 10px; }
.path-row { display: flex; align-items: center; gap: 8px; }
.path { flex: 1; font-size: 11.5px; color: var(--muted-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: text; }

.hist-list { display: flex; flex-direction: column; gap: 4px; }
.hist {
  display: flex; align-items: center; gap: 10px; text-align: left;
  background: transparent; border: 1px solid transparent; padding: 8px 10px; border-radius: 9px;
}
.hist:hover { background: #1d222a; }
.hist-time { font-size: 11px; color: var(--muted-2); }
.hist-text { flex: 1; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-voice { font-size: 11px; color: var(--muted-2); }
.wave .wave-cv {
  width: 100%; height: 86px; display: block; cursor: crosshair;
  background: #12151a; border: 1px solid var(--line); border-radius: 10px;
}
.wave-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.wave-actions .mini { padding: 6px 12px; background: #232932; }
.preview-audio { width: 100%; height: 34px; margin-top: 10px; }
.editor-head em.ok { color: var(--ok); }
.editor-head em.warn { color: #e0a35c; }

.seg { display: flex; background: #171b21; border: 1px solid var(--line); border-radius: 10px; padding: 3px; gap: 2px; }
.seg button { border: 1px solid transparent; background: transparent; padding: 4px 14px; font-size: 12px; color: var(--muted); border-radius: 8px; }
.seg button.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-line); }

.run-row { gap: 10px; }
.run-row .ghost { min-width: 132px; }

.batch .q-list { display: flex; flex-direction: column; gap: 2px; max-height: 430px; overflow: auto; }
.q-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 9px; border: 1px solid transparent; }
.q-row:hover { background: #1d222a; }
.q-row.running { background: rgba(255, 138, 61, .07); border-color: rgba(255, 138, 61, .25); }
.q-index { font-size: 11px; color: var(--muted-2); width: 22px; }
.q-text { flex: 1; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q-dur { font-size: 11px; color: var(--muted-2); }
.q-state { font-size: 11px; color: var(--muted-2); width: 52px; text-align: right; }
.q-state.done { color: var(--ok); }
.q-state.failed { color: var(--err); }
.q-state.running { color: var(--accent); }
.q-row .mini { opacity: 0; }
.q-row:hover .mini { opacity: 1; }
</style>
