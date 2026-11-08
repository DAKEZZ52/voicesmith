'use strict';
// 测试用：直接跑生产代码里的首启下载逻辑
const path = require('path');
const { ensureModels, missingItems } = require(path.join(__dirname, '..', 'electron', 'models.js'));

const root = process.argv[2];
if (!root) {
  console.error('用法: node scripts/test-download.js <payload根目录>');
  process.exit(2);
}

console.log('缺少项:', missingItems(root).map((i) => i.name).join(', '));

let lastPct = -1;
ensureModels(root, {
  onPhase: (p) => console.log('[phase]', JSON.stringify(p)),
  onProgress: (p) => {
    const pct = Math.floor(p.percent);
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      console.log('[progress]', pct + '%', (p.doneBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB /',
        (p.totalBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB');
    }
  },
  onLog: (l) => console.log('[log]', l)
}).then(() => {
  console.log('DONE 全部就绪:', missingItems(root).length === 0);
}).catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
