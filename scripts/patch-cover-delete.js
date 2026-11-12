const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const p = path.join(root, 'src', 'views', 'Cover.vue');
let s = fs.readFileSync(p, 'utf8');

if (!s.includes('removeModel')) {
  // 按钮放在模型选择下方
  s = s.replace(
    `<button class="mini prune" v-if="historyModels.length" @click="prune">清理旧检查点</button>`,
    `<div class="model-actions">
            <button class="mini prune" v-if="historyModels.length" @click="prune">清理旧检查点</button>
            <button class="mini danger" :disabled="!model" @click="removeModel">删除此模型</button>
          </div>`
  );

  // 删除逻辑
  s = s.replace(
    'async function prune() {',
    `async function removeModel() {
  const cur = (info.value.models || []).find((m) => m.path === model.value);
  if (!cur) return;
  const idx = (info.value.indices || []).filter((x) => x.name.toLowerCase().startsWith(baseName(cur.name).toLowerCase()));
  const lines = [
    '模型：' + cur.name,
    '将删除：',
    '· 权重文件 1 个（' + cur.sizeMB + ' MB）',
    idx.length ? '· 检索索引 ' + idx.length + ' 个（共 ' + idx.reduce((n, x) => n + (x.sizeMB || 0), 0).toFixed(0) + ' MB）' : '· 没有关联索引',
    '',
    '删掉后这个唱歌音色就没了，需要重新训练。确定？'
  ];
  if (!window.confirm(lines.join('\\n'))) return;
  const r = await window.api.rvcDelete({ path: cur.path });
  if (!r.ok) { error.value = r.error; return; }
  await refresh();
}

async function prune() {`
  );
}

// 样式
s = s.replace('.prune { align-self: flex-start; margin-top: 2px; }', '.model-actions { display: flex; gap: 6px; margin-top: 2px; }\n.model-actions .mini { margin: 0; }');

fs.writeFileSync(p, s, 'utf8');
console.log('cover patched', s.includes('removeModel'));
