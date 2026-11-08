<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const emit = defineEmits(['refresh']);

const dir = ref('');
const fileCount = ref(0);
const expName = ref('myvoice');
const s2Epochs = ref(8);
const s1Epochs = ref(30);
const batch = ref(2);

const phase = ref('idle'); // idle|preparing|prepared|training|done|failed
const steps = ref([
  { key: 'slice', label: '切片', status: 'idle', detail: '' },
  { key: 'asr', label: '语音识别打标', status: 'idle', detail: '' },
  { key: 'text', label: '文本与 BERT 特征', status: 'idle', detail: '' },
  { key: 'hubert', label: 'HuBERT 特征', status: 'idle', detail: '' },
  { key: 'sv', label: '声纹特征', status: 'idle', detail: '' },
  { key: 'semantic', label: '语义 token', status: 'idle', detail: '' },
  { key: 'sovits', label: 'SoVITS 微调', status: 'idle', detail: '' },
  { key: 'gpt', label: 'GPT 微调', status: 'idle', detail: '' }
]);
const log = ref([]);
const showLog = ref(false);
const error = ref('');
const epochInfo = ref({ stage: '', epoch: 0, total: 0 });
const summary = ref(null);

const busy = computed(() => phase.value === 'preparing' || phase.value === 'training');
const canPrepare = computed(() => !!dir.value && !busy.value && !!expName.value.trim());
const canTrain = computed(() => phase.value === 'prepared' || phase.value === 'done');

function setStep(p) {
  const s = steps.value.find((x) => x.key === p.step);
  if (!s) return;
  s.status = p.status;
  if (p.detail) s.detail = p.detail;
}

onMounted(async () => {
  window.api.on('train:step', setStep);
  window.api.on('train:log', (l) => {
    log.value.push(l);
    if (log.value.length > 400) log.value.splice(0, 100);
  });
  window.api.on('train:epoch', (e) => { epochInfo.value = e; });

  // 自动化测试/调试：允许通过环境变量预置素材目录
  const st = await window.api.state();
  if (st && st.testTrainDir) {
    const r = await window.api.trainInspect({ dir: st.testTrainDir });
    if (r.ok) {
      dir.value = r.dir;
      fileCount.value = r.count;
      expName.value = 'selftest_voice';
    }
  }
});

onUnmounted(() => {});

async function pickDir() {
  const res = await window.api.pickTrainDir();
  if (!res.ok) { if (res.error) error.value = res.error; return; }
  dir.value = res.dir;
  fileCount.value = res.count;
  const guess = res.dir.split(/[\\/]/).filter(Boolean).pop();
  if (guess) expName.value = guess.replace(/[^\w\u4e00-\u9fa5]/g, '_').slice(0, 24);
  phase.value = 'idle';
  error.value = '';
}

async function prepare() {
  if (!canPrepare.value) return;
  error.value = '';
  summary.value = null;
  phase.value = 'preparing';
  steps.value.forEach((s) => { s.status = 'idle'; s.detail = ''; });
  const res = await window.api.trainPrepare({
    inputDir: dir.value,
    expName: expName.value.trim(),
    s2Epochs: Number(s2Epochs.value),
    s1Epochs: Number(s1Epochs.value),
    batch: Number(batch.value)
  });
  if (!res.ok) {
    phase.value = 'failed';
    error.value = res.error || '处理失败';
    return;
  }
  phase.value = 'prepared';
  summary.value = res;
  emit('refresh');
}

async function startTrain() {
  if (!canTrain.value) return;
  error.value = '';
  phase.value = 'training';
  const res = await window.api.trainStart({
    expName: expName.value.trim(),
    s2Epochs: Number(s2Epochs.value),
    s1Epochs: Number(s1Epochs.value),
    batch: Number(batch.value)
  });
  if (!res.ok) {
    phase.value = 'failed';
    error.value = res.error || '训练失败';
    return;
  }
  phase.value = 'done';
  emit('refresh');
}

async function cancel() {
  await window.api.trainCancel();
  phase.value = 'failed';
  error.value = '已取消';
}

function statusText(s) {
  return ({ idle: '待执行', running: '进行中', done: '完成', failed: '失败' })[s] || s;
}
</script>

