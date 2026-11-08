'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const BASE = 'https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master';

// marker: 该文件存在即认为这一项已就绪
const ITEMS = [
  {
    name: 'pretrained_models.zip',
    url: BASE + '/pretrained_models.zip',
    size: 4563188367,
    extractTo: 'GPT_SoVITS',
    marker: 'GPT_SoVITS/pretrained_models/chinese-hubert-base/pytorch_model.bin',
    label: '预训练模型（4.25 GB）'
  },
  {
    name: 'G2PWModel.zip',
    url: BASE + '/G2PWModel.zip',
    size: 588856634,
    extractTo: 'GPT_SoVITS/text',
    marker: 'GPT_SoVITS/text/G2PWModel/g2pW.onnx',
    label: '中文 G2PW（561 MB）'
  },
  {
    name: 'uvr5_weights.zip',
    url: BASE + '/uvr5_weights.zip',
    size: 522922580,
    extractTo: 'tools/uvr5',
    marker: 'tools/uvr5/uvr5_weights/HP2_all_vocals.pth',
    label: 'UVR5 人声分离（499 MB）'
  },
  {
    name: 'nltk_data.zip',
    url: BASE + '/nltk_data.zip',
    size: 9924448,
    extractTo: 'runtime',
    marker: 'runtime/nltk_data',
    label: 'NLTK 数据（10 MB）'
  },
  {
    name: 'open_jtalk_dic_utf_8-1.11.tar.gz',
    url: BASE + '/open_jtalk_dic_utf_8-1.11.tar.gz',
    size: 23646843,
    extractTo: 'runtime/Lib/site-packages/pyopenjtalk',
    marker: 'runtime/Lib/site-packages/pyopenjtalk/open_jtalk_dic_utf_8-1.11',
    label: '日文词典（23 MB）'
  }
];

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function missingItems(root) {
  return ITEMS.filter((it) => !exists(root, it.marker));
}

function hasAllModels(root) {
  return missingItems(root).length === 0;
}

function followDownload(url, dest, onBytes) {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    const go = (u) => {
      const client = u.startsWith('https:') ? https : http;
      const req = client.get(u, { headers: { 'User-Agent': 'GPT-SoVITS-Desktop' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          redirects += 1;
          res.resume();
          if (redirects > 6) return reject(new Error('重定向过多'));
          return go(new URL(res.headers.location, u).toString());
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' ' + u));
        }
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => onBytes(chunk.length));
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(true)));
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
    };

    go(url);
  });
}

function extract(archive, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dest, { recursive: true });
    const p = spawn('tar', ['-xf', archive, '-C', dest], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error('解压失败(' + code + '): ' + err.slice(-500)));
    });
  });
}

async function ensureModels(root, hooks = {}) {
  const onPhase = hooks.onPhase || (() => {});
  const onProgress = hooks.onProgress || (() => {});
  const onLog = hooks.onLog || (() => {});

  const items = missingItems(root);
  if (items.length === 0) return true;

  const totalBytes = items.reduce((s, it) => s + it.size, 0);
  let doneBytes = 0;

  const downloads = path.join(root, '.downloads');
  fs.mkdirSync(downloads, { recursive: true });

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    onPhase({ phase: 'downloading', item: it.label, index: i + 1, count: items.length });

    const archive = path.join(downloads, it.name);
    const baseDone = doneBytes;
    let lastEmit = 0;

    const onBytes = (n) => {
      doneBytes += n;
      const now = Date.now();
      if (now - lastEmit < 400) return;
      lastEmit = now;
      onProgress({
        percent: Math.min(99.9, (doneBytes / totalBytes) * 100),
        currentPercent: it.size ? Math.min(100, ((doneBytes - baseDone) / it.size) * 100) : 0,
        label: it.label,
        doneBytes,
        totalBytes
      });
    };

    onLog('下载 ' + it.label);
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
      try {
        if (fs.existsSync(archive)) fs.unlinkSync(archive);
        await followDownload(it.url, archive, onBytes);
        const size = fs.statSync(archive).size;
        if (size < it.size * 0.98) throw new Error('文件不完整: ' + size);
        ok = true;
      } catch (err) {
        onLog('第 ' + attempt + ' 次失败: ' + (err.message || err));
        const got = fs.existsSync(archive) ? fs.statSync(archive).size : 0;
        doneBytes = baseDone + got;
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    doneBytes = baseDone + it.size;

    onPhase({ phase: 'extracting', item: it.label });
    onLog('解压 ' + it.name);
    await extract(archive, path.join(root, it.extractTo));
    try { fs.unlinkSync(archive); } catch (_) {}
  }

  // 日文词典复制到 ASCII 路径，避免中文路径导致 pyopenjtalk 打不开词典
  try {
    const src = path.join(root, 'runtime', 'Lib', 'site-packages', 'pyopenjtalk', 'open_jtalk_dic_utf_8-1.11');
    const dst = path.join(process.env.LOCALAPPDATA || root, 'GPT-SoVITS', 'open_jtalk_dic_utf_8-1.11');
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      onLog('复制日文词典到用户目录');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  } catch (err) {
    onLog('词典复制失败（不影响中文）: ' + (err.message || err));
  }

  onProgress({ percent: 100, currentPercent: 100, label: '完成', doneBytes: totalBytes, totalBytes });
  return true;
}

module.exports = { ensureModels, hasAllModels, missingItems, ITEMS };
