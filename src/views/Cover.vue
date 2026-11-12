<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

const props = defineProps({
  ready: { type: Boolean, default: false },
  pitchHint: { type: Number, default: null }
});

const info = ref({ ok: false, models: [], indices: [], root: '' });
const inputFile = ref('');
const fileName = ref('');
const model = ref('');
const index = ref('');
const indexRate = ref(0.75);
const pitch = ref(0);
const hintText = ref('');

watch(() => props.pitchHint, (v) => {
  if (v === null || v === undefined) return;
  pitch.value = Number(v) || 0;
  const label = pitch.value > 0 ? '升 ' + pitch.value : (pitch.value < 0 ? '降 ' + (-pitch.value) : '原调');
  hintText.value = '已按测声结果设为 ' + label + '（' + pitch.value + ' 个半音）';
}, { immediate: true });
const isEpochFile = (name) => /_e\d+_s\d+\.pth$/i.test(name || '');
const baseName = (name) => String(name || '').replace(/_e\d+_s\d+\.pth$/i, '').replace(/\.pth$/i, '');
// 每个音色只把最新的一版算「最新模型」，其余都归到历史检查点
const modelSplit = computed(() => {
  const list = (info.value.models || []).slice().sort((a, b) => b.mtime - a.mtime);
  const seen = new Set();
  const latest = [];
  const history = [];
  for (const m of list) {
    const key = baseName(m.name);
    if (seen.has(key)) history.push(m);
    else { seen.add(key); latest.push(m); }
  }
  return { latest, history };
});
const finalModels = computed(() => modelSplit.value.latest);
const historyModels = computed(() => modelSplit.value.history);
const modelHint = computed(() => {
  const cur = (info.value.models || []).find((m) => m.path === model.value);
  if (!cur) return '';
  const m = /_e(\d+)_s(\d+)/i.exec(cur.name || '');
  return m ? '第 ' + m[1] + ' 轮的训练快照' : '训练完成导出的正式模型';
});

async function prune() {
  const n = historyModels.value.length;
  if (!n) return;
  if (!window.confirm('会删除 ' + (n - 1) + ' 个旧检查点，每个音色只留最新一个（正式模型不动）。继续？')) return;
  const r = await window.api.rvcPrune();
  if (!r.ok) { error.value = r.error; return; }
  await refresh();
}

const separate = ref(true);
const running = ref(false);
const stage = ref('');
const error = ref('');
const result = ref(null);
const audioEl = ref(null);
const logs = ref([]);
let offs = [];

const score = computed(() => {
  const s = result.value && result.value.score;
  if (!s || !s.ok) return null;
  const corr = Number(s.corr) || 0;
  const octave = Number(s.octave) || 0;
  const voiced = Number(s.voiced) || 0;
  let grade = 'good';
  let label = '很搭';
  if (corr < 0.7) { grade = 'bad'; label = '不搭'; }
  else if (corr < 0.85) { grade = 'mid'; label = '一般'; }
  const tips = [];
  if (voiced && voiced < 65) tips.push('原唱偏轻声/气声，模型跟不稳，换一首更明亮、发声更实的歌会好很多');
  if (octave >= 4) tips.push('音高跳变较多，把「变调」调 ±2 再试一次');
  if (corr >= 0.85 && !tips.length) tips.push('这首很适合这个音色，可以直接用');
  if (corr < 0.7 && voiced >= 65) tips.push('音色差异偏大，建议换歌，或先用 ±2 变调试 30 秒');
  return {
    corr, cents: s.cents, octave, voiced,
    grade, label,
    tip: tips.join('；')
  };
});

const stageLabel = {
  scoring: '对比音高…',
  separating: '分离人声…',
  'loading-model': '加载模型…',
  converting: '转换音色…',
  mixing: '混音…',
  done: '完成'
};

