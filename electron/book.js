'use strict';
// 音频书：长文分章 → 逐句合成（可续跑）→ 合并成带章节的 m4a
// 依赖主进程注入：payloadRoot / log / send / synthOne / setVoice / app

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

module.exports = function initBook(deps) {
  const { app, payloadRoot, log, send, synthOne, setVoice } = deps;

  let cancel = false;
  let running = false;
  let current = null; // { dir, name }

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
    if (seconds <= 0) return null;
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

  async function buildM4a(wavFiles, titles, gaps, outM4a) {
    const tmpDir = path.dirname(outM4a);
    const gapFile = path.join(tmpDir, '.gap.wav');
    await makeSilence(gapFile, gaps);
    // 拼接：章之间插入静音
    const parts = [];
    wavFiles.forEach((f, i) => {
      parts.push(f);
      if (i < wavFiles.length - 1 && gaps > 0) parts.push(gapFile);
    });
    const fullWav = path.join(tmpDir, 'full.wav');
    const ok = await concatWavs(parts, fullWav);
    if (!ok) throw new Error('章节合并失败');

    // 章节元数据
    let t = 0;
    const meta = [';FFMETADATA1'];
    for (let i = 0; i < wavFiles.length; i += 1) {
      const d = wavDur(wavFiles[i]);
      const start = Math.round(t * 1000);
      const end = Math.round((t + d) * 1000);
      meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${titles[i]}`);
      t += d + gaps;
    }
    const metaFile = path.join(tmpDir, 'chapters.txt');
    fs.writeFileSync(metaFile, meta.join('\n'), 'utf8');

    const plain = path.join(tmpDir, 'plain.m4a');
    let r = await run(ffmpeg(), ['-y', '-v', 'error', '-i', fullWav, '-c:a', 'aac', '-b:a', '96k', plain]);
    if (r.code !== 0) throw new Error('转码失败: ' + r.err);
    r = await run(ffmpeg(), ['-y', '-v', 'error', '-i', plain, '-i', metaFile, '-map_metadata', '1', '-map', '0:a', '-c', 'copy', outM4a]);
    if (r.code !== 0) throw new Error('写入章节失败: ' + r.err);
    try { fs.unlinkSync(plain); fs.unlinkSync(fullWav); fs.unlinkSync(metaFile); fs.unlinkSync(gapFile); } catch (_) {}
    return true;
  }

  // ---------- IPC ----------

  function register(ipcMain) {
    ipcMain.handle('book:parse', (_e, { text, maxChars }) => {
      try {
        const chapters = splitChapters(text, Number(maxChars) || 3000);
        return { ok: true, chapters, totalChars: chapters.reduce((s, c) => s + c.chars, 0) };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    });

    ipcMain.handle('book:state', () => ({ running, cancel: false, dir: current ? current.dir : '' }));

    ipcMain.handle('book:stop', () => {
      cancel = true;
      log('音频书：收到停止请求');
      return { ok: true };
    });

    ipcMain.handle('book:start', async (_e, opts) => {
      if (running) return { ok: false, error: '已有任务在跑' };
      const chapters = opts.chapters || [];
      if (!chapters.length) return { ok: false, error: '没有章节' };

      running = true;
      cancel = false;
      const gap = Number(opts.gapSec) || 0.4;
      const dir = path.join(payloadRoot(), 'output', `audiobook_${slug(opts.name)}-${stamp()}`);
      const partsRoot = path.join(dir, 'parts');
      fs.mkdirSync(partsRoot, { recursive: true });
      current = { dir, name: opts.name };
      fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ name: opts.name, chapters, params: opts.params, gap }, null, 2), 'utf8');

      try {
        if (opts.voice && opts.voice.sovits) {
          const v = await setVoice(opts.voice.sovits, opts.voice.gpt);
          if (!v.ok) throw new Error('切换音色失败: ' + v.error);
        }

        const chapterWavs = [];
        const titles = [];
        let doneSentences = 0;
        const totalSentences = chapters.reduce((s, c) => s + c.sentences.length, 0);
        const failures = [];

        for (let ci = 0; ci < chapters.length; ci += 1) {
          if (cancel) break;
          const ch = chapters[ci];
          const chDir = path.join(partsRoot, String(ci).padStart(3, '0'));
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
                const buf = await synthOne(Object.assign({}, opts.params || {}, { text: sent, refPath: opts.ref.path, refText: opts.ref.text, seed }));
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
            const chWav = path.join(dir, `chapter_${String(ci + 1).padStart(3, '0')}.wav`);
            const okConcat = await concatWavs(files, chWav);
            if (okConcat) {
              chapterWavs.push(chWav);
              titles.push(ch.title);
            }
            send('book:chapter', { index: ci, title: ch.title, status: okConcat ? 'done' : 'failed' });
          } else {
            send('book:chapter', { index: ci, title: ch.title, status: 'failed' });
          }
        }

        let m4a = '';
        if (chapterWavs.length) {
          m4a = path.join(dir, `${slug(opts.name)}.m4a`);
          send('book:export', { status: 'running' });
          await buildM4a(chapterWavs, titles, gap, m4a);
          send('book:export', { status: 'done', path: m4a });
        }

        return { ok: true, dir, m4a, chapters: chapterWavs.length, failures, canceled: cancel };
      } catch (err) {
        log('音频书失败：' + String(err.message || err));
        return { ok: false, error: String(err.message || err), dir };
      } finally {
        running = false;
        cancel = false;
      }
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
          dir,
          name: meta.name || d.name,
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
