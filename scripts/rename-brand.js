// 品牌重命名：织声/WeaveVoice/weavevoice → 织声/WeaveVoice/weavevoice
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const exts = new Set(['.js', '.mjs', '.vue', '.json', '.md', '.ps1', '.nsh', '.html', '.yml', '.yaml', '.txt']);
const skipDirs = new Set(['node_modules', 'release', 'dist', '.git', '.venv', 'checkpoints']);

const map = [
  [/织声/g, '织声'],
  [/WeaveVoice/g, 'WeaveVoice'],
  [/weavevoice/g, 'weavevoice'],
];

let changed = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!exts.has(path.extname(e.name).toLowerCase())) continue;
    if (e.name === 'package-lock.json') continue;
    const before = fs.readFileSync(p, 'utf8');
    let after = before;
    for (const [re, to] of map) after = after.replace(re, to);
    if (after !== before) {
      fs.writeFileSync(p, after, 'utf8');
      changed += 1;
      console.log('updated', path.relative(root, p));
    }
  }
}
walk(root);
console.log('files changed:', changed);
