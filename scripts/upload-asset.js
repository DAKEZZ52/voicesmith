'use strict';
// 流式上传 Release 资产，带停滞检测与重试
// 用法: node scripts/upload-asset.js <owner> <repo> <releaseId> <token> <file>

const fs = require('fs');
const path = require('path');

const STALL_MS = 120000;   // 120 秒没有新字节就判定卡死
const MAX_TRY = 4;

async function attempt(url, file, size, token) {
  const controller = new AbortController();
  const stream = fs.createReadStream(file);
  let lastBytes = 0;
  let lastChange = Date.now();
  let stalled = false;

  const timer = setInterval(() => {
    const read = stream.bytesRead;
    if (read !== lastBytes) {
      lastBytes = read;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > STALL_MS) {
      stalled = true;
      console.log('  ! 连接停滞，中断重试');
      controller.abort();
    } else {
      console.log(`  ${((read / size) * 100).toFixed(1)}%  ${(read / 1024 ** 3).toFixed(2)}GB`);
    }
  }, 20000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'voicesmith-release',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size)
      },
      body: stream,
      duplex: 'half'
    });
    const text = await res.text();
    clearInterval(timer);
    stream.destroy();
    if (res.status === 201) return { ok: true, json: JSON.parse(text) };
    return { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    clearInterval(timer);
    stream.destroy();
    return { ok: false, reason: stalled ? '传输停滞' : String(err.message || err) };
  }
}

(async () => {
  const [owner, repo, releaseId, token, file] = process.argv.slice(2);
  if (!owner || !repo || !releaseId || !token || !file) {
    console.error('用法: node scripts/upload-asset.js <owner> <repo> <releaseId> <token> <file>');
    process.exit(2);
  }
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  const url = `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;

  for (let i = 1; i <= MAX_TRY; i += 1) {
    console.log(`上传 ${name} (${(size / 1024 ** 3).toFixed(2)} GB) 第 ${i} 次 …`);
    const t0 = Date.now();
    const r = await attempt(url, file, size, token);
    if (r.ok) {
      console.log(`完成 ${name}  ${(r.json.size / 1024 ** 3).toFixed(2)} GB  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      console.log(`直链 ${r.json.browser_download_url}`);
      process.exit(0);
    }
    console.log(`  失败：${r.reason}`);
    await new Promise((res) => setTimeout(res, 5000));
  }
  console.log('多次重试后仍失败');
  process.exit(1);
})();
