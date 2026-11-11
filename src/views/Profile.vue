<script setup>
/**
 * 测声：分析音域与音色，给出适合的歌曲和建议变调
 */
import { computed, onMounted, ref } from 'vue';
import { SONGS, midiToNote, suggestShift } from '../data/songs.js';

const file = ref('');
const fileName = ref('');
const separate = ref(false);
const busy = ref(false);
const error = ref('');
const profile = ref(null);
const refs = ref([]);
const useRef = ref('');

const NOTE_LOW = 36; // C2
const NOTE_HIGH = 88; // E6

const rangeLeft = computed(() => {
  if (!profile.value) return 0;
  return ((profile.value.low - NOTE_LOW) / (NOTE_HIGH - NOTE_LOW)) * 100;
});
const rangeWidth = computed(() => {
  if (!profile.value) return 0;
  return ((profile.value.high - profile.value.low) / (NOTE_HIGH - NOTE_LOW)) * 100;
});
const comfortLeft = computed(() => {
  if (!profile.value) return 0;
  return ((profile.value.p20 - NOTE_LOW) / (NOTE_HIGH - NOTE_LOW)) * 100;
});
const comfortWidth = computed(() => {
  if (!profile.value) return 0;
  return ((profile.value.p80 - profile.value.p20) / (NOTE_HIGH - NOTE_LOW)) * 100;
});

const recommendations = computed(() => {
  const p = profile.value;
  if (!p) return [];
  // 舒适区按 20~80 百分位；可唱区放宽到实测最低/最高音各 1 个半音
  const comfort = { low: p.p20, high: p.p80 };
  const usable = { low: p.low - 1, high: p.high + 1 };

  const rows = SONGS.map((s) => {
    let tier = 2;
    let shift = 0;
    let fits = false;
    const c = suggestShift(s, comfort.low, comfort.high);
    if (c.fits) {
      tier = 0; shift = c.shift; fits = true;
    } else {
      const u = suggestShift(s, usable.low, usable.high);
      shift = u.shift;
      if (u.fits) { tier = 1; fits = true; }
    }
    return {
      ...s,
      shift,
      fits,
      tier,
      range: midiToNote(s.low) + '–' + midiToNote(s.high),
      label: fits ? (shift === 0 ? '原调' : (shift > 0 ? `升 ${shift}` : `降 ${-shift}`)) : '—',
      verdict: tier === 0 ? '舒适' : (tier === 1 ? '能唱' : '吃力'),
    };
  });

  return rows.sort((a, b) => a.tier - b.tier || Math.abs(a.shift) - Math.abs(b.shift));
});

async function refreshRefs() {
  const list = await window.api.refs();
  refs.value = Array.isArray(list) ? list : [];
}

