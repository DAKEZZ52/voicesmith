<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({ ready: { type: Boolean, default: false } });

const mode = ref('notation');
const lyrics = ref('一闪一闪亮晶晶满天都是小星星');
const notation = ref('1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 -');
const beat = ref(0.55);
const transpose = ref(0);
const refs = ref([]);
const refPath = ref('');
const followAudio = ref('');
const followName = ref('');
const name = ref('我的歌');
const running = ref(false);
const done = ref(0);
const total = ref(0);
const currentChar = ref('');
const result = ref(null);
const error = ref('');
const audioEl = ref(null);
const logs = ref([]);
const history = ref([]);
let offs = [];

const noteCount = computed(() => notation.value.replace(/\|/g, ' ').split(/\s+/).filter((x) => x && /^[1-7]/.test(x)).length);

const canRun = computed(() => {
  if (!props.ready || running.value) return false;
  if (!refPath.value) return false;
  if (mode.value === 'follow') return !!followAudio.value;
  return !!notation.value.trim() && !!lyrics.value.trim();
});

onMounted(async () => {
  refs.value = (await window.api.refs()) || [];
  const first = refs.value.find((r) => r.text) || refs.value[0];
  if (first) refPath.value = first.path;
  offs.push(window.api.on('sing:progress', (p) => {
    done.value = p.done;
    total.value = p.total;
    currentChar.value = p.text || '';
  }));
  await refreshHistory();
  offs.push(window.api.on('log', (l) => {
    logs.value.push(l);
    if (logs.value.length > 120) logs.value.splice(0, 40);
  }));
});

onUnmounted(() => offs.forEach((f) => f && f()));

async function pickFollow() {
  const r = await window.api.pickAudio();
  if (r.ok) {
    followAudio.value = r.path;
    followName.value = r.path.split(/[\\/]/).pop();
  }
}

async function generate() {
  error.value = '';
  result.value = null;
  running.value = true;
  done.value = 0;
  total.value = 0;
  const ref = refs.value.find((r) => r.path === refPath.value) || {};
  try {
    const res = await window.api.singStart({
      mode: mode.value,
      lyrics: lyrics.value,
      notes: notation.value,
      audio: followAudio.value,
      ref: refPath.value,
      refText: ref.text || '',
      beat: Number(beat.value) || 0.55,
      transpose: Number(transpose.value) || 0,
      name: name.value || '唱歌'
    });
    if (!res.ok) { error.value = res.error; return; }
    result.value = res;
    await playResult();
  } catch (e) {
    error.value = String(e.message || e);
  } finally {
    running.value = false;
  }
}

async function playResult() {
  if (!result.value || !result.value.path) return;
  const r = await window.api.readAudio({ path: result.value.path });
  if (!r.ok) { error.value = r.error; return; }
  await new Promise((res) => setTimeout(res, 30));
  if (audioEl.value) {
    audioEl.value.src = 'data:audio/wav;base64,' + r.base64;
    audioEl.value.play().catch(() => {});
  }
}

async function stop() {
  await window.api.singCancel();
}
function openOutput() { window.api.openOutput(); }

async function refreshHistory() {
  const all = await window.api.listOutputs();
  history.value = (all || []).filter((x) => x.name.startsWith('唱_')).slice(0, 8);
}

async function playItem(item) {
  const r = await window.api.readAudio({ path: item.path });
  if (!r.ok) { error.value = r.error; return; }
  await new Promise((res) => setTimeout(res, 30));
  if (audioEl.value) {
    audioEl.value.src = 'data:audio/wav;base64,' + r.base64;
    audioEl.value.play().catch(() => {});
  }
}
</script>

