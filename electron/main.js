'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { ensureModels, hasAllModels } = require('./models');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) { /* 开发环境可能没有 */ }

let updaterState = { status: 'idle', percent: 0, version: '', error: '' };

const API_PORT = 9880;
let apiPort = API_PORT;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || '';

let mainWindow = null;
let apiProc = null;
let quitting = false;
let phase = 'boot';
let lastError = '';

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------- 日志落盘（崩溃/异常后能查） ----------
let logStream = null;
let logPath = '';
const MAX_LOG_BYTES = 4 * 1024 * 1024;

function initLogFile() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    logPath = path.join(dir, `app-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.log`);
    // 超过上限就轮转一份 .1
    try {
      const st = fs.statSync(logPath);
      if (st.size > MAX_LOG_BYTES) {
        try { fs.unlinkSync(logPath + '.1'); } catch (_) {}
        fs.renameSync(logPath, logPath + '.1');
      }
    } catch (_) {}
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', () => { logStream = null; });
  } catch (_) {
    logStream = null;
  }
}

function writeLine(line) {
  try {
    if (!logStream) return;
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    logStream.write(`[${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}] ${line}\n`);
  } catch (_) {}
}

function logLine(line) {
  const text = String(line == null ? '' : line);
  writeLine(text);
  send('log', text);
  if (process.env.GSO_DEBUG === '1') console.log('[log] ' + text);
}

const log = logLine;
const setPhase = (p, extra) => {
  phase = p;
  logLine('phase -> ' + p);
  send('phase', Object.assign({ phase: p }, extra || {}));
};

function payloadRoot() {
  if (process.env.GPT_SOVITS_PAYLOAD) return process.env.GPT_SOVITS_PAYLOAD;
  const beside = path.join(path.dirname(app.getPath('exe')), 'payload');
  // 装到 Program Files 这类只读目录时，payload 写不进去 → 退到用户数据目录
  try {
    fs.mkdirSync(beside, { recursive: true });
    const probe = path.join(beside, '.writable');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return beside;
  } catch (_) {
    return path.join(app.getPath('userData'), 'payload');
  }
}
const P = (rel) => path.join(payloadRoot(), rel);

function sevenZip() {
  if (app.isPackaged) return path.join(process.resourcesPath, '7za.exe');
  return path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
}

function payloadReady() {
  return fs.existsSync(P('runtime/Scripts/python.exe')) && fs.existsSync(P('webui.py'));
}

function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

// 从旧名字（gpt-sovits-desktop）的用户目录迁移参考音频与配置
function migrateUserData() {
  if (process.env.GSO_NO_MIGRATE === '1') return;
  try {
    const appData = app.getPath('appData');
    const oldDir = path.join(appData, 'gpt-sovits-desktop');
    const newDir = app.getPath('userData');
    if (oldDir === newDir || !fs.existsSync(oldDir)) return;
    const oldRefs = path.join(oldDir, 'refs');
    const newRefs = path.join(newDir, 'refs');
    if (fs.existsSync(oldRefs) && !fs.existsSync(newRefs)) {
      fs.mkdirSync(newDir, { recursive: true });
      fs.cpSync(oldRefs, newRefs, { recursive: true });
      log('已迁移旧版参考音频到新目录');
    }
    const oldCfg = path.join(oldDir, 'config.json');
    const newCfg = path.join(newDir, 'config.json');
    if (fs.existsSync(oldCfg) && !fs.existsSync(newCfg)) {
      fs.copyFileSync(oldCfg, newCfg);
    }
  } catch (_) {}
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (_) { return {}; }
}
function writeConfig(patch) {
  const cfg = Object.assign(readConfig(), patch);
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
  } catch (_) {}
}

// ---------- payload / models ----------

function findPayloadArchive() {
  const names = ['payload.7z', 'payload.7z.001', 'GPT-SoVITS-runtime.7z', 'runtime.7z'];
  const saved = readConfig().payloadArchive;
  if (saved && fs.existsSync(saved)) return saved;
  const dirs = [
    path.dirname(app.getPath('exe')),
    path.join(path.dirname(app.getPath('exe')), 'downloads'),
    process.resourcesPath,
    app.getPath('downloads'),
    app.getPath('desktop')
  ];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// GitHub Release 单文件上限 2GB，运行环境按 payload.7z.001/.002 分卷分发，
// 这里把分卷按序拼回一个完整 7z 再解压。
async function joinPayloadParts(firstPart) {
  const dir = path.dirname(firstPart);
  const base = firstPart.replace(/\.001$/, '');
  const parts = fs.readdirSync(dir)
    .filter((f) => f.startsWith(path.basename(base) + '.') && /\.\d{3}$/.test(f))
    .sort();
  if (!parts.length) return firstPart;
  // 连续性检查：必须 001..NNN 一个不缺，否则拼出来的包必坏
  for (let i = 0; i < parts.length; i += 1) {
    const want = String(i + 1).padStart(3, '0');
    if (parts[i].slice(-3) !== want) {
      throw new Error(`分卷不完整：缺少 ${path.basename(base)}.${want}（现有 ${parts.join(', ')}）`);
    }
  }
  const target = base;
  log('合并运行时包分卷（' + parts.length + ' 个）…');
  const out = fs.createWriteStream(target);
  for (let i = 0; i < parts.length; i += 1) {
    const file = path.join(dir, parts[i]);
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(file);
      input.on('error', reject);
      input.on('end', resolve);
      input.pipe(out, { end: false });
    });
    send('install-progress', { percent: Math.round(((i + 1) / parts.length) * 100) });
  }
  await new Promise((resolve) => out.end(resolve));
  return target;
}

function extractPayload(archive, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dest, { recursive: true });
    const z = sevenZip();
    if (!fs.existsSync(z)) return reject(new Error('缺少 7za.exe'));
    log('解压运行时包: ' + archive);
    const p = spawn(z, ['x', archive, '-o' + dest, '-y', '-bsp1'], { windowsHide: true });
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      const m = String(d).match(/(\d{1,3})%/g);
      if (m) send('install-progress', { percent: parseInt(m[m.length - 1], 10) });
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve(true) : reject(new Error('解压失败(' + code + '): ' + err.slice(-300)))));
  });
}

async function ensurePayload() {
  if (payloadReady()) return true;
  const archive = findPayloadArchive();
  if (!archive) {
    setPhase('need-payload');
    return false;
  }
  const realArchive = /\.001$/.test(archive) ? await joinPayloadParts(archive) : archive;
  setPhase('installing');
  try {
    await extractPayload(realArchive, payloadRoot());
    writeConfig({ payloadArchive: realArchive });
  } catch (err) {
    lastError = String(err.message || err);
    setPhase('error', { error: lastError });
    return false;
  }
  if (!payloadReady()) {
    lastError = '运行时包解压后缺少关键文件';
    setPhase('error', { error: lastError });
    return false;
  }
  return true;
}

// ---------- python api ----------

