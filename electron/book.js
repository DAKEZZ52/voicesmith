'use strict';
// 音频书：长文分章 → 逐句合成（可续跑）→ 合并成带章节的 m4a
// 支持按章重做（book:resume + onlyChapter）

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

module.exports = function initBook(deps) {
  const { app, payloadRoot, log, send, synthOne, setVoice } = deps;

  let cancel = false;
  let running = false;
  let current = null;

  const pad3 = (n) => String(n).padStart(3, '0');
  const wavDur = (file) => {
    try { return Math.max(0, (fs.statSync(file).size - 44)) / (32000 * 2); } catch (_) { return 0; }
  };
  const ffmpeg = () => path.join(payloadRoot(), 'runtime', 'ffmpeg.exe');
  const slug = (s) => String(s || 'book').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 20) || 'book';
  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  };

  function splitSentences(text) {
    const s = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!s) return [];
    const raw = s.split(/(?<=[。！？!?；;…》」』）)])\s*|\n+/);
    const out = [];
    for (let p of raw) {
      p = p.trim();
      if (!p) continue;
      if (p.length <= 50) { out.push(p); continue; }
      let cur = '';
      for (const c of p.split(/(?<=[，,、：:])/)) {
        if ((cur + c).length > 40) { if (cur.trim()) out.push(cur.trim()); cur = c; } else cur += c;
      }
      if (cur.trim()) out.push(cur.trim());
    }
    return out;
  }

  function splitChapters(text, maxChars = 3000) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const isHeading = (l) => /^\s*(第[0-9一二三四五六七八九十百千零两]+[章节回卷篇]|Chapter\s+\d+|#{1,3}\s+\S)/i.test(l);
    const headingCount = lines.filter((l) => l.trim() && isHeading(l)).length;
    const chapters = [];

    if (headingCount >= 2) {
      let cur = null;
      for (const l of lines) {
        if (l.trim() && isHeading(l)) {
          if (cur && cur.lines.length) chapters.push(cur);
          cur = { title: l.replace(/^#+\s*/, '').trim().slice(0, 40), lines: [] };
        } else {
          if (!cur) cur = { title: '正文', lines: [] };
          cur.lines.push(l);
        }
      }
      if (cur && cur.lines.length) chapters.push(cur);
    } else {
      let buf = [];
      let size = 0;
      for (const l of lines) {
        const t = l.trim();
        if (!t) continue;
        if (size + t.length > maxChars && buf.length) {
          chapters.push({ title: `第 ${chapters.length + 1} 段`, lines: buf });
          buf = []; size = 0;
        }
        buf.push(t); size += t.length;
      }
      if (buf.length) chapters.push({ title: `第 ${chapters.length + 1} 段`, lines: buf });
    }

    return chapters
      .map((c, i) => {
        const sentences = splitSentences(c.lines.join('\n'));
        return { index: i, title: c.title || `第 ${i + 1} 章`, chars: sentences.join('').length, sentences };
      })
      .filter((c) => c.sentences.length);
  }

  function run(cmd, args, cwd) {
    return new Promise((resolve) => {
      const p = spawn(cmd, args, { cwd, windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('close', (code) => resolve({ code, err: err.slice(-400) }));
    });
  }

  async function makeSilence(file, seconds) {
    const r = await run(ffmpeg(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', String(seconds), '-c:a', 'pcm_s16le', file]);
    return r.code === 0 ? file : null;
  }

  async function concatWavs(files, out) {
    const listFile = out + '.txt';
    fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
    const r = await run(ffmpeg(), ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out]);
    try { fs.unlinkSync(listFile); } catch (_) {}
    return r.code === 0;
  }

  // 用目录里现有的 chapter_*.wav 重新导出 m4a（含章节）
  async function exportBook(dir, name, gap) {
    const files = fs.readdirSync(dir).filter((f) => /^chapter_\d{3}\.wav$/.test(f)).sort();
    if (!files.length) return '';
    const metaFile = path.join(dir, 'book.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) {}
    const titles = files.map((f, i) => {
      const idx = Number(f.slice(8, 11)) - 1;
      const ch = (meta.chapters || [])[idx];
      return ch ? ch.title : `第 ${idx + 1} 章`;
    });

    const gapFile = path.join(dir, '.gap.wav');
    if (gap > 0) await makeSilence(gapFile, gap);
    const parts = [];
    files.forEach((f, i) => {
      parts.push(path.join(dir, f));
      if (i < files.length - 1 && gap > 0) parts.push(gapFile);
    });
    const fullWav = path.join(dir, 'full.wav');
    if (!(await concatWavs(parts, fullWav))) throw new Error('章节合并失败');

    let t = 0;
    const metaLines = [';FFMETADATA1'];
    for (let i = 0; i < files.length; i += 1) {
      const d = wavDur(path.join(dir, files[i]));
      metaLines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(t * 1000)}`, `END=${Math.round((t + d) * 1000)}`, `title=${titles[i]}`);
      t += d + gap;
    }
    const metaTxt = path.join(dir, 'chapters.txt');
    fs.writeFileSync(metaTxt, metaLines.join('\n'), 'utf8');

    const plain = path.join(dir, 'plain.m4a');
    let r = await run(ffmpeg(), ['-y', '-v', 'error', '-i', fullWav, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '96k', plain]);
    if (r.code !== 0) throw new Error('转码失败: ' + r.err);
    const out = path.join(dir, `${slug(name || meta.name || 'book')}.m4a`);
    r = await run(ffmpeg(), ['-y', '-v', 'error', '-i', plain, '-i', metaTxt, '-map_metadata', '1', '-map', '0:a', '-c', 'copy', out]);
    if (r.code !== 0) throw new Error('写入章节失败: ' + r.err);
    try { fs.unlinkSync(plain); fs.unlinkSync(fullWav); fs.unlinkSync(metaTxt); fs.unlinkSync(gapFile); } catch (_) {}
    return out;
  }

  // 逐章逐句合成；idxs 指定只跑哪几章
  async function runChapters(ctx) {
    const { dir, chapters, idxs, params, ref, partsRoot } = ctx;
    const failures = [];
    let doneSentences = 0;
    const totalSentences = idxs.reduce((s, i) => s + chapters[i].sentences.length, 0);

    for (const ci of idxs) {
      if (cancel) break;
      const ch = chapters[ci];
      const chDir = path.join(partsRoot, pad3(ci));
      fs.mkdirSync(chDir, { recursive: true });
      send('book:chapter', { index: ci, title: ch.title, status: 'running', sentences: ch.sentences.length });

      const files = [];
      for (let si = 0; si < ch.sentences.length; si += 1) {
        if (cancel) break;
        const sent = ch.sentences[si];
        const file = path.join(chDir, String(si).padStart(4, '0') + '.wav');
        if (fs.existsSync(file) && fs.statSync(file).size > 2000) {
          files.push(file);
          doneSentences += 1;
          send('book:progress', { done: doneSentences, total: totalSentences, text: sent, skipped: true });
          continue;
        }
        let ok = false;
        let lastErr = '';
        for (const seed of [666, 2024, 1234, 8888]) {
          if (cancel) break;
          try {
            const buf = await synthOne(Object.assign({}, params || {}, { text: sent, refPath: ref.path, refText: ref.text, seed }));
            if (buf.length < 2000) throw new Error('没发声');
            fs.writeFileSync(file, buf);
            files.push(file);
            ok = true;
            break;
          } catch (err) {
            lastErr = String(err.message || err);
          }
        }
        doneSentences += 1;
        if (!ok) {
          failures.push({ chapter: ch.title, text: sent, error: lastErr });
          log(`音频书：跳过一句（${ch.title}）：${sent.slice(0, 20)}… ${lastErr}`);
        }
        send('book:progress', { done: doneSentences, total: totalSentences, text: sent, ok });
      }

      if (files.length) {
        const chWav = path.join(dir, `chapter_${pad3(ci + 1)}.wav`);
        const okConcat = await concatWavs(files, chWav);
        send('book:chapter', { index: ci, title: ch.title, status: okConcat ? 'done' : 'failed' });
      } else {
        send('book:chapter', { index: ci, title: ch.title, status: 'failed' });
      }
    }
    return { failures, doneSentences, totalSentences };
  }

  async function prepare(dir, voice) {
    if (voice && voice.sovits) {
      const v = await setVoice(voice.sovits, voice.gpt);
      if (!v.ok) throw new Error('切换音色失败: ' + v.error);
    }
  }

  function register(ipcMain) {
    ipcMain.handle('book:parse', (_e, { text, maxChars }) => {
      try {
        const chapters = splitChapters(text, Number(maxChars) || 3000);
        return { ok: true, chapters, totalChars: chapters.reduce((s, c) => s + c.chars, 0) };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    });

    ipcMain.handle('book:state', () => ({ running, dir: current ? current.dir : '' }));

    ipcMain.handle('book:stop', () => { cancel = true; log('音频书：收到停止请求'); return { ok: true }; });

    ipcMain.handle('book:start', async (_e, opts) => {
      if (running) return { ok: false, error: '已有任务在跑' };
      const chapters = opts.chapters || [];
      if (!chapters.length) return { ok: false, error: '没有章节' };
      running = true; cancel = false;
      const gap = Number(opts.gapSec) || 0;
      const dir = path.join(payloadRoot(), 'output', `audiobook_${slug(opts.name)}-${stamp()}`);
      const partsRoot = path.join(dir, 'parts');
      fs.mkdirSync(partsRoot, { recursive: true });
      current = { dir };
      fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ name: opts.name, chapters, params: opts.params, gap }, null, 2), 'utf8');
      try {
        await prepare(dir, opts.voice);
        const r = await runChapters({ dir, chapters, idxs: chapters.map((c) => c.index), params: opts.params, ref: opts.ref, partsRoot });
        send('book:export', { status: 'running' });
        const m4a = await exportBook(dir, opts.name, gap);
        send('book:export', { status: 'done', path: m4a });
        return { ok: true, dir, m4a, failures: r.failures, canceled: cancel };
      } catch (err) {
        log('音频书失败：' + String(err.message || err));
        return { ok: false, error: String(err.message || err), dir };
      } finally { running = false; cancel = false; }
    });

    // 继续 / 重做目录里已有的书；onlyChapter 指定只重做某一章
    ipcMain.handle('book:resume', async (_e, opts) => {
      if (running) return { ok: false, error: '已有任务在跑' };
      const dir = String(opts.dir || '');
      const bookFile = path.join(dir, 'book.json');
      if (!fs.existsSync(bookFile)) return { ok: false, error: '找不到这本书的记录' };
      const meta = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
      const chapters = meta.chapters || [];
      if (!chapters.length) return { ok: false, error: '这本书没有章节' };
      running = true; cancel = false;
      current = { dir };
      const partsRoot = path.join(dir, 'parts');
      const gap = Number(opts.gapSec != null ? opts.gapSec : meta.gap) || 0;
      try {
        await prepare(dir, opts.voice);
        let idxs = chapters.map((c) => c.index);
        if (Number.isInteger(opts.onlyChapter)) {
          idxs = [opts.onlyChapter];
          fs.rmSync(path.join(partsRoot, pad3(opts.onlyChapter)), { recursive: true, force: true });
          try { fs.unlinkSync(path.join(dir, `chapter_${pad3(opts.onlyChapter + 1)}.wav`)); } catch (_) {}
        }
        const r = await runChapters({ dir, chapters, idxs, params: meta.params, ref: opts.ref, partsRoot });
        send('book:export', { status: 'running' });
        const m4a = await exportBook(dir, meta.name, gap);
        send('book:export', { status: 'done', path: m4a });
        return { ok: true, dir, m4a, failures: r.failures, canceled: cancel };
      } catch (err) {
        log('音频书续跑失败：' + String(err.message || err));
        return { ok: false, error: String(err.message || err) };
      } finally { running = false; cancel = false; }
    });

    ipcMain.handle('book:detail', (_e, { dir }) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
        const have = fs.readdirSync(dir).filter((f) => /^chapter_\d{3}\.wav$/.test(f));
        const m4a = fs.readdirSync(dir).find((f) => f.endsWith('.m4a')) || '';
        return {
          ok: true,
          name: meta.name,
          gap: meta.gap,
          m4a: m4a ? path.join(dir, m4a) : '',
          chapters: (meta.chapters || []).map((c) => ({
            index: c.index, title: c.title, sentences: c.sentences.length, chars: c.chars,
            hasWav: have.includes(`chapter_${pad3(c.index + 1)}.wav`)
          }))
        };
      } catch (err) { return { ok: false, error: String(err.message || err) }; }
    });

    ipcMain.handle('book:list', () => {
      const root = path.join(payloadRoot(), 'output');
      const out = [];
      if (!fs.existsSync(root)) return out;
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory() || !d.name.startsWith('audiobook_')) continue;
        const dir = path.join(root, d.name);
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8')); } catch (_) {}
        const m4a = fs.readdirSync(dir).find((f) => f.endsWith('.m4a'));
        out.push({
          dir, name: meta.name || d.name,
          chapters: (meta.chapters || []).length,
          m4a: m4a ? path.join(dir, m4a) : '',
          mtime: fs.statSync(dir).mtime.toISOString()
        });
      }
      return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    });
  }

  return { register, splitChapters, splitSentences };
};
