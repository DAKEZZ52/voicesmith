<script setup>
import { onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({ ready: { type: Boolean, default: false } });

const info = ref({ ok: false, models: [], indices: [], root: '' });
const inputFile = ref('');
const fileName = ref('');
const model = ref('');
const index = ref('');
const indexRate = ref(0.75);
const pitch = ref(0);
const separate = ref(true);
const running = ref(false);
const stage = ref('');
const error = ref('');
const result = ref(null);
const audioEl = ref(null);
const logs = ref([]);
let offs = [];

const stageLabel = {
  separating: '分离人声…',
  'loading-model': '加载模型…',
  converting: '转换音色…',
  mixing: '混音…',
  done: '完成'
};

onMounted(async () => {
  info.value = await window.api.rvcInfo();
  if (info.value.models && info.value.models.length) model.value = info.value.models[0].path;
  if (info.value.indices && info.value.indices.length) index.value = info.value.indices[0].path;
  offs.push(window.api.on('rvc:progress', (p) => { stage.value = p.stage; }));
  offs.push(window.api.on('log', (l) => {
    logs.value.push(l);
    if (logs.value.length > 100) logs.value.splice(0, 40);
  }));
});

onUnmounted(() => offs.forEach((f) => f && f()));

async function refresh() {
  const r = await window.api.rvcInfo();
  if (r.ok) {
    info.value = r;
    if (!model.value && r.models.length) model.value = r.models[0].path;
  }
}

async function pickAudio() {
  try {
    const r = await window.api.pickAudio();
    if (r && r.ok) {
      inputFile.value = r.path;
      fileName.value = r.path.split(/[\\/]/).pop();
      error.value = '';
    } else if (r && r.error) {
      error.value = r.error;
    }
  } catch (e) {
    error.value = '打开文件选择失败：' + String(e.message || e);
  }
}

async function convert() {
  if (!inputFile.value) { error.value = '先选一首歌'; return; }
  if (!model.value) { error.value = '没有可用模型'; return; }
  error.value = '';
  result.value = null;
  running.value = true;
  stage.value = 'separating';
  try {
    const res = await window.api.rvcConvert({
      input: inputFile.value,
      model: model.value,
      index: index.value,
      indexRate: Number(indexRate.value),
      pitch: Number(pitch.value) || 0,
      separate: separate.value
    });
    if (!res.ok) { error.value = res.error; return; }
    result.value = res;
    await play();
  } catch (e) {
    error.value = String(e.message || e);
  } finally {
    running.value = false;
  }
}

async function play() {
  if (!result.value) return;
  const r = await window.api.readAudio({ path: result.value.path });
  if (!r.ok) { error.value = r.error; return; }
  await new Promise((res) => setTimeout(res, 30));
  if (audioEl.value) {
    audioEl.value.src = 'data:audio/wav;base64,' + r.base64;
    audioEl.value.play().catch(() => {});
  }
}

async function stop() { await window.api.rvcCancel(); }
function openOutput() { window.api.openOutput(); }
function openRvc() { if (info.value.root) window.api.openDir({ path: info.value.root }); }
</script>

<template>
  <div class="cover">
    <section class="card">
      <div class="editor-head">
        <span>翻唱（RVC 音色转换）</span>
        <span class="head-actions">
          <span class="muted mono ellipsis" :title="info.root">{{ info.root }}</span>
          <button class="mini" @click="openRvc">打开 RVC 目录</button>
          <button class="mini" @click="refresh">刷新模型</button>
        </span>
      </div>

      <div v-if="!info.ok" class="alert">
        没有找到 RVC 安装。{{ info.error }}<br />
        <span class="muted">需要目录里含 <code>.venv\Scripts\python.exe</code>、<code>assets\weights</code> 和 <code>assets\indices</code>。</span>
      </div>

      <template v-else>
        <div class="row">
          <span class="lbl">歌曲</span>
          <button class="mini" @click="pickAudio">选择音频</button>
          <span class="muted mono ellipsis">{{ fileName || '选一首歌（mp3/wav/m4a 都行）' }}</span>
        </div>
        <div class="row">
          <span class="lbl">音色模型</span>
          <select v-model="model" class="sel">
            <option v-for="m in info.models" :key="m.path" :value="m.path">{{ m.name }} · {{ m.sizeMB }}MB</option>
          </select>
        </div>
        <div class="row">
          <span class="lbl">检索索引</span>
          <select v-model="index" class="sel">
            <option value="">不使用</option>
            <option v-for="x in info.indices" :key="x.path" :value="x.path">{{ x.name }}</option>
          </select>
          <span class="muted">检索率 <input v-model="indexRate" class="num" type="number" min="0" max="1" step="0.05" /></span>
        </div>
        <div class="row">
          <span class="lbl">参数</span>
          <span class="opts">
            <label><input v-model="separate" type="checkbox" /> 自动分离人声/伴奏</label>
            <span>变调 <input v-model="pitch" class="num" type="number" min="-12" max="12" step="1" /> 半音</span>
          </span>
        </div>

        <div class="bar" v-if="running"><i :class="{ active: running }"></i></div>
        <div class="actions">
          <button class="primary" :disabled="running || !inputFile" @click="convert">
            {{ running ? (stageLabel[stage] || '处理中…') : '开始转换' }}
          </button>
          <button class="mini" :disabled="!running" @click="stop">停止</button>
          <span class="muted" v-if="running">首次运行要加载模型，约 10~60 秒</span>
        </div>

        <div v-if="result" class="ok">
          已生成：<span class="mono">{{ result.path }}</span>
          <button class="mini" @click="play">再播一次</button>
          <button class="mini" @click="openOutput">打开目录</button>
        </div>
        <div v-if="error" class="alert">{{ error }}</div>
        <audio ref="audioEl" style="display:none"></audio>
      </template>
    </section>

    <section class="card">
      <div class="editor-head"><span>说明</span></div>
      <ul class="tips">
        <li>先用 UVR5 把歌分离成人声和伴奏（CPU 处理，约 1~3 分钟/首）</li>
        <li>再用 RVC 把人声换成你训练的音色（GPU，约 15 秒/首）</li>
        <li>最后按 -16 LUFS 混音导出，结果在输出目录</li>
        <li>转换期间会暂停语音合成服务以释放显存，结束后自动恢复</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.cover { display: flex; flex-direction: column; gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 12px; }
.head-actions { display: flex; align-items: center; gap: 8px; }
.editor-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 24px; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--line-soft); font-size: 11px; letter-spacing: .06em; color: var(--muted); }
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.lbl { flex: 0 0 68px; font-size: 12px; color: var(--muted); }
.sel { flex: 1; background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; color: var(--text); padding: 7px 10px; font-size: 12.5px; }
.opts { display: flex; align-items: center; gap: 16px; font-size: 12px; color: var(--muted); }
.num { width: 62px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; color: var(--text); padding: 4px 6px; font-size: 12px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px; }
.bar { height: 3px; border-radius: 2px; background: var(--line-soft); overflow: hidden; margin: 6px 0 12px; }
.bar i { display: block; height: 100%; width: 0; background: var(--accent); }
.bar i.active { width: 100%; animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
.actions { display: flex; align-items: center; gap: 10px; }
.primary { height: 34px; padding: 0 20px; border-radius: 8px; background: var(--accent); border-color: var(--accent); color: #1a1206; font-weight: 650; font-size: 13px; }
.primary:disabled { opacity: .5; }
.mini { height: 24px; padding: 0 8px; font-size: 11.5px; border-radius: 8px; background: transparent; border: 1px solid transparent; color: var(--muted); }
.ok { margin-top: 10px; font-size: 12px; color: var(--ok); word-break: break-all; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.alert { margin-top: 10px; border: 1px solid rgba(228, 103, 95, .32); background: rgba(228, 103, 95, .07); color: #e6a3a0; border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.7; }
.tips { margin: 0; padding-left: 18px; font-size: 12px; color: var(--muted); line-height: 1.9; }
code { background: var(--panel-2); padding: 0 4px; border-radius: 4px; }
</style>