function portFree(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickApiPort() {
  for (let p = API_PORT; p < API_PORT + 20; p += 1) {
    if (await portFree(p)) return p;
  }
  return API_PORT;
}

function apiOnline() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: apiPort, path: '/openapi.json', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitApi(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await apiOnline()) return true;
    if (apiProc && apiProc.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

// 运行环境的 python 选择：
// uv 建的 venv 里 Scripts\python.exe 是个 46KB 的启动器，里面写死了创建时的绝对路径，
// 整个目录搬到别处后它会去找旧路径（甚至旧机器上的 .python）。
// 所以优先用 payload 自带的 base python + PYTHONPATH 指向 venv 的 site-packages，完全可搬移。
function pythonRuntime(root) {
  const baseExe = path.join(root, '.python', 'cpython-3.12-windows-x86_64-none', 'python.exe');
  const venvExe = path.join(root, 'runtime', 'Scripts', 'python.exe');
  const site = path.join(root, 'runtime', 'Lib', 'site-packages');
  const useBase = fs.existsSync(baseExe) && fs.existsSync(site);
  return {
    exe: useBase ? baseExe : venvExe,
    useBase,
    site
  };
}

function startApi() {
  const root = payloadRoot();
  const rt = pythonRuntime(root);
  const py = rt.exe;
  const dict = path.join(process.env.LOCALAPPDATA || root, 'GPT-SoVITS', 'open_jtalk_dic_utf_8-1.11');
  const env = Object.assign({}, process.env, {
    PATH: path.join(root, 'runtime') + ';' + process.env.PATH,
    OPEN_JTALK_DICT_DIR: dict,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1'
  });
  if (rt.useBase) env.PYTHONPATH = rt.site;
  log('启动 TTS 服务…');
  apiProc = spawn(py, ['-s', 'api_v2.py', '-c', 'GPT_SoVITS/configs/tts_infer.yaml', '-p', String(apiPort)],
    { cwd: root, env, windowsHide: true });
  apiProc.stdout.setEncoding('utf8');
  apiProc.stderr.setEncoding('utf8');
  const pipe = (d) => d.split(/\r?\n/).filter(Boolean).slice(-2).forEach(log);
  apiProc.stdout.on('data', pipe);
  apiProc.stderr.on('data', pipe);
  apiProc.on('exit', (code) => {
    if (quitting) return;
    if (apiKilling) {
      apiKilling = false;
      log('TTS 服务已主动停止（翻唱前释放显存）');
      return;
    }
    log('TTS 服务退出 code=' + code);
    setPhase('error', { error: 'TTS 服务已退出（code ' + code + '）' });
  });
}

let apiKilling = false;

function killApi() {
  if (!apiProc || apiProc.exitCode !== null) return;
  apiKilling = true;
  try { spawn('taskkill', ['/PID', String(apiProc.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
}

async function boot() {
  lastError = '';
  setPhase('checking');
  if (!(await ensurePayload())) return;
  if (!hasAllModels(payloadRoot())) {
    setPhase('need-models');
    return;
  }
  // 9880 被占用时换一个空闲端口，避免把别人的服务当成自己的
  apiPort = await pickApiPort();
  if (await apiOnline()) {
    setPhase('ready');
    return;
  }
  setPhase('starting');
  try { startApi(); } catch (err) {
    setPhase('error', { error: String(err.message || err) });
    return;
  }
  if (await waitApi(300000)) setPhase('ready');
  else setPhase('error', { error: 'TTS 服务启动超时，请看日志' });
  if (process.env.GSO_SELFTEST === '1' && phase === 'ready') runSelfTest();
}

// 开发期自动化验收：在渲染进程里填文本、点合成，等结果
async function runSelfTest() {
  await new Promise((r) => setTimeout(r, 1500));
  const shotDir = path.join(app.getPath('temp'), 'gso-selftest');
  fs.mkdirSync(shotDir, { recursive: true });
  try { mainWindow.setSize(Number(process.env.GSO_SHOT_W) || 1280, Number(process.env.GSO_SHOT_H) || 1080); } catch (_) {}

  const snap = async (name) => {
    try {
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(shotDir, name), img.toPNG());
    } catch (_) {}
  };

  if (process.env.GSO_QA === '1') {
    const errors = [];
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) errors.push(String(message).slice(0, 200));
    });
    const js = (code) => mainWindow.webContents.executeJavaScript(code);
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok, detail: String(detail || '').slice(0, 200) });

    try {
      for (let i = 0; i < 90 && phase !== 'ready'; i += 1) await new Promise((r) => setTimeout(r, 2000));
      rec('phase', phase === 'ready', phase);

      const api = await js(`(async () => {
        const r = {};
        try { r.voices = (await window.api.voices()).pairs.length; } catch (e) { r.voicesErr = String(e); }
        try { r.refs = (await window.api.refs()).length; } catch (e) { r.refsErr = String(e); }
        try { r.models = (await window.api.listModels()).length; } catch (e) { r.modelsErr = String(e); }
        try { r.outputs = (await window.api.listOutputs()).length; } catch (e) { r.outputsErr = String(e); }
        try { r.rvc = (await window.api.rvcInfo()).ok; } catch (e) { r.rvcErr = String(e); }
        try {
          const b = await window.api.bookParse({ text: '第一章 开始\\n今天天气不错。我们出发吧。\\n第二章 结束\\n路上很安静。', maxChars: 3000 });
          r.chapters = b.chapters ? b.chapters.length : -1;
          r.bookSentences = b.chapters ? b.chapters.reduce((s, c) => s + c.sentences.length, 0) : -1;
        } catch (e) { r.bookErr = String(e); }
        return r;
      })()`);
      rec('voices', api.voices >= 1, JSON.stringify(api));
      rec('refs', api.refs >= 1, api.refs);
      rec('models', api.models >= 4, api.models);
      rec('outputs', api.outputs >= 0, api.outputs);
      rec('rvc', api.rvc === true, api.rvc);
      rec('bookParse', api.chapters === 2 && api.bookSentences >= 3, 'chapters=' + api.chapters + ' sentences=' + api.bookSentences);

      // 逐个标签页点开，检查是否渲染 + 有没有报错
      const tabs = ['单句', '批量', '音频书', '翻唱', '训练', '设置'];
      for (const t of tabs) {
        const res = await js(`(async () => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          const btn = [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '${t}');
          if (!btn) return { ok: false, reason: 'no-tab' };
          btn.click();
          await wait(700);
          const main = document.querySelector('main');
          return { ok: !!(main && main.innerText.trim().length > 20), len: main ? main.innerText.trim().length : 0 };
        })()`);
        rec('tab:' + t, res.ok, JSON.stringify(res));
        await snap('qa-' + t + '.png');
      }

      // 使用指南 F1
      const guide = await js(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1' }));
        await wait(500);
        const open = !!document.querySelector('.guide');
        const esc = new KeyboardEvent('keydown', { key: 'Escape' });
        window.dispatchEvent(esc);
        await wait(400);
        return { open, closed: !document.querySelector('.guide') };
      })()`);
      rec('guide', guide.open && guide.closed, JSON.stringify(guide));

      // 主题切换
      const theme = await js(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        window.dispatchEvent(new CustomEvent('vs-theme', { detail: 'light' }));
        await wait(300);
        const bg = getComputedStyle(document.body).backgroundColor;
        window.dispatchEvent(new CustomEvent('vs-theme', { detail: 'warm' }));
        await wait(300);
        return bg;
      })()`);
      rec('theme', /^rgb\(24[0-9]|^rgb\(25[0-9]/.test(theme), theme);

      rec('consoleErrors', errors.length === 0, errors.slice(0, 5).join(' | '));
    } catch (err) {
      rec('qa', false, String(err).slice(0, 300));
    }
    if (process.env.GSO_QA_FULL === '1') {
      const refs = await js('window.api.refs()');
      const ref = refs && refs[0] ? refs[0] : null;
      rec('ref:list', !!ref, ref ? ref.name : 'no-ref');

      if (ref) {
        const t0 = Date.now();
        const single = await js(`(async () => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          const tabOne = [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '单句');
          if (tabOne) { tabOne.click(); await wait(800); }
          const ta = document.querySelector('textarea');
          if (!ta) return { ok: false, reason: 'no-textarea' };
          ta.value = '这是一次自动测试。';
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(300);
          const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('合成语音'));
          if (!btn) return { ok: false, reason: 'no-button' };
          if (btn.disabled) return { ok: false, reason: 'disabled' };
          btn.click();
          for (let i = 0; i < 90; i++) {
            await wait(1000);
            const a = document.querySelector('audio');
            if (a && a.src && a.src.indexOf('data:audio') === 0) return { ok: true, size: a.src.length };
          }
          return { ok: false, reason: 'timeout' };
        })()`);
        rec('tts:single', single.ok, JSON.stringify(single) + ' ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');

        const trim = await js(`(async () => {
          try {
            const r = await window.api.trimRef({ src: ${JSON.stringify(ref.path)}, start: 0, end: 4, name: 'qa-trim', save: true });
            return r;
          } catch (e) { return { ok: false, error: String(e) }; }
        })()`);
        rec('ref:trim', trim && trim.ok, JSON.stringify(trim).slice(0, 120));
        if (trim && trim.ok && trim.path) {
          const del = await js(`window.api.deleteRef({ path: ${JSON.stringify(trim.path)} })`);
          rec('ref:delete', del && del.ok !== false, JSON.stringify(del).slice(0, 120));
        }

        const batch = await js(`(async () => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          const tabs = [...document.querySelectorAll('.seg button')];
          const tb = tabs.find(b => b.textContent.trim() === '批量');
          if (!tb) return { ok: false, reason: 'no-tab' };
          tb.click();
          await wait(700);
          const ta = document.querySelector('textarea');
          if (!ta) return { ok: false, reason: 'no-textarea' };
          ta.value = '第一句测试。第二句测试。';
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(300);
          const mk = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('重建队列'));
          if (!mk) return { ok: false, reason: 'no-build' };
          mk.click();
          await wait(700);
          const rows = document.querySelectorAll('.q-row').length;
          if (!rows) return { ok: false, reason: 'queue-empty' };
          const run = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('开始批量合成'));
          if (!run) return { ok: false, reason: 'no-run' };
          if (run.disabled) return { ok: false, reason: 'run-disabled' };
          run.click();
          for (let i = 0; i < 180; i++) {
            await wait(1000);
            const states = [...document.querySelectorAll('.q-state')].map(el => el.textContent.trim());
            const done = states.filter(s => s === '完成').length;
            const failed = states.filter(s => s === '失败').length;
            if (states.length && done + failed === states.length) {
              return { ok: done > 0, done, failed, rows: states.length, sec: i + 1 };
            }
          }
          return { ok: false, reason: 'timeout' };
        })()`);
        rec('batch:run', batch.ok, JSON.stringify(batch));
      }

      const book = await js(`(async () => {
        try {
          const p = await window.api.bookParse({ text: '第一章 测试\\n今天天气不错。我们出发吧。\\n第二章 测试\\n路上很安静。', maxChars: 3000 });
          if (!p.ok) return { ok: false, error: 'parse failed' };
          const voices = (await window.api.voices()).pairs;
          const v = voices[0];
          const refs = await window.api.refs();
          const r = await window.api.bookStart({
            name: 'QA有声书',
            chapters: p.chapters.map(c => ({ index: c.index, title: c.title, chars: c.chars, sentences: c.sentences.slice() })),
            voice: { sovits: v.sovits, gpt: v.gpt, name: v.name },
            ref: { path: refs[0].path, text: refs[0].text || '' },
            params: { speed: 1 },
            gapSec: 0.4
          });
          return { ok: r.ok !== false, dir: r.dir, m4a: !!r.m4a, srt: !!r.srt, failures: (r.failures || []).length, error: r.error || '' };
        } catch (e) { return { ok: false, error: String(e) }; }
      })()`);
      rec('book:start', book.ok, JSON.stringify(book).slice(0, 200));

      const inspect = await js(`(async () => {
        try {
          const r = await window.api.trainInspect({ dir: ${JSON.stringify(path.join(payloadRoot(), 'output'))} });
          return { ok: r.ok !== false, files: r.count, error: r.error || '' };
        } catch (e) { return { ok: false, error: String(e) }; }
      })()`);
      rec('train:inspect', inspect.ok && inspect.files > 0, JSON.stringify(inspect).slice(0, 160));

      const guard = await js(`(async () => {
        try {
          const models = await window.api.listModels();
          const active = models.find(m => m.active);
          if (!active) return { ok: false, reason: 'no-active' };
          const r = await window.api.deleteModel({ path: active.path });
          return { blocked: !r.ok, msg: r.error || '' };
        } catch (e) { return { blocked: false, msg: String(e) }; }
      })()`);
      rec('models:guard', guard.blocked === true, JSON.stringify(guard).slice(0, 160));
    }
    if (process.env.GSO_QA_EXTRA === '1') {
      const resume = await js(`(async () => {
        try {
          const list = await window.api.bookList();
          if (!list.length) return { ok: false, reason: 'no-book' };
          const d = list[0];
          const voices = (await window.api.voices()).pairs;
          const refs = await window.api.refs();
          const r = await window.api.bookResume({ dir: d.dir, voice: voices[0], ref: { path: refs[0].path, text: refs[0].text || '' }, gapSec: 0.4 });
          return { ok: r.ok !== false, m4a: !!r.m4a, srt: !!r.srt, error: r.error || '' };
        } catch (e) { return { ok: false, error: String(e) }; }
      })()`);
      rec('book:resume', resume.ok, JSON.stringify(resume).slice(0, 160));

      const cancel = await js(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const tb = [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '批量');
        if (tb) tb.click();
        await wait(700);
        const ta = document.querySelector('textarea');
        if (!ta) return { ok: false, reason: 'no-textarea' };
        ta.value = '第一句。第二句。第三句。第四句。';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(300);
        const mk = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('重建队列'));
        mk.click();
        await wait(500);
        const run = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('开始批量合成'));
        if (!run || run.disabled) return { ok: false, reason: 'cannot-run' };
        run.click();
        await wait(3500);
        const stop = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '取消');
        if (!stop) return { ok: false, reason: 'no-cancel' };
        stop.click();
        for (let i = 0; i < 60; i++) {
          await wait(500);
          const again = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('开始批量合成'));
          if (again && !again.disabled) {
            const states = [...document.querySelectorAll('.q-state')].map(e => e.textContent.trim());
            return { ok: true, states };
          }
        }
        return { ok: false, reason: 'still-running' };
      })()`);
      rec('batch:cancel', cancel.ok, JSON.stringify(cancel).slice(0, 200));

      const badDir = await js(`window.api.openDir({ path: 'D:\\\\__nope__' })`);
      rec('openDir:bad', badDir && badDir.ok === false, JSON.stringify(badDir));

      const outputs = await js(`(async () => {
        const list = await window.api.listOutputs();
        if (!list.length) return { ok: false, reason: 'no-outputs' };
        return { ok: true, idempotent: list.every(o => typeof o.dur === 'number' && o.sizeMB >= 0) };
      })()`);
      rec('outputs:shape', outputs.ok && outputs.idempotent, JSON.stringify(outputs));
    }
    if (process.env.GSO_QA_TRAIN === '1') {
      const src = path.join(process.env.APPDATA, 'weavevoice', 'refs');
      const dirs = fs.readdirSync(src).filter((f) => /\.wav$/i.test(f)).slice(0, 3);
      const inputDir = path.join(app.getPath('temp'), 'qa-train-src');
      fs.mkdirSync(inputDir, { recursive: true });
      for (const f of dirs) fs.copyFileSync(path.join(src, f), path.join(inputDir, f));
      const steps = [];
      mainWindow.webContents.on('ipc-message', () => {});
      const t0 = Date.now();
      const r = await js(`window.api.trainPrepare({ inputDir: ${JSON.stringify(inputDir)}, expName: 'qa_voice' })`);
      rec('train:prepare', !!(r && r.ok), JSON.stringify(r || {}).slice(0, 200) + ' ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
      const list = await js(`window.api.trainInspect({ dir: ${JSON.stringify(path.join(payloadRoot(), 'output', 'qa_voice_sliced'))} })`);
      rec('train:sliced', !!(list && list.ok && list.count > 0), JSON.stringify(list).slice(0, 120));
    }

    if (process.env.GSO_QA_FIT === '1') {
      const events = [];
      mainWindow.webContents.executeJavaScript('1');
      const t0 = Date.now();
      const p = js(`window.api.trainStart({ expName: 'qa_voice', s2Epochs: 1, s1Epochs: 10, batch: 1 })`);
      // 等 100 秒看它有没有真跑起来，然后取消
      await new Promise((r) => setTimeout(r, Number(process.env.GSO_QA_FIT_WAIT) || 100000));
      const stats = await js(`(async () => {
        try {
          const s = await window.api.state();
          return { phase: s.phase };
        } catch (e) { return { error: String(e) }; }
      })()`);
      const cancel = await js('window.api.trainCancel()');
      const r = await p;
      rec('train:start', !!(r && r.ok), JSON.stringify(r || {}).slice(0, 240) + ' ' + ((Date.now() - t0) / 1000).toFixed(0) + 's phase=' + (stats.phase || stats.error));
    }
    log('QA_RESULT ' + JSON.stringify({ pass: out.filter((x) => x.ok).length, total: out.length, out }));
    await snap('qa-final.png');
    setTimeout(() => app.exit(0), 600);
    return;
  }

  if (process.env.GSO_RVC_TEST === '1') {
    try {
      for (let i = 0; i < 90 && phase !== 'ready'; i += 1) await new Promise((r) => setTimeout(r, 2000));
      const opts = {
        input: process.env.GSO_RVC_INPUT || '',
        model: process.env.GSO_RVC_MODEL || '',
        index: process.env.GSO_RVC_INDEX || '',
        indexRate: 0.75,
        pitch: 0,
        separate: true
      };
      const res = await mainWindow.webContents.executeJavaScript(
        'window.api.rvcConvert(' + JSON.stringify(opts) + ')'
      );
      log('RVC_TEST: ' + JSON.stringify(res));
      await snap('shot-rvc.png');
    } catch (err) { log('RVC_TEST fail: ' + err); }
    setTimeout(() => app.exit(0), 800);
    return;
  }


  if (process.env.GSO_BOOK_TEST === '2') {
    try {
      for (let i = 0; i < 90 && phase !== 'ready'; i += 1) await new Promise((r) => setTimeout(r, 2000));
      const out = await mainWindow.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const tab = [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '音频书');
        if (!tab) return 'NO_TAB';
        tab.click();
        await wait(800);
        const expand = [...document.querySelectorAll('.book .row button')].find(b => b.textContent.trim() === '展开');
        if (!expand) return 'NO_EXPAND';
        expand.click();
        await wait(1200);
        const redo = [...document.querySelectorAll('.book .detail button')].find(b => b.textContent.trim() === '重做');
        if (!redo) return 'NO_REDO';
        redo.click();
        return 'REDO_CLICKED';
      })()`);
      log('BOOK2_TEST: ' + out);
      for (let i = 0; i < 180; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await mainWindow.webContents.executeJavaScript(`(() => {
          const busy = [...document.querySelectorAll('.book .detail button')].some(b => b.textContent.includes('重做中'));
          const alert = document.querySelector('.book .alert');
          return { busy, alert: alert ? alert.textContent : '' };
        })()`);
        if (!st.busy) { log('BOOK2_TEST done, alert=' + st.alert); break; }
      }
      await snap('shot-book2.png');
    } catch (err) { log('BOOK2_TEST fail: ' + err); }
    setTimeout(() => app.exit(0), 800);
    return;
  }

  if (process.env.GSO_BOOK_TEST === '1') {
    try {
      for (let i = 0; i < 90 && phase !== 'ready'; i += 1) await new Promise((r) => setTimeout(r, 2000));
      const bookText = '第一章 开端\n今天天气不错。我们一起出去走走吧。\n第二章 继续\n古之学者必有师。师者，所以传道授业解惑也。';
      const out = await mainWindow.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const tab = [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '音频书');
        if (!tab) return 'NO_TAB';
        tab.click();
        await wait(600);
        const ta = document.querySelector('textarea');
        if (!ta) return 'NO_TEXTAREA';
        ta.value = ${JSON.stringify(bookText)};
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(400);
        const startBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始生成');
        if (!startBtn) return 'NO_START_BTN';
        startBtn.click();
        return 'STARTED';
      })()`);
      log('BOOK_TEST: ' + out);
      for (let i = 0; i < 240; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await mainWindow.webContents.executeJavaScript(`(() => {
          const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始生成');
          const ok = document.querySelector('.book .ok');
          const alert = document.querySelector('.book .alert');
          const pct = (document.querySelector('.book .editor-head .muted') || {}).textContent || '';
          return { idle: !!btn, ok: ok ? ok.textContent : '', alert: alert ? alert.textContent : '', pct };
        })()`);
        if (st.ok) { log('BOOK_TEST ok: ' + st.ok); break; }
        if (st.idle && i > 5) { log('BOOK_TEST idle, alert=' + st.alert + ' pct=' + st.pct); break; }
      }
      await snap('shot-book.png');
    } catch (err) {
      log('BOOK_TEST fail: ' + err);
    }
    setTimeout(() => app.exit(0), 800);
    return;
  }

  if (process.env.GSO_SHOT_MODE || process.env.GSO_SHOT_TRAIN === '1') {
    try {
      const labelMap = { single: '单句', batch: '批量', book: '音频书', profile: '测声', cover: '翻唱', train: '训练', settings: '设置', guide: '设置' };
      const want = labelMap[process.env.GSO_SHOT_MODE || 'train'] || '训练';
      await mainWindow.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const tab = [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '${want}');
        if (tab) tab.click();
        await wait(1200);
        if ('${process.env.GSO_SHOT_MODE || ''}' === 'profile') {
          const go = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('开始分析'));
          if (go && !go.disabled) go.click();
          for (let i = 0; i < 90; i++) { await wait(1000); if (document.querySelector('.range')) break; }
          if ('${process.env.GSO_PROFILE_GO || ''}' === '1') {
            const goBtn = [...document.querySelectorAll('.song-go')].find(b => !b.disabled);
            if (goBtn) { goBtn.click(); await wait(1200); }
          }
        }
        if ('${process.env.GSO_SHOT_MODE || ''}' === 'guide') {
          const gb = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '使用指南');
          if (gb) gb.click();
          await wait(700);
        }
        return 'ok';
      })()`);

      if (process.env.GSO_THEME) {
        const th = String(process.env.GSO_THEME).replace(/[^a-z]/g, '');
        await mainWindow.webContents.executeJavaScript(
          "document.documentElement.dataset.theme = '" + th + "';" +
          "window.dispatchEvent(new CustomEvent('vs-theme', { detail: '" + th + "' }));"
        );
        await new Promise((r) => setTimeout(r, 400));
      }
      const img = await mainWindow.webContents.capturePage();
      const shotName = 'shot-' + (process.env.GSO_SHOT_MODE || 'train') + (process.env.GSO_THEME ? '-' + process.env.GSO_THEME : '') + '.png';
      fs.writeFileSync(path.join(shotDir, shotName), img.toPNG());
      console.log('SELFTEST_SHOT:' + shotName);
    } catch (err) {
      console.log('SELFTEST_SHOT:fail ' + err);
    }
    setTimeout(() => app.exit(0), 500);
    return;
  }
  let n = 0;
  const shotTimer = setInterval(async () => {
    n += 1;
    try {
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(shotDir, 'shot-' + n + '.png'), img.toPNG());
    } catch (_) {}
  }, 5000);
  try {
    const out = await mainWindow.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const ta = document.querySelector('textarea');
      if (!ta) return 'NO_TEXTAREA:' + (document.body.innerText || '').slice(0, 120);
      ta.value = '今天天气不错，我们一起出去走走吧。';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(500);
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('合成语音'));
      if (!btn) return 'NO_BUTTON';
      if (btn.disabled) return 'BUTTON_DISABLED';
      btn.click();
      for (let i = 0; i < 150; i++) {
        await wait(1000);
        const a = document.querySelector('audio');
        if (a && a.src && a.src.indexOf('data:audio') === 0) return 'OK ' + a.src.length;
        const err = document.querySelector('.alert');
        if (err) return 'ERR ' + err.textContent;
      }
      return 'TIMEOUT';
    })()`);
    try { await mainWindow.webContents.executeJavaScript((function(){const m=document.querySelector('.main'); if(m) m.scrollTop=320;})()); } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
    await snap('shot-single.png');
    log('SELFTEST: ' + out);
    console.log('SELFTEST_RESULT:' + out);

    let batchOk = false;
    let batchInfo = 'skipped';
    if (String(out).startsWith('OK')) {
      const out2 = await mainWindow.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const pick = (t) => [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes(t));
        const seg = [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '批量');
        if (!seg) return 'NO_SEG';
        seg.click();
        await wait(400);
        const ta2 = document.querySelector('textarea');
        if (!ta2) return 'NO_TEXTAREA2';
        ta2.value = '今天天气不错，我们一起出去走走吧。古之学者必有师。';
        ta2.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(300);
        const build = pick('按文本重建队列');
        if (!build) return 'NO_BUILD';
        build.click();
        await wait(500);
        const start = pick('开始批量合成');
        if (!start) return 'NO_START';
        start.click();
        for (let i = 0; i < 200; i++) {
          await wait(1000);
          const rows = document.querySelectorAll('.q-row').length;
          const done = document.querySelectorAll('.q-state.done').length;
          const failed = document.querySelectorAll('.q-state.failed').length;
          if (rows && done + failed === rows) break;
        }
        const ex = pick('导出 zip');
        if (ex && !ex.disabled) ex.click();
        return 'rows=' + document.querySelectorAll('.q-row').length + ' done=' + document.querySelectorAll('.q-state.done').length;
      })()`);
      await new Promise((r) => setTimeout(r, 3000));
      const wavs = lastBatchDir && fs.existsSync(lastBatchDir)
        ? fs.readdirSync(lastBatchDir).filter((f) => f.endsWith('.wav')) : [];
      const zip = lastBatchDir ? lastBatchDir.replace(/[\\/]$/, '') + '.zip' : '';
      const zipOk = zip && fs.existsSync(zip);
      batchOk = wavs.length >= 1 && zipOk;
      batchInfo = out2 + ' wav=' + wavs.length + ' zip=' + (zipOk ? fs.statSync(zip).size + 'B' : 'missing');
      console.log('SELFTEST_BATCH:' + batchInfo);
      await snap('shot-batch.png');
    }

    let trimOk = false;
    let trimInfo = 'skipped';
    if (String(out).startsWith('OK')) {
      const out3 = await mainWindow.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const pick = (t) => [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes(t));
        const single = [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '单句');
        if (single) single.click();
        await wait(400);
        const refBtn = [...document.querySelectorAll('.ref')].find(b => /_5\.9s/.test(b.textContent) && !/clip/.test(b.textContent));
        if (refBtn) { refBtn.click(); await wait(900); }
        const cv = document.querySelector('.wave-cv');
        if (!cv) return 'NO_CANVAS';
        const before = document.querySelectorAll('.ref').length;
        const rect = cv.getBoundingClientRect();
        const x1 = rect.left + rect.width * 0.1;
        const x2 = rect.left + rect.width * 0.9;
        cv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: rect.top + 10 }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x2, clientY: rect.top + 10 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: rect.top + 10 }));
        await wait(600);
        const preview = pick('试听选区');
        let seenPreview = false;
        if (preview) preview.click();
        for (let i = 0; i < 30; i++) { await wait(500); if (document.querySelector('.preview-audio')) { seenPreview = true; break; } }
        const saveBtn = pick('保存为新参考');
        if (saveBtn) saveBtn.click();
        for (let i = 0; i < 40; i++) { await wait(500); if (document.querySelectorAll('.ref').length > before) break; }
        const after = document.querySelectorAll('.ref').length;
        return 'refs ' + before + '->' + after + ' preview=' + (seenPreview ? 'yes' : 'no');
      })()`);
      await new Promise((r) => setTimeout(r, 1200));
      const refsFiles = (() => {
        try { return fs.readdirSync(path.join(app.getPath('userData'), 'refs')).filter((f) => f.endsWith('.wav')); } catch (_) { return []; }
      })();
      trimOk = refsFiles.length >= 1 && String(out3).includes('preview=yes');
      await snap('shot-trim.png');
      trimInfo = out3 + ' files=' + refsFiles.length;
      console.log('SELFTEST_TRIM:' + trimInfo);
    }

    let trainOk = false;
    let trainInfo = 'skipped';
    if (process.env.GSO_TRAIN_DIR && String(out).startsWith('OK')) {
      const out4 = await mainWindow.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const pick = (t) => [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes(t));
        const tab = [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '训练');
        if (!tab) return 'NO_TRAIN_TAB';
        tab.click();
        await wait(900);
        const nums = [...document.querySelectorAll('.train input[type=number]')];
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const setVal = (el, v) => { setter.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); };
        if (nums.length >= 3) { setVal(nums[0], 2); setVal(nums[1], 3); setVal(nums[2], 1); }
        await wait(300);
        const prep = pick('开始处理');
        if (!prep) return 'NO_PREPARE';
        if (prep.disabled) return 'PREPARE_DISABLED';
        prep.click();
        let prepared = false;
        for (let i = 0; i < 700; i++) {
          await wait(1000);
          const tb = pick('开始训练');
          if (tb && !tb.disabled) { prepared = true; break; }
          const al = document.querySelector('.alert');
          if (al && /处理失败/.test(al.textContent)) return 'PREP_FAIL ' + al.textContent.slice(0, 80);
        }
        if (!prepared) return 'PREP_TIMEOUT';
        pick('开始训练').click();
        for (let i = 0; i < 900; i++) {
          await wait(1000);
          if (document.querySelector('.train-done')) return 'TRAIN_OK';
          const al = document.querySelector('.alert');
          if (al && /训练失败/.test(al.textContent)) return 'TRAIN_FAIL ' + al.textContent.slice(0, 80);
        }
        return 'TRAIN_TIMEOUT';
      })()`);
      await new Promise((r) => setTimeout(r, 2000));
      const sov = (() => { try { return fs.readdirSync(path.join(payloadRoot(), 'SoVITS_weights_v2Pro')).filter((f) => f.startsWith('selftest_voice')); } catch (_) { return []; } })();
      const gpt = (() => { try { return fs.readdirSync(path.join(payloadRoot(), 'GPT_weights_v2Pro')).filter((f) => f.startsWith('selftest_voice')); } catch (_) { return []; } })();
      trainOk = sov.length > 0 && gpt.length > 0;
      trainInfo = out4 + ' sovits=' + sov.length + ' gpt=' + gpt.length;
      console.log('SELFTEST_TRAIN:' + trainInfo);
    }
    clearInterval(shotTimer);
    try {
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(shotDir, 'shot-final.png'), img.toPNG());
    } catch (_) {}
    const pass = String(out).startsWith('OK') && batchOk && trimOk && (!process.env.GSO_TRAIN_DIR || trainOk);
    setTimeout(() => app.exit(pass ? 0 : 1), 800);
  } catch (err) {
    clearInterval(shotTimer);
    console.log('SELFTEST_RESULT:EXCEPTION ' + err);
    app.exit(1);
  }
}

