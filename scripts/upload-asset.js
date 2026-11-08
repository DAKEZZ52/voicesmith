'use strict';
// 流式上传单个 Release 资产（避免 curl --data-binary 把 2GB 读进内存）
// 用法: node scripts/upload-asset.js <owner> <repo> <releaseId> <token> <file>

const fs = require('fs');
const path = require('path');

(async () => {
  const [owner, repo, releaseId, token, file] = process.argv.slice(2);
  if (!owner || !repo || !releaseId || !token || !file) {
    console.error('用法: node scripts/upload-asset.js <owner> <repo> <releaseId> <token> <file>');
    process.exit(2);
  }
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  console.log(`上传 ${name} (${(size / 1024 ** 3).toFixed(2)} GB) …`);

  const url = `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  const t0 = Date.now();
  let uploaded = 0;

  const small = size < 200 * 1024 * 1024;
  const stream = small ? fs.readFileSync(file) : fs.createReadStream(file);
  if (!small) setInterval(() => {}, 1e9);
  if (false) stream.on('data', (c) => {
    uploaded += c.length;
    const sec = (Date.now() - t0) / 1000;
    if (sec > 2 && Math.floor(uploaded / (64 * 1024 * 1024)) !== Math.floor((uploaded - c.length) / (64 * 1024 * 1024))) {
      const mbps = uploaded / 1024 / 1024 / sec;
      const pct = ((uploaded / size) * 100).toFixed(1);
      console.log(`  ${pct}%  ${(uploaded / 1024 ** 3).toFixed(2)}GB  ${mbps.toFixed(1)} MB/s`);
    }
  });

  let timer = null;
  if (!small) {
    timer = setInterval(() => {
      const pct = ((stream.bytesRead / size) * 100).toFixed(1);
      console.log('  ' + pct + '%  ' + (stream.bytesRead / 1024 ** 3).toFixed(2) + 'GB');
    }, 20000);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'voicesmith-release',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size)
    },
    body: stream,
    ...(small ? {} : { duplex: 'half' })
  });

  if (timer) clearInterval(timer);
  const text = await res.text();
  if (res.status === 201) {
    const j = JSON.parse(text);
    console.log(`完成 ${name}  ${(j.size / 1024 ** 3).toFixed(2)} GB  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    console.log(`下载直链: ${j.browser_download_url}`);
  } else {
    console.log(`失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
})();