<template>
  <div class="train">
    <section class="card">
      <div class="editor-head"><span>训练素材</span><span class="muted mono">{{ fileCount ? fileCount + ' 个文件' : '' }}</span></div>
      <div class="pick-row">
        <button class="primary" @click="pickDir">选择素材文件夹</button>
        <span class="mono dir">{{ dir || '未选择（建议 5~30 分钟同一人的干净录音）' }}</span>
      </div>
      <p class="hint">
        支持 wav / mp3 / flac / m4a。程序会自动切片（3~10 秒）、识别文字打标、提取特征；
        素材越多样（不同句子、不同语气），训出来的音色越不容易「哑」。
      </p>
    </section>

    <section class="card">
      <div class="editor-head"><span>训练参数</span></div>
      <div class="grid">
        <label>实验名<input v-model="expName" type="text" class="mono" :disabled="busy" /></label>
        <label>SoVITS 轮数<input type="number" min="4" max="50" v-model.number="s2Epochs" :disabled="busy" /></label>
        <label>GPT 轮数<input type="number" min="5" max="100" v-model="s1Epochs" :disabled="busy" /></label>
        <label>batch（6GB 显存填 1~2）<input type="number" min="1" max="8" v-model.number="batch" :disabled="busy" /></label>
      </div>
    </section>

    <section class="card">
      <div class="editor-head">
        <span>流程</span>
        <span class="muted mono" v-if="epochInfo.stage">
          {{ epochInfo.stage === 'sovits' ? 'SoVITS' : 'GPT' }} {{ epochInfo.epoch }} / {{ epochInfo.total }}
        </span>
      </div>
      <div class="steps">
        <div v-for="(s, i) in steps" :key="s.key" class="step" :class="s.status">
          <span class="idx mono">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="label">{{ s.label }}</span>
          <span class="detail muted">{{ s.detail }}</span>
          <span class="state">{{ statusText(s.status) }}</span>
        </div>
      </div>

      <div class="actions">
        <button class="primary" :disabled="!canPrepare" @click="prepare">
          {{ phase === 'preparing' ? '处理中…' : '开始处理（切片 + 打标 + 特征）' }}
        </button>
        <button class="primary" :disabled="!canTrain || busy" @click="startTrain">
          {{ phase === 'training' ? '训练中…' : '开始训练' }}
        </button>
        <button class="ghost" :disabled="!busy" @click="cancel">取消</button>
        <button class="ghost" @click="showLog = !showLog">{{ showLog ? '收起日志' : '日志' }}</button>
      </div>

      <div v-if="error" class="alert">{{ error }}</div>
      <div v-if="phase === 'done'" class="done train-done">
        训练完成：{{ summary ? summary.slices + ' 段 / ' + summary.seconds + ' 秒素材' : expName }}。
        去「单句」页左上角点一下音色，就能选到 <b>{{ expName }}</b> 试听。
      </div>
      <pre v-if="showLog" class="log mono">{{ log.join('\n') }}</pre>
    </section>
  </div>
</template>

<style scoped>
.train { display: flex; flex-direction: column; gap: 14px; }
.card { background: linear-gradient(180deg, var(--panel), #1c2027); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
.editor-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
.pick-row { display: flex; align-items: center; gap: 12px; }
.dir { font-size: 11.5px; color: var(--muted-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hint { margin: 12px 0 0; font-size: 12px; color: var(--muted); line-height: 1.7; }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.grid label { display: flex; flex-direction: column; gap: 6px; font-size: 11.5px; color: var(--muted); }
.grid input { width: 100%; }
.steps { display: flex; flex-direction: column; gap: 2px; }
.step { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 9px; border: 1px solid transparent; }
.step.running { background: rgba(255, 138, 61, .07); border-color: rgba(255, 138, 61, .25); }
.step .idx { width: 24px; font-size: 11px; color: var(--muted-2); }
.step .label { width: 150px; font-size: 12.5px; }
.step .detail { flex: 1; font-size: 11.5px; }
.step .state { font-size: 11px; color: var(--muted-2); }
.step.done .state { color: var(--ok); }
.step.running .state { color: var(--accent); }
.step.failed .state { color: var(--err); }
.actions { display: flex; gap: 10px; margin-top: 14px; }
.actions button { min-width: 150px; }
.alert { border: 1px solid rgba(255, 107, 107, .35); background: rgba(255, 107, 107, .08); color: #ffb4b4; border-radius: 10px; padding: 10px 12px; margin-top: 12px; font-size: 12.5px; }
.done { border: 1px solid rgba(69, 200, 160, .35); background: rgba(69, 200, 160, .08); color: #9be4cd; border-radius: 10px; padding: 10px 12px; margin-top: 12px; font-size: 12.5px; }
.log { margin: 12px 0 0; max-height: 220px; overflow: auto; background: #0d1014; border: 1px solid #20262e; border-radius: 10px; padding: 10px 12px; font-size: 11px; color: #8b96a8; white-space: pre-wrap; user-select: text; }
</style>
