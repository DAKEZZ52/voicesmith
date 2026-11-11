// 静态审计：IPC 一致性 + 模板误用 window
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------- 1. preload 暴露的通道与方法 ----------
const preload = read('electron/preload.js');
const invokeChannels = new Set();
const sendChannels = new Set();
const exposedMethods = new Map(); // apiName -> channel

for (const m of preload.matchAll(/(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.(invoke|send)\('([^']+)'/g)) {
  exposedMethods.set(m[1], { kind: m[2], channel: m[3] });
  (m[2] === 'invoke' ? invokeChannels : sendChannels).add(m[3]);
}
for (const m of preload.matchAll(/(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\("([^"]+)"/g)) {
  exposedMethods.set(m[1], { kind: 'invoke', channel: m[2] });
  invokeChannels.add(m[2]);
}

// 允许的接收事件
const onList = (preload.match(/const ALLOWED = \[([\s\S]*?)\];/) || preload.match(/ALLOWED\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
const allowed = new Set([...onList.matchAll(/'([^']+)'/g)].map((m) => m[1]));

// ---------- 2. main / book 注册的通道 ----------
const mainSrc = read('electron/main.js') + '\n' + read('electron/book.js');
const handlers = new Set();
for (const m of mainSrc.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)) handlers.add(m[1]);
for (const m of mainSrc.matchAll(/ipcMain\.(?:handle|on)\("([^"]+)"/g)) handlers.add(m[1]);

// ---------- 3. 渲染层用到的 api 方法 ----------
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(vue|js)$/.test(e.name)) files.push(p);
  }
})(path.join(root, 'src'));

const used = new Map(); // name -> [files]
const missingApi = [];
const templateWindow = [];

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(root, f);
  for (const m of src.matchAll(/window\.api\.(\w+)/g)) {
    const name = m[1];
    if (!used.has(name)) used.set(name, new Set());
    used.get(name).add(rel);
    if (!exposedMethods.has(name) && !['on', 'off', 'state'].includes(name)) {
      missingApi.push({ name, file: rel });
    }
  }
  // 模板区域内出现裸 window.
  const tpl = src.match(/<template>([\s\S]*)<\/template>/);
  if (tpl) {
    tpl[1].split('\n').forEach((line, i) => {
      if (/(^|[^\w.])window\./.test(line) && !/^\s*<!--/.test(line)) {
        templateWindow.push({ file: rel, line: i + 1, text: line.trim().slice(0, 100) });
      }
    });
  }
}

// ---------- 4. send 出去的通道是否在 ALLOWED ----------
const sentNotAllowed = [...sendChannels].filter((c) => !allowed.has(c));
const invokedNoHandler = [...invokeChannels].filter((c) => !handlers.has(c));
const handlerNotUsed = [...handlers].filter((h) => !invokeChannels.has(h));

console.log('=== preload 方法 ' + exposedMethods.size + ' 个，invoke 通道 ' + invokeChannels.size + ' 个 ===');
console.log('\n[1] invoke 通道没有主进程处理:');
console.log(invokedNoHandler.length ? invokedNoHandler.map((c) => '  - ' + c).join('\n') : '  无');

console.log('\n[2] 前端调用了 preload 里不存在的方法:');
console.log(missingApi.length ? missingApi.map((x) => `  - window.api.${x.name}  (${x.file})`).join('\n') : '  无');

console.log('\n[3] 模板里裸用 window.:');
console.log(templateWindow.length ? templateWindow.map((x) => `  - ${x.file}:${x.line}  ${x.text}`).join('\n') : '  无');

console.log('\n[4] send 通道未在 ALLOWED 白名单:');
console.log(sentNotAllowed.length ? sentNotAllowed.map((c) => '  - ' + c).join('\n') : '  无');

console.log('\n[5] 注册了但前端没用的通道（可能是死代码）:');
console.log(handlerNotUsed.length ? handlerNotUsed.map((c) => '  - ' + c).join('\n') : '  无');