// ---------- voices / refs ----------

function listVoices() {
  const root = payloadRoot();
  const collect = (prefix, ext) => {
    const map = new Map(); // key -> { rel, mtime }
    if (!fs.existsSync(root)) return map;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const dir = path.join(root, entry.name);
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith(ext)) continue;
        const key = (f.split(/[-_]/)[0] || f).toLowerCase();
        const st = fs.statSync(path.join(dir, f));
        const cur = map.get(key);
        if (!cur || st.mtimeMs > cur.mtime) {
          map.set(key, { rel: path.posix.join(entry.name, f), mtime: st.mtimeMs });
        }
      }
    }
    return map;
  };

  const sovits = collect('SoVITS_weights', '.pth');
  const gpt = collect('GPT_weights', '.ckpt');

  const pairs = [];
  for (const [key, s] of sovits) {
    const g = gpt.get(key);
    pairs.push({
      name: key,
      sovits: s.rel,
      gpt: g ? g.rel : '',
      sovitsFile: path.basename(s.rel),
      gptFile: g ? path.basename(g.rel) : ''
    });
  }
  pairs.sort((a, b) => a.name.localeCompare(b.name));
  return { pairs };
}

function refsDir() {
  return path.join(app.getPath('userData'), 'refs');
}
function refsIndexFile() {
  return path.join(refsDir(), 'index.json');
}
function readRefs() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(refsIndexFile(), 'utf8')); } catch (_) { return []; }
  if (!Array.isArray(list)) return [];
  const alive = list.filter((r) => r && r.path && fs.existsSync(r.path));
  if (alive.length !== list.length) writeRefs(alive); // 清理已删除的文件
  return alive;
}
function writeRefs(list) {
  try {
    fs.mkdirSync(refsDir(), { recursive: true });
    fs.writeFileSync(refsIndexFile(), JSON.stringify(list, null, 2));
  } catch (_) {}
}