<template>
  <div class="sing">
    <section class="card">
      <div class="editor-head">
        <span>唱歌</span>
        <div class="seg mini-seg">
          <button :class="{ on: mode === 'notation' }" @click="mode = 'notation'">简谱</button>
          <button :class="{ on: mode === 'follow' }" @click="mode = 'follow'">跟唱</button>
        </div>
      </div>

      <div class="row">
        <label class="lbl">参考音频</label>
        <select v-model="refPath" class="sel">
          <option v-for="r in refs" :key="r.path" :value="r.path">
            {{ r.name }}{{ r.text ? '' : '（无参考文本）' }}
          </option>
        </select>
      </div>

      <div class="row">
        <label class="lbl">歌词</label>
        <input v-model="lyrics" class="inp" placeholder="每个字对应一个音符" />
      </div>

      <template v-if="mode === 'notation'">
        <div class="row">
          <label class="lbl">简谱</label>
          <input v-model="notation" class="inp mono" placeholder="1 1 5 5 | 6 6 5 -" />
        </div>
        <div class="row">
          <label class="lbl">参数</label>
          <span class="opts">
            <span>每拍 <input v-model="beat" class="num" type="number" min="0.2" max="2" step="0.05" /> 秒</span>
            <span>移调 <input v-model="transpose" class="num" type="number" min="-12" max="12" step="1" /> 半音</span>
            <span class="muted">数字 1~7 为音级，0 休止，<code>.</code> 高八度，<code>,</code> 低八度，<code>-</code> 延长一拍，<code>/</code> 半拍</span>
          </span>
        </div>
      </template>

      <template v-else>
        <div class="row">
          <label class="lbl">跟唱人声</label>
          <span class="opts">
            <button class="mini" @click="pickFollow">选择音频</button>
            <span class="muted mono">{{ followName || '选一段人声，程序会提取它的音高曲线' }}</span>
          </span>
        </div>
        <div class="hint muted">跟唱模式按检测到的音符逐字重唱，节奏自动贴合原片段长度。</div>
      </template>

      <div class="row">
        <label class="lbl">文件名</label>
        <input v-model="name" class="inp short" placeholder="我的歌" />
      </div>

      <div class="row" v-if="mode === 'notation'">
        <label class="lbl"></label>
        <span class="muted note-hint">解析出 {{ noteCount }} 个音符，将匹配歌词前 {{ noteCount }} 个音节的字</span>
      </div>

      <div class="bar"><i :style="{ width: (total ? Math.round(done / total * 100) : 0) + '%' }"></i></div>
      <div class="actions">
        <button class="primary" :disabled="!canRun" @click="generate">{{ running ? '生成中…' : '开始唱歌' }}</button>
        <button class="mini" :disabled="!running" @click="stop">停止</button>
        <span class="muted mono" v-if="running">{{ done }}/{{ total }} {{ currentChar }}</span>
      </div>
      <div v-if="result" class="ok">
        已生成：<span class="mono">{{ result.path }}</span>
        <span class="muted"> · {{ result.duration }}s · {{ result.notes }} 个音符</span>
        <button class="mini" @click="playResult">再播一次</button>
      </div>
      <audio ref="audioEl" style="display:none"></audio>
      <div v-if="error" class="alert">{{ error }}</div>
    </section>

    <section class="card">
      <div class="editor-head">
        <span>最近生成</span>
        <div class="head-actions">
          <button class="mini" @click="openOutput">打开目录</button>
          <button class="mini" @click="refreshHistory">刷新</button>
        </div>
      </div>
      <div class="list">
        <div v-for="h in history" :key="h.path" class="item">
          <span class="name mono">{{ h.name }}</span>
          <span class="muted">{{ h.dur }}s</span>
          <button class="mini" @click="playItem(h)">播放</button>
        </div>
        <div v-if="!history.length" class="empty">还没有生成过</div>
      </div>
    </section>

    <section class="card">
      <div class="editor-head"><span>说明</span></div>
      <ul class="tips">
        <li>逐字合成后按音高变调、按音符时值变速（保留共振峰，不会变花栗鼠）</li>
        <li>参考音频要 3~10 秒、干净人声；越长越慢</li>
        <li>效果是「念唱」级：音准对、咬字清楚，但没有颤音和气息，适合儿歌/简单旋律</li>
        <li>想更专业需要专门训练的歌声模型（DiffSinger/RVC），那是另一条路线</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.sing { display: flex; flex-direction: column; gap: 14px; }
.card { background: linear-gradient(180deg, var(--panel), #1c2027); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
.editor-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
.mini-seg button { padding: 4px 12px; font-size: 11.5px; }
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.lbl { flex: 0 0 68px; font-size: 12px; color: var(--muted); }
.inp { flex: 1; background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; color: var(--text); padding: 7px 10px; font-size: 12.5px; }
.inp.short { flex: 0 0 220px; }
.sel { flex: 1; background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; color: var(--text); padding: 7px 10px; font-size: 12.5px; }
.opts { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.num { width: 60px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 7px; color: var(--text); padding: 4px 6px; font-size: 12px; }
code { background: #222933; padding: 0 4px; border-radius: 4px; }
.hint { font-size: 11.5px; margin: -4px 0 10px 80px; }
.bar { height: 6px; border-radius: 3px; background: #20252d; overflow: hidden; margin: 6px 0 12px; }
.bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), #ffb066); transition: width .25s ease; }
.actions { display: flex; align-items: center; gap: 10px; }
.primary { padding: 9px 22px; border-radius: 9px; background: linear-gradient(180deg, #ff9a4d, #f0761f); color: #1a1206; font-weight: 600; font-size: 13px; }
.primary:disabled { opacity: .5; }
.mini { padding: 4px 10px; font-size: 11.5px; border-radius: 8px; background: #232932; }
.ok { margin-top: 10px; font-size: 12px; color: var(--ok); word-break: break-all; }
.alert { margin-top: 10px; border: 1px solid rgba(255, 107, 107, .35); background: rgba(255, 107, 107, .08); color: #ffb4b4; border-radius: 9px; padding: 8px 10px; font-size: 12px; }
.note-hint { font-size: 11.5px; }
.list { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow: auto; }
.item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; font-size: 12.5px; }
.item:hover { background: #1d222a; }
.item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--muted-2); font-size: 12px; padding: 10px 4px; }
.head-actions { display: flex; gap: 6px; }
.tips { margin: 0; padding-left: 18px; font-size: 12px; color: var(--muted); line-height: 1.9; }
</style>