onMounted(async () => {
  // 自动化测试用的入口：预先指定歌曲路径
  const hashParams = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  const preset = hashParams.get('clip') || '';
  if (preset) {
    inputFile.value = preset;
    fileName.value = preset.split(/[\\\\/]/).pop();
  }
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
  <div class="cover split">
    <div class="split-main">
      <section class="card">
        <div class="editor-head">
          <span>源音频</span>
          <span class="head-actions">
            <button class="mini" @click="openRvc">打开 RVC 目录</button>
            <button class="mini" @click="refresh">刷新模型</button>
          </span>
        </div>

        <div v-if="!info.ok" class="alert">
          没有找到 RVC 安装。{{ info.error }}<br />
          <span class="muted">需要目录里含 <code>.venv\Scripts\python.exe</code>、<code>assets\weights</code> 和 <code>assets\indices</code>。</span>
        </div>

        <template v-else>
          <div class="pick">
            <button class="primary" @click="pickAudio">选择歌曲</button>
            <span class="muted mono ellipsis" :title="fileName">{{ fileName || 'mp3 / wav / m4a 都可以' }}</span>
          </div>
          <p class="hint">选好后在右侧点「开始转换」。带伴奏的歌不用自己分离，勾上自动处理就行。</p>
        </template>
      </section>

      <section v-if="result" class="card">
        <div class="editor-head">
          <span>转换结果</span>
          <span class="head-actions">
            <button class="mini" @click="play">再播一次</button>
            <button class="mini" @click="openOutput">打开目录</button>
          </span>
        </div>
        <audio ref="audioEl" controls style="width:100%;height:34px"></audio>
        <div class="path-row">
          <span class="mono path">{{ result.path }}</span>
        </div>

        <div v-if="score" class="score" :class="score.grade">
          <div class="score-head">
            <b>这首歌和音色的匹配度：{{ score.label }}</b>
            <span class="score-num mono">{{ (score.corr * 100).toFixed(0) }}%</span>
          </div>
          <div class="score-grid">
            <span>音高跟随 <b class="mono">{{ (score.corr * 100).toFixed(0) }}%</b></span>
            <span>音准偏差 <b class="mono">{{ score.cents }} 音分</b></span>
            <span>八度跳变 <b class="mono">{{ score.octave }}%</b></span>
            <span>原唱发声 <b class="mono">{{ score.voiced }}%</b></span>
          </div>
          <p class="score-tip">{{ score.tip }}</p>
        </div>
      </section>

      <div v-if="error" class="alert">{{ error }}</div>

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

    <aside class="split-side">
      <section class="inspector">
        <div class="inspector-head">转换设置</div>

        <div class="field">
          <div class="field-label"><span>音色模型</span></div>
          <select v-model="model">
            <optgroup label="最新模型">
              <option v-for="m in finalModels" :key="m.path" :value="m.path">{{ m.name }} · {{ m.sizeMB }}MB</option>
            </optgroup>
            <optgroup label="训练检查点（同一个人，轮数不同）" v-if="historyModels.length">
              <option v-for="m in historyModels" :key="m.path" :value="m.path">{{ m.name }}</option>
            </optgroup>
          </select>
          <button class="mini prune" v-if="historyModels.length" @click="prune">清理旧检查点</button>
          <span class="muted" style="font-size:11px">{{ modelHint }}</span>
        </div>

        <div class="field">
          <div class="field-label"><span>检索索引</span></div>
          <select v-model="index">
            <option value="">不使用</option>
            <option v-for="x in info.indices" :key="x.path" :value="x.path">{{ x.name }}</option>
          </select>
        </div>

        <div class="field">
          <div class="field-label"><span>检索率</span><b class="mono">{{ Number(indexRate).toFixed(2) }}</b></div>
          <input v-model="indexRate" type="range" min="0" max="1" step="0.05" />
        </div>

        <div class="inspector-sep"></div>

        <div class="field">
          <label class="check-line"><input v-model="separate" type="checkbox" /> 自动分离人声 / 伴奏</label>
        </div>

        <div class="field">
          <div class="field-label"><span>变调</span><b class="mono">{{ pitch > 0 ? '+' + pitch : pitch }} 半音</b></div>
          <input v-model="pitch" type="range" min="-12" max="12" step="1" />
        </div>

        <div class="inspector-actions">
          <button class="primary" :disabled="running || !inputFile" @click="convert">
            {{ running ? (stageLabel[stage] || '处理中…') : '开始转换' }}
          </button>
          <button class="mini" :disabled="!running" @click="stop">停止</button>
          <span class="muted hint" v-if="running">首次运行要加载模型，约 10~60 秒</span>
          <span class="hint-text" v-else-if="hintText">{{ hintText }}</span>
        </div>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.prune { align-self: flex-start; margin-top: 2px; }
.pick { display: flex; align-items: center; gap: 12px; margin: 4px 0 6px; }
.pick .ellipsis { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.path-row { margin-top: 10px; }
.path-row .path { font-size: 11px; color: var(--muted-2); word-break: break-all; }
.check-line { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-2); }
.hint-text { font-size: 11.5px; color: var(--accent); text-align: center; }
.cover { gap: 16px; }
.hint-text { font-size: 11px; color: var(--accent); }

.score {
  margin-top: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--panel-2);
}
.score.good { border-color: rgba(79, 184, 154, .45); }
.score.mid { border-color: rgba(217, 160, 91, .45); }
.score.bad { border-color: rgba(228, 103, 95, .45); }
.score-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.score-head b { font-size: 12.5px; font-weight: 600; }
.score.good .score-head b { color: var(--ok); }
.score.mid .score-head b { color: var(--warn); }
.score.bad .score-head b { color: var(--err); }
.score-num { font-size: 15px; font-weight: 650; }
.score-grid { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 10px 0 8px; font-size: 11.5px; color: var(--muted); }
.score-grid b { color: var(--text); font-weight: 550; }
.score-tip { margin: 0; font-size: 11.5px; line-height: 1.7; color: var(--muted); }
.score-tip:empty { display: none; }
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