// 参考音频去重 + 规范命名（参考01-4.7s.wav）。外部文件先复制进来，不动原文件。
function normalizeRefs(list) {
  const dir = refsDir();
  fs.mkdirSync(dir, { recursive: true });
  const seen = new Set();
  const kept = [];
  for (const r of list) {
    let h = '';
    try { h = require('crypto').createHash('sha1').update(fs.readFileSync(r.path)).digest('hex'); } catch (_) {}
    if (h && seen.has(h)) continue;
    if (h) seen.add(h);
    let cur = r.path;
    if (!path.resolve(cur).toLowerCase().startsWith(path.resolve(dir).toLowerCase())) {
      const copy = path.join(dir, `.import-${Date.now()}-${kept.length}.wav`);
      try { fs.copyFileSync(cur, copy); cur = copy; } catch (_) {}
    }
    kept.push({ path: cur, text: r.text || '' });
  }
  // 两阶段改名，避免互相覆盖
  const tmp = kept.map((r, i) => {
    const t = path.join(dir, `.stage-${i}.wav`);
    try { if (path.resolve(r.path) !== path.resolve(t)) fs.renameSync(r.path, t); } catch (_) { return r.path; }
    return t;
  });
  const out = tmp.map((p, i) => {
    const dur = wavSeconds(p).toFixed(1);
    const name = `参考${String(i + 1).padStart(2, '0')}-${dur}s`;
    const target = path.join(dir, name + '.wav');
    let finalPath = p;
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      fs.renameSync(p, target);
      finalPath = target;
    } catch (_) {}
    return { name: path.basename(finalPath, '.wav'), path: finalPath, text: kept[i].text };
  });
  writeRefs(out);
  return out;
}

function seedRefs() {
  let list = readRefs();
  if (list.length) {
    // 旧版本会生成 参考1_xxx_5.9s_clip_4.7s 这类名字，启动时自动整理一次
    const dirty = list.some((r) => /_clip|参考\d+_/i.test(r.name || ''));
    if (dirty) {
      try { list = normalizeRefs(list); } catch (_) {}
    }
    // 补收目录里存在但索引里没有的 wav（版本升级/迁移后容易丢）
    try {
      const dir = refsDir();
      const known = new Set(list.map((r) => path.basename(r.path).toLowerCase()));
      let added = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!/\.wav$/i.test(f)) continue;
        if (known.has(f.toLowerCase())) continue;
        list.push({ name: f.replace(/\.wav$/i, ''), path: path.join(dir, f), text: '' });
        added += 1;
      }
      if (added) writeRefs(list);
    } catch (_) {}
    return list;
  }
  const seedDir = P('output/参考音频');
  if (!fs.existsSync(seedDir)) return list;
  const texts = {
    '参考1_嗟乎师道_5.9s.wav': '嗟乎，师道之不传也久矣，遇人之无惑也难以。',
    '参考2_师者_5.4s.wav': '师者，所以传道授业解惑也，人非生而知之者。',
    '参考3_是故无贵无贱_6.6s.wav': '是故无贵无贱，无长无少，道之所存，师之所存也。'
  };
  const out = [];
  for (const f of fs.readdirSync(seedDir)) {
    if (!f.toLowerCase().endsWith('.wav')) continue;
    out.push({ name: f.replace(/\.wav$/i, ''), path: path.join(seedDir, f), text: texts[f] || '' });
  }
  if (out.length) writeRefs(out);
  return out;
}

// ---------- tts ----------

