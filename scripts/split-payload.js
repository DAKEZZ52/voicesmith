'use strict';
(async () => {
// 把 payload.7z 按字节切成小于 2GB 的分卷（GitHub Release 单文件上限 2GB）
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const partSize = Number(process.argv[3] || 1800 * 1024 * 1024);

if (!src || !fs.existsSync(src)) {
  console.error('用法: node scripts/split-payload.js <payload.7z> [每卷字节数]');
  process.exit(2);
}

const total = fs.statSync(src).size;
const count = Math.ceil(total / partSize);
const dir = path.dirname(src);
const base = path.basename(src);

console.log(`源文件 ${(total / 1024 ** 3).toFixed(2)} GB，切成 ${count} 卷，每卷 ${(partSize / 1024 ** 3).toFixed(2)} GB`);

const fd = fs.openSync(src, 'r');
const buf = Buffer.allocUnsafe(8 * 1024 * 1024);

for (let i = 0; i < count; i += 1) {
  const out = path.join(dir, `${base}.${String(i + 1).padStart(3, '0')}`);
  const start = i * partSize;
  const end = Math.min(start + partSize, total);
  const ws = fs.createWriteStream(out);
  let pos = start;
  while (pos < end) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
    if (n <= 0) break;
    ws.write(Buffer.from(buf.subarray(0, n)));
    pos += n;
  }
  await new Promise((r) => ws.end(r));
  const st = fs.statSync(out);
  console.log(`  ${path.basename(out)}  ${(st.size / 1024 ** 3).toFixed(2)} GB`);
}
fs.closeSync(fd);

// 校验：分卷字节数之和 == 原文件
const sum = fs.readdirSync(dir)
  .filter((f) => f.startsWith(base + '.') && /\.\d{3}$/.test(f))
  .reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
console.log(`校验：分卷合计 ${sum} bytes / 原文件 ${total} bytes -> ${sum === total ? 'OK' : 'MISMATCH'}`);
})();
