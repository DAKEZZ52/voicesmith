<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({ ready: { type: Boolean, default: false } });

const text = ref('');
const bookName = ref('');
const chapters = ref([]);
const parsed = ref(false);
const running = ref(false);
const stopping = ref(false);
const done = ref(0);
const total = ref(0);
const currentLine = ref('');
const chaptersState = ref({});
const exportInfo = ref(null);
const error = ref('');
const logs = ref([]);
const history = ref([]);
const detail = ref(null);
const redeeming = ref(-1);
const gapSec = ref(0.6);
const speed = ref(1);
const maxChars = ref(3000);
let offs = [];

const chars = computed(() => text.value.replace(/\s/g, '').length);
const percent = computed(() => (total.value ? Math.round((done.value / total.value) * 100) : 0));
const estMinutes = computed(() => {
  // 中文约 4.2 字/秒
  const sec = chars.value / 4.2;
  return Math.round(sec / 60);
});

onMounted(async () => {
  offs.push(window.api.on('book:progress', (p) => {
    done.value = p.done;
    total.value = p.total;
    currentLine.value = p.text || '';
    if (!p.ok && !p.skipped) error.value = `有一句失败，已跳过：「${(p.text || '').slice(0, 16)}…」`;
  }));
  offs.push(window.api.on('book:chapter', (p) => {
    chaptersState.value = Object.assign({}, chaptersState.value, { [p.index]: p.status });
  }));
  offs.push(window.api.on('book:export', (p) => {
    if (p.status === 'running') exportInfo.value = { status: 'running' };
    if (p.status === 'done') exportInfo.value = { status: 'done', path: p.path };
  }));
  offs.push(window.api.on('log', (l) => {
    logs.value.push(l);
    if (logs.value.length > 200) logs.value.splice(0, 50);
  }));
  await refreshHistory();
});

onUnmounted(() => offs.forEach((f) => f && f()));

async function importTxt() {
  const res = await window.api.pickTextFile();
  if (!res.ok) { if (res.error) error.value = res.error; return; }
  text.value = res.text;
  if (!bookName.value) bookName.value = res.name.replace(/\.(txt|md)$/i, '');
  await parse();
}

async function parse() {
  error.value = '';
  if (!text.value.trim()) { error.value = '先粘贴或导入文本'; return; }
  const res = await window.api.bookParse({ text: text.value, maxChars: Number(maxChars.value) || 3000 });
  if (!res.ok) { error.value = res.error; return; }
  chapters.value = res.chapters;
  parsed.value = true;
  chaptersState.value = {};
  done.value = 0;
  total.value = res.chapters.reduce((s, c) => s + c.sentences.length, 0);
  if (!bookName.value) bookName.value = '我的有声书';
}

async function start() {
  if (!parsed.value) await parse();
  if (!chapters.value.length) return;
  if (!props.ready) { error.value = '服务还没就绪，等左上角变绿再开始'; return; }
  error.value = '';
  exportInfo.value = null;
  running.value = true;
  stopping.value = false;
  done.value = 0;
  total.value = chapters.value.reduce((s, c) => s + c.sentences.length, 0);
  chaptersState.value = {};

  const voice = await window.api.voices();
  const cur = (voice.pairs || [])[0] || null;
  const refs = await window.api.refs();
  const ref = refs && refs.length ? refs[0] : null;
  if (!cur) { running.value = false; error.value = '没有可用音色'; return; }
  if (!ref) { running.value = false; error.value = '没有参考音频'; return; }

  const res = await window.api.bookStart({
    name: bookName.value || '我的有声书',
    // 传普通对象：Vue 的响应式代理无法跨 IPC 结构化克隆
    chapters: chapters.value.map((c) => ({
      index: c.index, title: c.title, chars: c.chars, sentences: c.sentences.slice()
    })),
    voice: { sovits: cur.sovits, gpt: cur.gpt, name: cur.name },
    ref: { path: ref.path, text: ref.text || '' },
    params: { speed: Number(speed.value) || 1 },
    gapSec: Number(gapSec.value) || 0
  });
  running.value = false;
  stopping.value = false;
  if (!res.ok) { error.value = res.error; return; }
  if (res.failures && res.failures.length) {
    error.value = `完成 ${res.chapters}/${chapters.value.length} 章，${res.failures.length} 句被跳过（可再点开始续跑）`;
  }
  await refreshHistory();
}

async function stop() {
  stopping.value = true;
  await window.api.bookStop();
}

async function refreshHistory() {
  history.value = await window.api.bookList();
}

async function ctx() {
  const voice = await window.api.voices();
  const cur = (voice.pairs || [])[0] || null;
  const refs = await window.api.refs();
  const ref = refs && refs.length ? refs[0] : null;
  if (!cur || !ref) throw new Error('缺少音色或参考音频');
  return {
    voice: { sovits: cur.sovits, gpt: cur.gpt, name: cur.name },
    ref: { path: ref.path, text: ref.text || '' }
  };
}