function postTts(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: apiPort, path: '/tts', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 180000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode + ': ' + Buffer.concat(chunks).toString('utf8').slice(0, 300)));
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('timeout', () => req.destroy(new Error('合成超时')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------- ipc ----------

ipcMain.handle('state', () => ({
  phase, error: lastError, payload: payloadRoot(), apiPort: apiPort,
  hasModels: payloadReady() ? hasAllModels(payloadRoot()) : false,
  testTrainDir: process.env.GSO_TRAIN_DIR || '',
  version: app.getVersion()
}));
ipcMain.handle('boot', async () => { await boot(); return true; });
ipcMain.handle('voices', () => (payloadReady() ? listVoices() : { pairs: [], sovits: [], gpt: [] }));
ipcMain.handle('refs', () => seedRefs());
ipcMain.handle('open-folder', () => shell.openPath(payloadRoot()));
ipcMain.handle('open-logs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));

ipcMain.handle('open-dir', (_e, { path: p }) => {
  try {
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return { ok: false, error: '目录不存在' };
    shell.openPath(p);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('open-path', (_e, { path: p }) => {
  try {
    const root = path.resolve(payloadRoot(), 'output').toLowerCase();
    const target = path.resolve(String(p || '')).toLowerCase();
    if (!target.startsWith(root)) return { ok: false, error: '只允许打开输出目录内的文件' };
    shell.showItemInFolder(p);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('log-path', () => logPath);
ipcMain.handle('open-output', async () => {
  const dir = path.join(payloadRoot(), 'output');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) { log('打开输出目录失败: ' + err); return { ok: false, error: err }; }
    return { ok: true, path: dir };
  } catch (e) {
    log('打开输出目录异常: ' + e);
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('pick-payload', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择运行时包（payload.7z）', properties: ['openFile'],
    filters: [{ name: '运行时包', extensions: ['7z', '001'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  setPhase('installing');
  try {
    await extractPayload(r.filePaths[0], payloadRoot());
    writeConfig({ payloadArchive: r.filePaths[0] });
    await boot();
    return { ok: true };
  } catch (err) {
    setPhase('error', { error: String(err.message || err) });
    return { ok: false };
  }
});

ipcMain.handle('download-models', async () => {
  try {
    await ensureModels(payloadRoot(), {
      onPhase: (p) => send('phase', p),
      onProgress: (p) => send('download-progress', p),
      onLog: (l) => log(l)
    });
    await boot();
    return { ok: true };
  } catch (err) {
    setPhase('error', { error: String(err.message || err) });
    return { ok: false };
  }
});

// 导入 txt / md 文本（音频书用）
ipcMain.handle('pick-text', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择文本文件', properties: ['openFile'],
    filters: [{ name: '文本', extensions: ['txt', 'md'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  try {
    const raw = fs.readFileSync(r.filePaths[0]);
    let text = raw.toString('utf8');
    if (text.includes('\uFFFD')) text = raw.toString('gbk');
    return { ok: true, name: path.basename(r.filePaths[0]), text };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// 选音频文件（翻唱用）
ipcMain.handle('pick-audio', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择歌曲',
    properties: ['openFile'],
    filters: [
      { name: '音频', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const p = r.filePaths[0];
  let sizeMB = 0;
  try { sizeMB = +(fs.statSync(p).size / 1048576).toFixed(1); } catch (_) {}
  return { ok: true, path: p, name: path.basename(p), sizeMB };
});

ipcMain.handle('import-ref', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择参考音频（3~10 秒）', properties: ['openFile'],
    filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  const src = r.filePaths[0];
  const name = path.basename(src, path.extname(src));
  const dst = path.join(refsDir(), name + path.extname(src));
  fs.mkdirSync(refsDir(), { recursive: true });
  fs.copyFileSync(src, dst);
  const list = readRefs();
  const item = { name, path: dst, text: '' };
  list.unshift(item);
  writeRefs(list);
  return { ok: true, item };
});

ipcMain.handle('update-ref-text', (_e, { path: p, text }) => {
  const list = readRefs().map((r) => (r.path === p ? Object.assign({}, r, { text }) : r));
  writeRefs(list);
  return true;
});

async function setVoice(sovits, gpt) {
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: apiPort, path: p, timeout: 60000 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    }).on('error', reject);
  });
  try {
    if (gpt) {
      const r = await get('/set_gpt_weights?weights_path=' + encodeURIComponent(gpt));
      if (r.code !== 200) throw new Error(r.body.slice(0, 200));
    }
    if (sovits) {
      const r = await get('/set_sovits_weights?weights_path=' + encodeURIComponent(sovits));
      if (r.code !== 200) throw new Error(r.body.slice(0, 200));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

ipcMain.handle('select-voice', async (_e, { sovits, gpt }) => setVoice(sovits, gpt));

ipcMain.handle('tts', async (_e, opts) => {
  const t0 = Date.now();
  try {
    const body = {
      text: opts.text,
      text_lang: opts.textLang || 'zh',
      ref_audio_path: opts.refPath,
      prompt_text: opts.refText || '',
      prompt_lang: opts.promptLang || 'zh',
      top_k: opts.topK ?? 15,
      top_p: opts.topP ?? 1,
      temperature: opts.temperature ?? 1,
      text_split_method: opts.splitMethod || 'cut0',
      batch_size: 1,
      speed_factor: opts.speed ?? 1,
      seed: opts.seed ?? -1,
      media_type: 'wav',
      repetition_penalty: 1.35,
      sample_steps: opts.sampleSteps ?? 8,
      parallel_infer: true,
      use_flash_attention: false
    };
    // 模型对个别句子会吐静音：换 seed → 保守参数 → 按逗号拆句
    const robust = await synthRobust(body, opts.text);
    const buf = robust.buf;
    if (!buf) throw new Error('这段反复合成都没声音，换个说法或再点一次');
    const outDir = path.join(payloadRoot(), 'output');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, outputName(String(opts.text || '')));
    fs.writeFileSync(file, buf);
    return {
      ok: true, base64: buf.toString('base64'), path: file,
      bytes: buf.length, elapsed: ((Date.now() - t0) / 1000).toFixed(1)
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('read-audio', (_e, { path: p }) => {
  try {
    return { ok: true, base64: fs.readFileSync(p).toString('base64') };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('trim-ref', async (_e, { src, start, end, name, save }) => {
  try {
    const ff = path.join(payloadRoot(), 'runtime', 'ffmpeg.exe');
    if (!fs.existsSync(ff)) throw new Error('缺少 ffmpeg');
    const dur = Math.max(0.3, end - start);
    let out;
    if (save) {
      const safe = String(name || 'ref').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      fs.mkdirSync(refsDir(), { recursive: true });
      // 不覆盖已有文件，更不覆盖源文件
      const base = path.join(refsDir(), `${safe}_${dur.toFixed(1)}s`);
      let candidate = `${base}.wav`;
      let n = 2;
      while (fs.existsSync(candidate) || path.resolve(candidate) === path.resolve(String(src || ''))) {
        candidate = `${base}-${n}.wav`;
        n += 1;
        if (n > 99) break;
      }
      out = candidate;
    } else {
      out = path.join(app.getPath('temp'), `gso-preview-${Date.now()}.wav`);
    }
    await new Promise((resolve, reject) => {
      const p = spawn(ff, ['-y', '-v', 'error', '-ss', String(start), '-t', String(dur),
        '-i', src, '-ac', '1', '-ar', '32000', out], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300) || 'ffmpeg 失败'))));
    });
    if (save) {
      const list = readRefs();
      const item = { name: path.basename(out, '.wav'), path: out, text: '' };
      list.unshift(item);
      writeRefs(list);
      return { ok: true, item, base64: fs.readFileSync(out).toString('base64') };
    }
    return { ok: true, base64: fs.readFileSync(out).toString('base64') };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// 输出文件命名：<文本前 12 字>_<MMdd-HHmm>.wav，重名自动加序号
function stampShort(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function outputName(text) {
  const clean = String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .replace(/[，。！？、；：""''（）《》…—]/g, '')
    .slice(0, 12) || '合成';
  const base = `${clean}_${stampShort()}`;
  const dir = path.join(payloadRoot(), 'output');
  let name = base + '.wav';
  let i = 2;
  while (fs.existsSync(path.join(dir, name))) {
    name = `${base}-${i}.wav`;
    i += 1;
  }
  return name;
}

// ---------- 参考音频管理 ----------

function wavSeconds(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(44);
    fs.readSync(fd, head, 0, 44, 0);
    fs.closeSync(fd);
    if (head.toString('ascii', 0, 4) !== 'RIFF') return 0;
    const channels = head.readUInt16LE(22) || 1;
    const rate = head.readUInt32LE(24) || 32000;
    const bits = head.readUInt16LE(34) || 16;
    const dataBytes = Math.max(0, fs.statSync(file).size - 44);
    return dataBytes / (rate * channels * (bits / 8));
  } catch (_) { return 0; }
}

function safeBase(name) {
  return String(name || 'ref')
    .replace(/_clip(?:_.*)?$/i, '')
    .replace(/\.wav$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 40);
}

ipcMain.handle('refs:delete', (_e, { path: p }) => {
  try {
    const list = readRefs().filter((r) => r.path !== p);
    writeRefs(list);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// 去重 + 规范命名：参考01-4.7s.wav / 参考02-5.9s.wav …
ipcMain.handle('refs:tidy', () => {
  try {
    const before = readRefs().length;
    const list = normalizeRefs(readRefs());
    return { ok: true, list, total: before, kept: list.length };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------- 模型 / 生成记录 ----------

ipcMain.handle('models:list', () => {
  const root = payloadRoot();
  const out = [];
  // 每个音色当前在用的那一对（listVoices 取最新 mtime）
  const activeSet = new Set();
  try {
    for (const pair of listVoices().pairs) {
      if (pair.sovits) activeSet.add(pair.sovits.split('/').pop());
      if (pair.gpt) activeSet.add(pair.gpt.split('/').pop());
    }
  } catch (_) {}
  for (const dirName of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (!/^(SoVITS|GPT)_weights/.test(dirName)) continue;
    const dir = path.join(root, dirName);
    let st;
    try { st = fs.statSync(dir); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(pth|ckpt)$/i.test(f)) continue;
      const full = path.join(dir, f);
      const s = fs.statSync(full);
      out.push({
        dir: dirName,
        file: f,
        path: full,
        kind: dirName.startsWith('SoVITS') ? 'sovits' : 'gpt',
        voice: (f.split(/[-_]/)[0] || f).toLowerCase(),
        active: activeSet.has(f),
        sizeMB: +(s.size / 1048576).toFixed(1),
        mtime: s.mtime.toISOString()
      });
    }
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
});

ipcMain.handle('models:delete', (_e, { path: p }) => {
  try {
    if (!/weights/i.test(p)) throw new Error('路径不在权重目录内');
    const active = new Set();
    try {
      for (const pair of listVoices().pairs) {
        if (pair.sovits) active.add(pair.sovits.split('/').pop());
        if (pair.gpt) active.add(pair.gpt.split('/').pop());
      }
    } catch (_) {}
    if (active.has(path.basename(p))) {
      return { ok: false, error: '这是当前音色正在使用的权重，换掉或训练新版本后再删' };
    }
    fs.unlinkSync(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('outputs:list', () => {
  const root = path.join(payloadRoot(), 'output');
  const out = [];
  if (!fs.existsSync(root)) return out;
  const push = (file, group) => {
    try {
      const s = fs.statSync(file);
      out.push({ path: file, name: path.basename(file), group, sizeMB: +(s.size / 1048576).toFixed(2), mtime: s.mtime.toISOString(), dur: +wavSeconds(file).toFixed(2) });
    } catch (_) {}
  };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.wav')) {
      const n = entry.name;
      const group = n.startsWith('翻唱_') ? '翻唱' : n.startsWith('试听_') ? '试听' : n.startsWith('唱_') ? '唱歌' : '单句';
      push(path.join(root, n), group);
    }
    if (entry.isDirectory() && entry.name.startsWith('batch_')) {
      const dir = path.join(root, entry.name);
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.wav')) push(path.join(dir, f), entry.name.replace('batch_', '批量 '));
    }
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
});

ipcMain.handle('outputs:delete', (_e, { path: p }) => {
  try {
    if (!/\\output\\/i.test(p)) throw new Error('路径不在输出目录内');
    fs.unlinkSync(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------- 批量合成 ----------

let batchCancel = false;
let lastBatchDir = '';

function wavDuration(buf) {
  // 32 kHz / 16-bit / mono PCM，头部约 44 字节
  return Math.max(0, (buf.length - 44)) / (32000 * 2);
}

function wavRms(buf) {
  if (buf.length < 1000) return 0;
  let sum = 0;
  let n = 0;
  // 跳过 44 字节头，按 int16 采样统计
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const v = buf.readInt16LE(i) / 32768;
    sum += v * v;
    n += 1;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

// 拼接多段 wav（同格式：32k 单声道 16bit）
function concatWavBuffers(list) {
  const bufs = list.filter((b) => b && b.length > 44);
  if (!bufs.length) return null;
  if (bufs.length === 1) return bufs[0];
  const head = bufs[0];
  const rate = head.readUInt32LE(24);
  const channels = head.readUInt16LE(22);
  const bits = head.readUInt16LE(34);
  const body = Buffer.concat(bufs.map((b) => b.subarray(44)));
  const out = Buffer.alloc(44 + body.length);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + body.length, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * (bits / 8), 28);
  out.writeUInt16LE(channels * (bits / 8), 32);
  out.writeUInt16LE(bits, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(body.length, 40);
  body.copy(out, 44);
  return out;
}

function splitClauses(text) {
  const parts = String(text)
    .replace(/\s+/g, '')
    .split(/(?<=[，,、；;：:])/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 太短的碎片并到前一段，避免合成出半截语气
  const merged = [];
  for (const p of parts) {
    if (merged.length && merged[merged.length - 1].length < 6) merged[merged.length - 1] += p;
    else merged.push(p);
  }
  return merged;
}

/**
 * 稳一点的合成：正常参数 → 保守参数 → 按逗号拆句分别合成再拼
 * 返回 { buf, attempts, split }
 */
async function synthRobust(body, text) {
  const attempts = [];
  const ok = (b) => b && b.length >= 2000 && wavRms(b) >= 0.003;
  for (const seed of [body.seed ?? -1, 666, 2024, 1234]) {
    try {
      const got = await postTts(Object.assign({}, body, { seed }));
      attempts.push(seed);
      if (ok(got)) return { buf: got, attempts, split: 0 };
    } catch (_) { attempts.push(seed); }
  }
  // 保守参数：步数更高、温度更低、重复惩罚更小
  const stable = Object.assign({}, body, {
    top_k: 12, top_p: 0.9, temperature: 0.8,
    repetition_penalty: 1.2, sample_steps: 16
  });
  for (const seed of [777, 4321]) {
    try {
      const got = await postTts(Object.assign({}, stable, { seed }));
      attempts.push(seed);
      if (ok(got)) return { buf: got, attempts, split: 0 };
    } catch (_) { attempts.push(seed); }
  }
  // 拆句兜底
  const clauses = splitClauses(text);
  if (clauses.length > 1) {
    const parts = [];
    for (const clause of clauses) {
      let got = null;
      for (const seed of [-1, 666, 2024]) {
        try {
          const b = await postTts(Object.assign({}, body, { text: clause, seed }));
          attempts.push(seed);
          if (ok(b)) { got = b; break; }
        } catch (_) { attempts.push(seed); }
      }
      if (got) parts.push(got);
    }
    const merged = concatWavBuffers(parts);
    if (ok(merged)) return { buf: merged, attempts, split: clauses.length };
  }
  return { buf: null, attempts, split: 0 };
}

async function synthOne(opts) {
  const body = {
    text: opts.text,
    text_lang: 'zh',
    ref_audio_path: opts.refPath,
    prompt_text: opts.refText || '',
    prompt_lang: 'zh',
    top_k: opts.topK ?? 15,
    top_p: opts.topP ?? 1,
    temperature: opts.temperature ?? 1,
    text_split_method: 'cut0',
    batch_size: 1,
    speed_factor: opts.speed ?? 1,
    seed: opts.seed ?? -1,
    media_type: 'wav',
    repetition_penalty: 1.35,
    sample_steps: opts.sampleSteps ?? 8,
    parallel_infer: true,
    use_flash_attention: false
  };
  return postTts(body);
}

ipcMain.handle('batch-cancel', () => { batchCancel = true; return true; });

ipcMain.handle('batch-run', async (_e, opts) => {
  batchCancel = false;
  const items = opts.items || [];
  const dir = path.join(payloadRoot(), 'output', 'batch_' + stampShort());
  fs.mkdirSync(dir, { recursive: true });
  const results = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const idx = item.index != null ? item.index : i;
    if (batchCancel) {
      send('batch:item', { index: idx, status: 'canceled' });
      break;
    }
    send('batch:item', { index: idx, status: 'running' });
    const t0 = Date.now();
    let ok = false;
    let lastErr = '';
    // 单句失败：换 seed → 保守参数 → 拆句（与单句合成同一套兜底）
    const baseBody = {
      text: item.text,
      text_lang: 'zh',
      ref_audio_path: opts.refPath,
      prompt_text: opts.refText || '',
      prompt_lang: 'zh',
      top_k: opts.topK ?? 15,
      top_p: opts.topP ?? 1,
      temperature: opts.temperature ?? 1,
      text_split_method: 'cut0',
      batch_size: 1,
      speed_factor: opts.speed ?? 1,
      seed: -1,
      media_type: 'wav',
      repetition_penalty: 1.35,
      sample_steps: opts.sampleSteps ?? 8,
      parallel_infer: true,
      use_flash_attention: false
    };
    const robust = await synthRobust(baseBody, item.text);
    const buf = robust.buf;
    if (buf) {
      const label = String(item.text || '')
        .replace(/[\s\u3000]+/g, '')
        .replace(/[\\/:*?"<>|\r\n\t，。！？、；：""''（）《》…—]/g, '')
        .slice(0, 12) || 'audio';
      const file = path.join(dir, String(idx + 1).padStart(3, '0') + '_' + label + '.wav');
      fs.writeFileSync(file, buf);
      const rec = { index: idx, ok: true, path: file, bytes: buf.length, dur: wavDuration(buf), elapsed: ((Date.now() - t0) / 1000).toFixed(1) };
      results.push(rec);
      send('batch:item', Object.assign({ status: 'done' }, rec));
      ok = true;
    } else {
      lastErr = '反复合成都没声音（可换个说法）';
    }
    if (!ok) {
      results.push({ index: i, ok: false, error: lastErr });
      send('batch:item', { index: i, status: 'failed', error: lastErr });
    }
  }

  lastBatchDir = dir;
  const allOk = results.filter((r) => r.ok).length;
  send('batch:done', { dir, ok: allOk, total: items.length });
  return { ok: true, dir, results };
});

ipcMain.handle('batch-export', async (_e, { dir }) => {
  try {
    const z = sevenZip();
    const zipPath = dir.replace(/[\\/]$/, '') + '.zip';
    await new Promise((resolve, reject) => {
      const p = spawn(z, ['a', '-tzip', '-r', zipPath, '*'], { cwd: dir, windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-200)))));
    });
    shell.showItemInFolder(zipPath);
    return { ok: true, path: zipPath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------- 训练流水线 ----------

let trainProc = null;
let trainCanceled = false;

function asciiJson(obj) {
  // 训练脚本用默认编码读配置（cp936），非 ASCII 必须转义
  return JSON.stringify(obj).replace(/[^\x20-\x7E]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function yamlStr(s) {
  const esc = String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/[^\x20-\x7E]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return '"' + esc + '"';
}

function runPy(args, env, onLine, opts) {
  return new Promise((resolve) => {
    const root = payloadRoot();
    const rt = pythonRuntime(root);
    const py = rt.exe;
    const e = Object.assign({}, process.env, {
      PATH: path.join(root, 'runtime') + ';' + process.env.PATH,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      NLTK_DATA: path.join(root, 'runtime', 'nltk_data'),
      OPEN_JTALK_DICT_DIR: path.join(process.env.LOCALAPPDATA || root, 'GPT-SoVITS', 'open_jtalk_dic_utf_8-1.11')
    }, env || {});
    // 工具脚本要能 import tools.* / text.*：把 payload 根和目标脚本目录都放进 PYTHONPATH
    const extra = opts && opts.pyPath ? ';' + opts.pyPath : '';
    e.PYTHONPATH = rt.useBase ? (root + ';' + rt.site + extra) : (root + extra);
    const cwd = (opts && opts.cwd) || root;
    const p = spawn(py, args, { cwd, env: e, windowsHide: true });
    trainProc = p;
    let out = '';
    const handle = (d) => {
      const text = String(d);
      out += text;
      if (out.length > 20000) out = out.slice(-12000);
      text.split(/\r?\n/).filter(Boolean).slice(-4).forEach((l) => onLine && onLine(l));
    };
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', handle);
    p.stderr.on('data', handle);
    p.on('error', (err) => { trainProc = null; resolve({ code: -1, out: String(err) }); });
    p.on('exit', (code) => { trainProc = null; resolve({ code, out }); });
  });
}

ipcMain.handle('train:cancel', () => {
  trainCanceled = true;
  if (trainProc && trainProc.exitCode === null) {
    try { spawn('taskkill', ['/PID', String(trainProc.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
  }
  return true;
});

ipcMain.handle('train:list-audio', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择训练素材（文件夹里放 wav/mp3/flac）',
    properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  const dir = r.filePaths[0];
  const exts = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg']);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => exts.has(path.extname(f).toLowerCase()));
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  return { ok: true, dir, count: files.length, files: files.slice(0, 50) };
});

ipcMain.handle('train:inspect', (_e, { dir }) => {
  try {
    const exts = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg']);
    const files = fs.readdirSync(dir).filter((f) => exts.has(path.extname(f).toLowerCase()));
    return { ok: true, dir, count: files.length };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('train:prepare', async (_e, opts) => {
  trainCanceled = false;
  const root = payloadRoot();
  const expName = String(opts.expName || 'myvoice').trim().replace(/[\\/:*?"<>|\s]/g, '_') || 'myvoice';
  const slicedDir = path.join(root, 'output', expName + '_sliced');
  const asrDir = path.join(root, 'output', expName + '_asr');
  const optDir = path.join(root, 'logs', expName);
  const bert = 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large';
  const cnhubert = 'GPT_SoVITS/pretrained_models/chinese-hubert-base';
  const s2g = 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth';
  const sv = 'GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt';

  const step = (p) => send('train:step', p);
  const line = (l) => send('train:log', l);

  fs.mkdirSync(slicedDir, { recursive: true });
  fs.mkdirSync(asrDir, { recursive: true });
  fs.mkdirSync(optDir, { recursive: true });

  // 1. 切片
  step({ step: 'slice', status: 'running' });
  let r = await runPy(['tools/slice_audio.py', opts.inputDir, slicedDir, '-34', '4000', '300', '10', '500', '0.9', '0.25', '0', '1'], {}, line);
  if (r.code !== 0 || trainCanceled) { step({ step: 'slice', status: 'failed' }); return { ok: false, error: '切片失败' }; }
  const slices = fs.readdirSync(slicedDir).filter((f) => f.endsWith('.wav'));
  if (!slices.length) { step({ step: 'slice', status: 'failed' }); return { ok: false, error: '没有切出音频片段' }; }
  step({ step: 'slice', status: 'done', detail: slices.length + ' 段' });

  // 2. ASR 打标
  step({ step: 'asr', status: 'running' });
  r = await runPy(['tools/asr/funasr_asr.py', '-i', slicedDir, '-o', asrDir, '-s', 'large', '-l', 'zh'], { CUDA_VISIBLE_DEVICES: '-1' }, line);
  if (r.code !== 0 || trainCanceled) { step({ step: 'asr', status: 'failed' }); return { ok: false, error: '语音识别失败：' + r.out.slice(-300) }; }
  const listFile = fs.readdirSync(asrDir).filter((f) => f.endsWith('.list'))[0];
  if (!listFile) { step({ step: 'asr', status: 'failed' }); return { ok: false, error: '没有生成标注文件' }; }
  const listPath = path.join(asrDir, listFile);
  const listLines = fs.readFileSync(listPath, 'utf8').split('\n').filter(Boolean).length;
  step({ step: 'asr', status: 'done', detail: listLines + ' 条' });

  // 3. 特征提取（1A）
  const env = {
    inp_text: listPath,
    inp_wav_dir: slicedDir,
    exp_name: expName,
    opt_dir: optDir,
    i_part: '0',
    all_parts: '1',
    _CUDA_VISIBLE_DEVICES: '0',
    is_half: 'True',
    version: 'v2Pro',
    bert_pretrained_dir: path.join(root, bert),
    cnhubert_base_dir: path.join(root, cnhubert),
    sv_path: path.join(root, sv),
    pretrained_s2G: path.join(root, s2g),
    s2config_path: path.join(root, 'GPT_SoVITS/configs/s2v2Pro.json')
  };
  const steps = [
    ['text', 'GPT_SoVITS/prepare_datasets/1-get-text.py'],
    ['hubert', 'GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py'],
    ['sv', 'GPT_SoVITS/prepare_datasets/2-get-sv.py'],
    ['semantic', 'GPT_SoVITS/prepare_datasets/3-get-semantic.py']
  ];
  for (const [name, script] of steps) {
    if (trainCanceled) return { ok: false, error: '已取消' };
    step({ step: name, status: 'running' });
    const rel = script.replace(/^GPT_SoVITS[\\\\/]/, '');
    // 脚本里的相对路径（G2PWModel、pretrained_models）都以 payload 根为基准
    r = await runPy([script], env, line, {
      cwd: root,
      pyPath: path.join(root, 'GPT_SoVITS') + ';' + path.join(root, 'GPT_SoVITS', 'eres2net')
    });
    if (r.code !== 0) {
      step({ step: name, status: 'failed' });
      return { ok: false, error: name + ' 步骤失败：' + String(r.out || '').slice(-400) };
    }
    step({ step: name, status: 'done' });
  }

  // 合并分片输出
  try {
    const textPart = path.join(optDir, '2-name2text-0.txt');
    if (fs.existsSync(textPart)) {
      const merged = fs.readFileSync(textPart, 'utf8').split('\n').filter(Boolean).join('\n') + '\n';
      fs.writeFileSync(path.join(optDir, '2-name2text.txt'), merged);
      fs.unlinkSync(textPart);
    }
    const semPart = path.join(optDir, '6-name2semantic-0.tsv');
    if (fs.existsSync(semPart)) {
      const merged = fs.readFileSync(semPart, 'utf8').split('\n').filter(Boolean).join('\n') + '\n';
      fs.writeFileSync(path.join(optDir, '6-name2semantic.tsv'), merged);
      fs.unlinkSync(semPart);
    }
  } catch (err) {
    return { ok: false, error: '合并特征失败: ' + err.message };
  }

  const totalSec = slices.reduce((s, f) => {
    try { return s + (fs.statSync(path.join(slicedDir, f)).size / (32000 * 2)); } catch (_) { return s; }
  }, 0);
  writeConfig({ lastTrainExp: expName });
  return { ok: true, expName, optDir, slicedDir, listPath, slices: slices.length, seconds: Math.round(totalSec) };
});

ipcMain.handle('train:start', async (_e, opts) => {
  trainCanceled = false;
  const root = payloadRoot();
  const expName = String(opts.expName || 'myvoice').trim();
  const optDir = path.join(root, 'logs', expName);
  const s2Epochs = Number(opts.s2Epochs || 8);
  const s1Epochs = Number(opts.s1Epochs || 30);
  const batch = Number(opts.batch || 2);
  const step = (p) => send('train:step', p);
  const line = (l) => send('train:log', l);

  if (!fs.existsSync(path.join(optDir, '6-name2semantic.tsv'))) {
    return { ok: false, error: '还没有处理好的数据集，请先点「开始处理」' };
  }

  // 6GB 显存：训练前先把推理服务停掉，否则必 OOM
  const wasOnline = await apiOnline();
  if (wasOnline) {
    send('train:log', '暂停推理服务，释放显存用于训练…');
    killApi();
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await apiOnline())) break;
    }
  }
  const restoreApi = async () => {
    if (!wasOnline) return;
    send('train:log', '训练结束，重新启动推理服务…');
    try { startApi(); } catch (_) {}
    await waitApi(300000);
    setPhase('ready');
  };
  fs.mkdirSync(path.join(optDir, 'logs_s2_v2Pro'), { recursive: true });
  fs.mkdirSync(path.join(optDir, 'logs_s1_v2Pro'), { recursive: true });
  // 避免 lightning 尝试从旧 ckpt 续训
  const oldS1 = path.join(optDir, 'logs_s1_v2Pro');
  for (const f of fs.readdirSync(oldS1)) {
    if (f.endsWith('.ckpt')) { try { fs.unlinkSync(path.join(oldS1, f)); } catch (_) {} }
  }

  // SoVITS
  const s2CfgPath = path.join(root, 'GPT_SoVITS', 'configs', 's2v2Pro.json');
  const s2 = JSON.parse(fs.readFileSync(s2CfgPath, 'utf8'));
  Object.assign(s2.train, {
    batch_size: batch,
    epochs: s2Epochs,
    text_low_lr_rate: 0.4,
    pretrained_s2G: 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth',
    pretrained_s2D: 'GPT_SoVITS/pretrained_models/v2Pro/s2Dv2Pro.pth',
    if_save_latest: true,
    if_save_every_weights: true,
    save_every_epoch: Math.max(1, Math.floor(s2Epochs / 2)),
    gpu_numbers: '0',
    grad_ckpt: true,
    lora_rank: 32
  });
  s2.model.version = 'v2Pro';
  s2.data.exp_dir = s2.s2_ckpt_dir = optDir;
  s2.save_weight_dir = 'SoVITS_weights_v2Pro';
  s2.name = expName;
  s2.version = 'v2Pro';
  const tmpS2 = path.join(root, '.tmp_s2.json');
  fs.writeFileSync(tmpS2, asciiJson(s2), 'utf8');

  step({ step: 'sovits', status: 'running', total: s2Epochs });
  let lastEpoch = 0;
  let r = await runPy(['GPT_SoVITS/s2_train.py', '--config', tmpS2], {}, (l) => {
    line(l);
    const m = l.match(/Epoch[:\s]+(\d+)/i);
    if (m) {
      const ep = Number(m[1]);
      if (ep !== lastEpoch) { lastEpoch = ep; send('train:epoch', { stage: 'sovits', epoch: ep, total: s2Epochs }); }
    }
  });
  const sovitsOut = (() => {
    try { return fs.readdirSync(path.join(root, 'SoVITS_weights_v2Pro')).filter((f) => f.startsWith(expName + '_e')); } catch (_) { return []; }
  })();
  if (trainCanceled) {
    step({ step: 'sovits', status: 'failed' });
    await restoreApi();
    return { ok: false, error: '已取消' };
  }
  if (r.code !== 0 && !sovitsOut.length) {
    step({ step: 'sovits', status: 'failed' });
    await restoreApi();
    return { ok: false, error: 'SoVITS 训练失败：' + r.out.slice(-300) };
  }
  step({ step: 'sovits', status: 'done', detail: sovitsOut[sovitsOut.length - 1] || '' });

  // GPT
  const s1Yaml = [
    'train:',
    '  seed: 1234',
    '  epochs: ' + s1Epochs,
    '  batch_size: ' + batch,
    '  save_every_n_epoch: ' + Math.max(1, Math.floor(s1Epochs / 3)),
    '  precision: 16-mixed',
    '  gradient_clip: 1.0',
    '  if_save_every_weights: true',
    '  if_save_latest: true',
    '  if_dpo: false',
    '  half_weights_save_dir: ' + yamlStr('GPT_weights_v2Pro'),
    '  exp_name: ' + yamlStr(expName),
    'optimizer:',
    '  lr: 0.01',
    '  lr_init: 0.00001',
    '  lr_end: 0.0001',
    '  warmup_steps: 2000',
    '  decay_steps: 40000',
    'data:',
    '  max_eval_sample: 8',
    '  max_sec: 54',
    '  num_workers: 4',
    '  pad_val: 1024',
    'model:',
    '  vocab_size: 1025',
    '  phoneme_vocab_size: 732',
    '  embedding_dim: 512',
    '  hidden_dim: 512',
    '  head: 16',
    '  linear_units: 2048',
    '  n_layer: 24',
    '  dropout: 0',
    '  EOS: 1024',
    '  random_bert: 0',
    'inference:',
    '  top_k: 15',
    'pretrained_s1: ' + yamlStr('GPT_SoVITS/pretrained_models/s1v3.ckpt'),
    'train_semantic_path: ' + yamlStr(path.join(optDir, '6-name2semantic.tsv')),
    'train_phoneme_path: ' + yamlStr(path.join(optDir, '2-name2text.txt')),
    'output_dir: ' + yamlStr(path.join(optDir, 'logs_s1_v2Pro')),
    ''
  ].join('\n');
  const tmpS1 = path.join(root, '.tmp_s1.yaml');
  fs.writeFileSync(tmpS1, s1Yaml, 'utf8');

  step({ step: 'gpt', status: 'running', total: s1Epochs });
  lastEpoch = 0;
  r = await runPy(['GPT_SoVITS/s1_train.py', '--config_file', tmpS1], { hz: '25hz', _CUDA_VISIBLE_DEVICES: '0' }, (l) => {
    line(l);
    const m = l.match(/Epoch[:\s]+(\d+)/i) || l.match(/epoch[_\s]*(\d+)/i);
    if (m) {
      const ep = Number(m[1]);
      if (ep !== lastEpoch && ep <= s1Epochs) {
        lastEpoch = ep;
        send('train:epoch', { stage: 'gpt', epoch: ep, total: s1Epochs });
      }
    }
  });
  const gptOut = (() => {
    try { return fs.readdirSync(path.join(root, 'GPT_weights_v2Pro')).filter((f) => f.startsWith(expName + '-e')); } catch (_) { return []; }
  })();
  if (trainCanceled || (r.code !== 0 && !gptOut.length)) {
    step({ step: 'gpt', status: 'failed' });
    await restoreApi();
    return { ok: false, error: 'GPT 训练失败：' + r.out.slice(-300) };
  }
  step({ step: 'gpt', status: 'done', detail: gptOut[gptOut.length - 1] || '' });

  await restoreApi();
  return { ok: true, expName, sovits: listVoices().pairs.find((p) => p.name === expName) || null };
});

// ---------- 自动更新 ----------

function sendUpdater() {
  send('updater', updaterState);
}

function initUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => { updaterState = { status: 'checking', percent: 0 }; sendUpdater(); });
  autoUpdater.on('update-available', (info) => {
    updaterState = { status: 'available', percent: 0, version: info.version };
    sendUpdater();
  });
  autoUpdater.on('update-not-available', () => { updaterState = { status: 'latest', percent: 0 }; sendUpdater(); });
  autoUpdater.on('download-progress', (p) => {
    updaterState = { status: 'downloading', percent: Math.round(p.percent) };
    sendUpdater();
  });
  autoUpdater.on('update-downloaded', (info) => {
    updaterState = { status: 'downloaded', percent: 100, version: info.version };
    sendUpdater();
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['立刻重启更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: '织声 ' + info.version + ' 已下载完成，重启即可生效。'
      }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
    }
  });
  autoUpdater.on('error', (err) => {
    updaterState = { status: 'error', percent: 0, error: String(err.message || err) };
    sendUpdater();
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      updaterState = { status: 'error', percent: 0, error: String(err.message || err) };
      sendUpdater();
    });
  }, 8000);
}

ipcMain.handle('updater:state', () => updaterState);
ipcMain.handle('updater:check', async () => {
  if (!autoUpdater || !app.isPackaged) return { ok: false, error: '开发环境不支持自动更新' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
ipcMain.handle('updater:install', () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
  return true;
});

// ---------- window ----------

// ---------- 音频书 ----------
const book = require('./book')({ app, payloadRoot, log, send, synthOne, setVoice, synthRobust });
book.register(ipcMain);

// ---------- 翻唱（RVC） ----------
let rvcProc = null;

function rvcCandidates() {
  const list = [];
  if (process.env.RVC_ROOT) list.push(process.env.RVC_ROOT);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    if (cfg.rvcRoot) list.push(cfg.rvcRoot);
  } catch (_) {}
  list.push(path.join(path.dirname(app.getPath('exe')), 'rvc'));
  list.push('E:\\01-项目开发\\RVC');
  return list;
}

function rvcRoot() {
  for (const p of rvcCandidates()) {
    if (!p) continue;
    if (fs.existsSync(path.join(p, '.venv', 'Scripts', 'python.exe'))) return p;
  }
  return '';
}

ipcMain.handle('rvc:info', () => {
  const root = rvcRoot();
  if (!root) return { ok: false, error: '没有找到 RVC 安装（需要包含 .venv 的目录）' };
  const models = [];
  const wdir = path.join(root, 'assets', 'weights');
  if (fs.existsSync(wdir)) {
    for (const f of fs.readdirSync(wdir)) {
      if (!f.endsWith('.pth')) continue;
      const full = path.join(wdir, f);
      const st = fs.statSync(full);
      models.push({ name: f, path: full, sizeMB: +(st.size / 1048576).toFixed(1), mtime: st.mtimeMs });
    }
  }
  const idx = [];
  const idir = path.join(root, 'assets', 'indices');
  if (fs.existsSync(idir)) {
    for (const f of fs.readdirSync(idir)) {
      if (f.endsWith('.index')) idx.push({ name: f, path: path.join(idir, f) });
    }
  }
  models.sort((a, b) => b.mtime - a.mtime); // 最新的模型排最前
  return { ok: true, root, models, indices: idx };
});

function runProc(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, Object.assign({ windowsHide: true }, opts || {}));
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; if (opts && opts.onLine) String(d).split(/\r?\n/).filter(Boolean).forEach(opts.onLine); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

// faiss 的 C 层打不开含中文的路径，索引统一复制到纯 ASCII 的临时目录
function asciiIndexPath(indexPath) {
  const dir = path.join(app.getPath('temp'), 'weavevoice-rvc');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, 'index.idx');
  try {
    if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(indexPath).size) {
      fs.copyFileSync(indexPath, dst);
    }
    return dst;
  } catch (_) {
    return '';
  }
}

ipcMain.handle('rvc:cancel', () => {
  if (rvcProc) {
    try { spawn('taskkill', ['/PID', String(rvcProc.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
    rvcProc = null;
  }
  return { ok: true };
});

// ---------- 测声：音域与音色分析 ----------
ipcMain.handle('profile:analyze', async (_e, opts) => {
  const input = String((opts && opts.path) || '');
  if (!input || !fs.existsSync(input)) return { ok: false, error: '文件不存在' };
  const payload = payloadRoot();
  const py = pythonRuntime(payload);
  const ff = path.join(payload, 'runtime', 'ffmpeg.exe');
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'py', 'voice_profile.py')
    : path.join(__dirname, 'py', 'voice_profile.py');
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
  if (py.useBase) env.PYTHONPATH = py.site;
  let work = '';
  let target = input;
  try {
    if (opts && opts.separate) {
      work = path.join(app.getPath('temp'), 'gso-profile-' + Date.now());
      fs.mkdirSync(work, { recursive: true });
      const sepScript = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'py', 'uvr_separate.py')
        : path.join(__dirname, 'py', 'uvr_separate.py');
      const r = await runProc(py.exe, ['-u', sepScript, '--input', input, '--outdir', work,
        '--payload', payload, '--ffmpeg', ff, '--model', 'HP2_all_vocals', '--device', 'cpu'], { env });
      let done = null;
      for (const line of r.out.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const o = JSON.parse(line);
          if (o.type === 'done') done = o;
        } catch (_) {}
      }
      if (!done) return { ok: false, error: '人声分离失败：' + String(r.err || '').slice(-200) };
      target = done.vocal;
    }
    const r = await runProc(py.exe, ['-u', scriptPath, target], { env });
    let profile = null;
    for (const line of r.out.split(/\r?\n/)) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        const o = JSON.parse(s);
        if (o && typeof o.ok === 'boolean') profile = o;
      } catch (_) {}
    }
    if (!profile) return { ok: false, error: '分析失败：' + String(r.err || r.out || '').slice(-200) };
    if (!profile.ok) return { ok: false, error: profile.error || '分析失败' };
    return { ok: true, profile };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    if (work) { try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} }
  }
});
ipcMain.handle('rvc:convert', async (_e, opts) => {
  if (rvcProc) return { ok: false, error: '正在处理中，请先停止' };
  const root = rvcRoot();
  if (!root) return { ok: false, error: '没有找到 RVC 安装' };
  const input = String(opts.input || '');
  if (!fs.existsSync(input)) return { ok: false, error: '输入文件不存在' };

  const payload = payloadRoot();
  const py = pythonRuntime(payload);
  const rvcPy = path.join(root, '.venv', 'Scripts', 'python.exe');
  const ff = path.join(payload, 'runtime', 'ffmpeg.exe');
  const outDir = path.join(payload, 'output');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const work = path.join(outDir, `rvc_${stamp}`);
  fs.mkdirSync(work, { recursive: true });
  const baseName = path.basename(input).replace(/\.[^.]+$/, '').slice(0, 30);

  const send2 = (stage, extra) => send('rvc:progress', Object.assign({ stage }, extra || {}));

  try {
    let vocal = input;
    let inst = '';
    if (opts.separate !== false) {
      send2('separating');
      const sepStart = Date.now();
      log('翻唱：开始分离 ' + path.basename(input));
      const sepScript = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'py', 'uvr_separate.py')
        : path.join(__dirname, 'py', 'uvr_separate.py');
      const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' });
      if (py.useBase) env.PYTHONPATH = py.site;
      const r = await runProc(py.exe, ['-u', sepScript, '--input', input, '--outdir', work,
        '--payload', payload, '--ffmpeg', ff, '--model', opts.sepModel || 'HP2_all_vocals', '--device', 'cpu'], { env });
      let done = null;
      for (const line of r.out.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const o = JSON.parse(line);
          if (o.type === 'done') done = o;
          if (o.type === 'error') throw new Error(o.message);
        } catch (_) {}
      }
      if (!done) throw new Error('人声分离失败: ' + (r.err || '').slice(-200));
      log('翻唱：分离完成 ' + Math.round((Date.now() - sepStart) / 1000) + 's code=' + r.code);
      vocal = done.vocal;
      inst = done.inst;
    }

    send2('loading-model');
    // 释放显存：暂停 TTS 服务
    try { killApi(); } catch (_) {}
    await new Promise((res) => setTimeout(res, 2500));

    const conv = path.join(work, 'converted_vocal.wav');
    const idxArg = [];
    if (opts.index) {
      const ap = asciiIndexPath(opts.index);
      if (ap) idxArg.push('--index', ap, '--index-rate', String(Number(opts.indexRate) || 0.75));
    } else {
      idxArg.push('--index-rate', '0');
    }
    const env2 = Object.assign({}, process.env, {
      PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
      RVC_CUDA_GRAPH: '0',
      PYTHONPATH: root + ';' + path.join(payload, 'runtime', 'Lib', 'site-packages')
    });
    send2('converting');
    log('翻唱：开始转换 ' + path.basename(vocal));
    const proc = spawn(rvcPy, ['-u', '-m', 'infer.cli', '--model', String(opts.model),
      '--input', vocal, '--output', conv, '--f0-method', 'rmvpe',
      '--pitch', String(Number(opts.pitch) || 0), '--format', 'wav', '--overwrite'].concat(idxArg),
      { cwd: root, env: env2, windowsHide: true });
    rvcProc = proc;
    const res = await new Promise((resolve) => {
      let err = '';
      proc.stderr.on('data', (d) => { err += d; });
      proc.on('close', (code) => resolve({ code, err }));
    });
    rvcProc = null;
    log('翻唱：转换结束 code=' + res.code + ' 文件=' + (fs.existsSync(conv) ? '有' : '无'));
    if (res.code !== 0 || !fs.existsSync(conv)) throw new Error('转换失败: ' + (res.err || '').slice(-300));

    send2('mixing');
    let outFile = conv;
    if (inst) {
      outFile = path.join(outDir, `翻唱_${baseName}_${stamp}.wav`);
      const filt = '[0:a]volume=1.0[v];[1:a]volume=0.85[i];[v][i]amix=inputs=2:duration=shortest:dropout_transition=2,loudnorm=I=-16:TP=-1.5:LRA=11';
      const m = await runProc(ff, ['-y', '-v', 'error', '-i', conv, '-i', inst, '-filter_complex', filt, '-ar', '44100', '-ac', '2', outFile], {});
      if (m.code !== 0) throw new Error('混音失败');
    } else {
      outFile = path.join(outDir, `翻唱_${baseName}_${stamp}_干声.wav`);
      fs.copyFileSync(conv, outFile);
    }

    // 打分：源人声 vs 转换人声，告诉用户这首歌和音色搭不搭
    send2('scoring');
    let score = null;
    try {
      const scoreScript = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'py', 'rvc_score.py')
        : path.join(__dirname, 'py', 'rvc_score.py');
      const envS = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
      if (py.useBase) envS.PYTHONPATH = py.site;
      const sr = await runProc(py.exe, ['-u', scoreScript, vocal, conv], { env: envS });
      for (const line of sr.out.split(/\r?\n/)) {
        const s = line.trim();
        if (!s.startsWith('{')) continue;
        try { const o = JSON.parse(s); if (o.ok) score = o; } catch (_) {}
      }
    } catch (_) {}

    try { await boot(); } catch (_) {}
    send2('done', { path: outFile, score });
    return { ok: true, path: outFile, dir: work, vocal, inst, score };
  } catch (err) {
    try { await boot(); } catch (_) {}
    log('翻唱失败：' + String(err.message || err));
    return { ok: false, error: String(err.message || err) };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 1080, minHeight: 700,
    backgroundColor: '#14171c', show: false, autoHideMenuBar: true,
    title: '织声',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else if (process.env.GSO_SHOT_MODE) {
    const shotHash = 'mode=' + (process.env.GSO_SHOT_MODE === 'guide' ? 'settings' : process.env.GSO_SHOT_MODE) + (process.env.GSO_PROFILE_CLIP ? '&clip=' + encodeURIComponent(process.env.GSO_PROFILE_CLIP) : '');
mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: shotHash });
  } else if (process.env.GSO_SHOT_TRAIN === '1') {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'mode=train' });
  } else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('console-message', (_e, level, msg) => {
    if (process.env.GSO_SELFTEST === '1') console.log('[renderer]', msg);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    initLogFile();
    logLine('app start ' + app.getVersion() + ' / ' + process.platform + ' / electron ' + process.versions.electron);
    migrateUserData();
    createWindow();
    boot();
    initUpdater();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

process.on('uncaughtException', (err) => {
  logLine('UNCAUGHT ' + (err && err.stack ? err.stack : String(err)));
});
process.on('unhandledRejection', (err) => {
  logLine('UNHANDLED ' + String(err && err.stack ? err.stack : err));
});

app.on('before-quit', () => { quitting = true; killApi(); if (trainProc && trainProc.exitCode === null) { try { spawn('taskkill', ['/PID', String(trainProc.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {} } });
app.on('window-all-closed', () => { quitting = true; killApi(); app.quit(); });