onMounted(() => {
  refreshRefs();
  const preset = new URLSearchParams(String(location.hash || '').replace(/^#/, '')).get('clip');
  if (preset) {
    file.value = preset;
    fileName.value = preset.split(/[\\\\/]/).pop();
  }
});

async function pick() {
  error.value = '';
  const r = await window.api.pickAudio();
  if (r && r.ok) {
    file.value = r.path;
    fileName.value = r.name || r.path.split(/[\\/]/).pop();
  }
}

async function useRefAudio() {
  if (!useRef.value) return;
  file.value = useRef.value;
  fileName.value = useRef.value.split(/[\\/]/).pop();
}

async function analyze() {
  if (!file.value) { error.value = '先选一段音频'; return; }
  error.value = '';
  profile.value = null;
  busy.value = true;
  try {
    const r = await window.api.profileAnalyze({ path: file.value, separate: separate.value });
    if (!r.ok) { error.value = r.error || '分析失败'; return; }
    profile.value = r.profile;
  } catch (e) {
    error.value = String(e.message || e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="profile">
    <section class="card">
      <div class="editor-head">
        <span>测音域 <em class="muted">（给一段清唱或人声干声，5 秒以上）</em></span>
      </div>

      <div class="row">
        <button class="mini" @click="pick">选择音频</button>
        <span class="name mono">{{ fileName || '没选文件' }}</span>
      </div>

      <div class="row" v-if="refs.length">
        <select v-model="useRef" style="max-width: 260px">
          <option value="">用已有参考音频…</option>
          <option v-for="r in refs" :key="r.path" :value="r.path">{{ r.name }}</option>
        </select>
        <button class="mini" :disabled="!useRef" @click="useRefAudio">使用</button>
      </div>

      <label class="check">
        <input type="checkbox" v-model="separate" />
        选的歌带伴奏，先分离人声（多花 1~3 分钟）
      </label>

      <div class="actions">
        <button class="primary" :disabled="busy || !file" @click="analyze">
          {{ busy ? '分析中…' : '开始分析' }}
        </button>
      </div>

      <div v-if="error" class="alert">{{ error }}</div>
    </section>

    <section v-if="profile" class="card">
      <div class="editor-head">
        <span>
          结果 <em class="muted">{{ profile.voiceType }} · {{ profile.gender }}声 · {{ profile.bright }}{{ profile.airy ? '、气声偏多' : '' }}</em>
        </span>
      </div>

      <div class="range">
        <div class="range-track">
          <div class="range-span" :style="{ left: rangeLeft + '%', width: rangeWidth + '%' }"></div>
          <div class="range-comfort" :style="{ left: comfortLeft + '%', width: comfortWidth + '%' }"></div>
        </div>
        <div class="range-labels">
          <span class="mono">{{ profile.noteLow }}</span>
          <span class="muted">舒适区 {{ profile.noteComfortLow }}–{{ profile.noteComfortHigh }}</span>
          <span class="mono">{{ profile.noteHigh }}</span>
        </div>
      </div>

      <div class="stats">
        <div><span>音域跨度</span><b class="mono">{{ profile.spanSemitones }} 半音</b></div>
        <div><span>中位音高</span><b class="mono">{{ midiToNote(profile.median) }}</b></div>
        <div><span>发声占比</span><b class="mono">{{ profile.voiced }}%</b></div>
        <div><span>音色亮度</span><b class="mono">{{ profile.centroid }} Hz</b></div>
        <div><span>谐波/噪声</span><b class="mono">{{ profile.harmonicRatio }}</b></div>
        <div><span>动态范围</span><b class="mono">{{ profile.dynamic }}×</b></div>
      </div>
    </section>

    <section v-if="profile" class="card">
      <div class="editor-head">
        <span>适合唱的歌 <em class="muted">按你的舒适区算，变调以半音为单位</em></span>
      </div>
      <div class="songs">
        <div v-for="s in recommendations" :key="s.name + s.artist" class="song" :class="{ tight: !s.fits }">
          <span class="song-name">{{ s.name }}</span>
          <span class="song-artist">{{ s.artist }}</span>
          <span class="song-range mono">{{ s.range }}</span>
          <span class="song-shift mono">{{ s.shift === 0 ? '原调' : s.label }}</span>
          <span class="song-verdict" :class="'t' + s.tier">{{ s.verdict }}</span>
        </div>
      </div>
    </section>

    <section v-if="!profile" class="card">
      <div class="editor-head"><span>怎么测才准</span></div>
      <ul class="tips">
        <li>最好给清唱：同一人、无伴奏、唱 30 秒以上，尽量包含你的最低音和最高音</li>
        <li>给带伴奏的歌也行，勾上「先分离人声」，但会多花 1~3 分钟</li>
        <li>朗读录音也能测，但音域会明显偏窄，不适合拿来选歌</li>
        <li>分析只读文件、不修改任何东西；结果里的「舒适区」是第 20~80 百分位音高</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.profile { display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.name { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); margin: 4px 0 10px; }
.actions { margin-top: 6px; }

.range { margin: 6px 0 14px; }
.range-track {
  position: relative;
  height: 26px;
  border-radius: 6px;
  background: var(--inset);
  border: 1px solid var(--line);
  overflow: hidden;
}
.range-span {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(224, 138, 63, .28);
  border-left: 1px solid var(--accent);
  border-right: 1px solid var(--accent);
}
.range-comfort {
  position: absolute;
  top: 6px;
  bottom: 6px;
  background: var(--accent);
  border-radius: 3px;
}
.range-labels { display: flex; justify-content: space-between; font-size: 11px; margin-top: 6px; }

.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 18px; }
.stats div { display: flex; flex-direction: column; gap: 2px; }
.stats span { font-size: 10.5px; color: var(--muted-2); }
.stats b { font-size: 12.5px; font-weight: 600; }

.songs { display: flex; flex-direction: column; }
.song {
  display: grid;
  grid-template-columns: 1.4fr 1fr 0.9fr 0.7fr 0.9fr;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 8px;
  border-bottom: 1px solid var(--line-soft);
  font-size: 12px;
}
.song:last-child { border-bottom: none; }
.song.tight { opacity: .55; }`n.song .song-verdict.t0 { color: var(--ok); }`n.song .song-verdict.t1 { color: var(--warn); }
.song-name { color: var(--text); }
.song-artist { color: var(--muted-2); font-size: 11px; }
.song-range { color: var(--muted); font-size: 11px; }
.song-shift { color: var(--accent); font-size: 11px; }
.song-verdict { color: var(--muted); font-size: 11px; text-align: right; }
.tips { margin: 0; padding-left: 16px; font-size: 12px; line-height: 1.9; color: var(--muted); }
.tips li::marker { color: var(--muted-2); }
</style>