async function toggleDetail(b) {
  if (detail.value && detail.value.dir === b.dir) { detail.value = null; return; }
  const d = await window.api.bookDetail({ dir: b.dir });
  if (!d.ok) { error.value = d.error; return; }
  detail.value = Object.assign({ dir: b.dir }, d);
}

async function redoChapter(ch) {
  if (!detail.value) return;
  if (!props.ready) { error.value = '服务还没就绪'; return; }
  error.value = '';
  redeeming.value = ch.index;
  try {
    const c = await ctx();
    running.value = true;
    done.value = 0;
    total.value = ch.sentences;
    const res = await window.api.bookResume({
      dir: detail.value.dir, onlyChapter: ch.index,
      voice: c.voice, ref: c.ref, gapSec: Number(detail.value.gap) || 0
    });
    if (!res.ok) error.value = res.error;
    else if (res.failures && res.failures.length) error.value = `该章有 ${res.failures.length} 句失败`;
  } catch (e) {
    error.value = String(e.message || e);
  } finally {
    running.value = false;
    redeeming.value = -1;
    await refreshHistory();
    if (detail.value) {
      const d = await window.api.bookDetail({ dir: detail.value.dir });
      if (d.ok) detail.value = Object.assign({ dir: detail.value.dir }, d);
    }
  }
}

function openOutput() { window.api.openOutput(); }

async function openBook(b) {
  if (b.m4a) await window.api.openPath(b.m4a);
  else if (b.dir) await window.api.openPath(b.dir);
}
</script>

<template>
  <div class="book">
    <section class="card">
      <div class="editor-head">
        <span>书稿</span>
        <div class="head-actions">
          <button class="mini" @click="importTxt">导入 txt</button>
          <button class="mini" @click="text = ''">清空</button>
        </div>
      </div>
      <textarea v-model="text" class="book-text mono" placeholder="粘贴整本书或长文。程序会自动识别「第一章 / 第1章 / Chapter 1 / # 标题」分章；没有标题就按段落每 3000 字切一章。"></textarea>
      <div class="meta-row">
        <span>{{ chars }} 字 · 约 {{ estMinutes < 1 ? '不到 1' : estMinutes }} 分钟音频</span>
        <span class="muted">章节上限 <input v-model="maxChars" class="num" type="number" min="500" step="500" /> 字</span>
      </div>
    </section>

    <section v-if="parsed" class="card">
      <div class="editor-head">
        <span>章节 <em class="muted">{{ chapters.length }} 章 · {{ total }} 句</em></span>
        <button class="mini" @click="parse">重新分章</button>
      </div>
      <div class="chapter-list">
        <div v-for="c in chapters" :key="c.index" class="chapter-row" :class="chaptersState[c.index]">
          <span class="idx">{{ String(c.index + 1).padStart(2, '0') }}</span>
          <span class="title">{{ c.title }}</span>
          <span class="meta">{{ c.sentences.length }} 句 · {{ c.chars }} 字</span>
          <span class="state">{{ chaptersState[c.index] === 'done' ? '完成' : chaptersState[c.index] === 'running' ? '合成中' : chaptersState[c.index] === 'failed' ? '失败' : '' }}</span>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="editor-head">
        <span>生成</span>
        <span class="muted">{{ percent }}% · {{ done }}/{{ total }} 句</span>
      </div>
      <div class="bar"><i :style="{ width: percent + '%' }"></i></div>
      <div class="opts">
        <label>书稿名 <input v-model="bookName" class="txt" placeholder="我的有声书" /></label>
        <label>章节间隔 <input v-model="gapSec" class="num" type="number" min="0" max="5" step="0.2" /> 秒</label>
        <label>语速 <input v-model="speed" class="num" type="number" min="0.5" max="2" step="0.05" /></label>
      </div>
      <div class="line mono" v-if="currentLine">{{ currentLine.slice(0, 40) }}</div>
      <div class="actions">
        <button class="primary" :disabled="running" @click="start">{{ running ? '合成中…' : '开始生成' }}</button>
        <button class="mini" :disabled="!running || stopping" @click="stop">{{ stopping ? '正在停止…' : '停止' }}</button>
        <span class="muted hint">中断后再点「开始生成」会跳过已完成的句子，从断点续跑</span>
      </div>
      <div v-if="exportInfo && exportInfo.status === 'done'" class="ok">已导出 m4a（带章节）：<span class="mono">{{ exportInfo.path }}</span></div>
      <div v-if="error" class="alert">{{ error }}</div>
    </section>

    <section class="card">
      <div class="editor-head">
        <span>历史 <em class="muted">{{ history.length }} 本</em></span>
        <div class="head-actions">
          <button class="mini" @click="openOutput">打开目录</button>
          <button class="mini" @click="refreshHistory">刷新</button>
        </div>
      </div>
      <div class="list">
        <div v-for="b in history" :key="b.dir" class="row">
          <span class="name">{{ b.name }}</span>
          <span class="meta">{{ b.chapters }} 章</span>
          <span class="meta mono">{{ b.mtime.slice(5, 16).replace('T', ' ') }}</span>
          <button class="mini" @click="toggleDetail(b)">{{ detail && detail.dir === b.dir ? '收起' : '展开' }}</button>
          <button class="mini" @click="openBook(b)">{{ b.m4a ? '打开 m4a' : '打开目录' }}</button>
        </div>
        <div v-if="!history.length" class="empty">还没有生成过有声书</div>
      </div>

      <div v-if="detail" class="detail">
        <div class="detail-head">
          <b>{{ detail.name }}</b>
          <span class="muted">{{ detail.chapters.length }} 章 · 点「重做」只重新合成该章并刷新 m4a</span>
        </div>
        <div class="chapter-list">
          <div v-for="c in detail.chapters" :key="c.index" class="chapter-row" :class="{ done: c.hasWav }">
            <span class="idx">{{ String(c.index + 1).padStart(2, '0') }}</span>
            <span class="title">{{ c.title }}</span>
            <span class="meta">{{ c.sentences }} 句</span>
            <span class="state">{{ c.hasWav ? '已生成' : '未生成' }}</span>
            <button class="mini" :disabled="running" @click="redoChapter(c)">
              {{ redeeming === c.index ? '重做中…' : '重做' }}
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.book { display: flex; flex-direction: column; gap: 14px; }
.card { background: linear-gradient(180deg, var(--panel), #1c2027); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
.editor-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 10px; }
.editor-head em { font-style: normal; margin-left: 6px; }
.head-actions { display: flex; gap: 6px; }
.book-text { width: 100%; min-height: 180px; max-height: 300px; resize: vertical; background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px; color: var(--text); padding: 12px 14px; font-size: 13px; line-height: 1.7; }
.meta-row { display: flex; justify-content: space-between; margin-top: 8px; font-size: 11.5px; color: var(--muted-2); }
.num { width: 64px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 7px; color: var(--text); padding: 3px 6px; font-size: 12px; }
.detail { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 10px; }
.detail-head { display: flex; align-items: center; gap: 10px; font-size: 12.5px; margin-bottom: 8px; }
.detail-head .muted { font-size: 11px; }
.chapter-row .state { width: 52px; }
.chapter-list { max-height: 240px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.chapter-row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 8px; border: 1px solid transparent; font-size: 12.5px; }
.chapter-row:hover { background: #1d222a; }
.chapter-row.running { border-color: rgba(255, 138, 61, .3); background: rgba(255, 138, 61, .07); }
.chapter-row.done { border-color: rgba(74, 222, 128, .2); }
.chapter-row .idx { color: var(--muted-2); font-size: 11px; }
.chapter-row .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chapter-row .meta { color: var(--muted-2); font-size: 11px; }
.chapter-row .state { color: var(--ok); font-size: 11px; width: 40px; text-align: right; }
.bar { height: 6px; border-radius: 3px; background: #20252d; overflow: hidden; margin-bottom: 12px; }
.bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), #ffb066); transition: width .3s ease; }
.opts { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12px; color: var(--muted); margin-bottom: 10px; }
.opts label { display: flex; align-items: center; gap: 6px; }
.txt { width: 180px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 7px; color: var(--text); padding: 4px 8px; font-size: 12px; }
.line { color: var(--muted-2); font-size: 11.5px; margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; align-items: center; gap: 10px; }
.primary { padding: 9px 22px; border-radius: 9px; background: linear-gradient(180deg, #ff9a4d, #f0761f); color: #1a1206; font-weight: 600; font-size: 13px; }
.primary:disabled { opacity: .6; }
.hint { font-size: 11px; }
.ok { margin-top: 10px; font-size: 12px; color: var(--ok); word-break: break-all; }
.alert { margin-top: 10px; border: 1px solid rgba(255, 107, 107, .35); background: rgba(255, 107, 107, .08); color: #ffb4b4; border-radius: 9px; padding: 8px 10px; font-size: 12px; }
.list { display: flex; flex-direction: column; gap: 2px; max-height: 200px; overflow: auto; }
.row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 8px; font-size: 12.5px; }
.row:hover { background: #1d222a; }
.row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .meta { color: var(--muted-2); font-size: 11px; }
.empty { color: var(--muted-2); font-size: 12px; padding: 12px 6px; }
.mini { padding: 4px 10px; font-size: 11.5px; border-radius: 8px; background: #232932; }
</style>
