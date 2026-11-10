// 统一各视图的控件样式到新的设计语言
const fs = require('fs');
const path = require('path');

const files = ['Sing.vue', 'Book.vue', 'Cover.vue', 'Settings.vue', 'Train.vue'];
const dir = path.join(__dirname, '..', 'src', 'views');

const rules = [
  [/linear-gradient\(180deg, var\(--panel\), #1c2027\)/g, 'var(--panel)'],
  [/linear-gradient\(180deg, #ff9a4d, #f0761f\)/g, 'var(--accent)'],
  [/#232932/g, 'var(--panel-2)'],
  [/#1d222a/g, 'var(--panel-2)'],
  [/#20252d/g, 'var(--inset)'],
  [/#222933/g, 'var(--panel-2)'],
  [/border-radius: 9px/g, 'border-radius: 8px'],
  [/border-radius: 10px/g, 'border-radius: 8px'],
  [/border-radius: 7px/g, 'border-radius: 8px'],
  // 卡片
  [/\.card \{ background: var\(--panel\); border: 1px solid var\(--line\); border-radius: var\(--radius\); padding: 16px 18px; \}/g,
    '.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 12px; }'],
  // 卡片头
  [/\.editor-head \{ display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var\(--muted\); margin-bottom: 12px; \}/g,
    '.editor-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 24px; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--line-soft); font-size: 11px; letter-spacing: .06em; color: var(--muted); }'],
  [/\.editor-head \{ display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var\(--muted\); margin-bottom: 10px; \}/g,
    '.editor-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 24px; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--line-soft); font-size: 11px; letter-spacing: .06em; color: var(--muted); }'],
  [/\.editor-head \{ font-size: 12px; color: var\(--muted\); margin-bottom: 12px; \}/g,
    '.editor-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 24px; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--line-soft); font-size: 11px; letter-spacing: .06em; color: var(--muted); }'],
  // 小按钮
  [/\.mini \{ padding: 4px 10px; font-size: 11\.5px; border-radius: 8px; background: var\(--panel-2\); \}/g,
    '.mini { height: 24px; padding: 0 8px; font-size: 11.5px; border-radius: 8px; background: transparent; border: 1px solid transparent; color: var(--muted); }'],
  [/\.mini \{ padding: 4px 10px; font-size: 11px; border-radius: 8px; background: var\(--panel-2\); \}/g,
    '.mini { height: 24px; padding: 0 8px; font-size: 11.5px; border-radius: 8px; background: transparent; border: 1px solid transparent; color: var(--muted); }'],
  // 主按钮
  [/\.primary \{ padding: 9px 22px; border-radius: 8px; background: var\(--accent\); color: #1a1206; font-weight: 600; font-size: 13px; \}/g,
    '.primary { height: 34px; padding: 0 20px; border-radius: 8px; background: var(--accent); border-color: var(--accent); color: #1a1206; font-weight: 650; font-size: 13px; }'],
  // 错误条
  [/border: 1px solid rgba\(255, 107, 107, \.35\); background: rgba\(255, 107, 107, \.08\); color: #ffb4b4;/g,
    'border: 1px solid rgba(228, 103, 95, .32); background: rgba(228, 103, 95, .07); color: #e6a3a0;'],
  [/border: 1px solid rgba\(255, 107, 107, \.35\); background: rgba\(255, 107, 107, \.08\);/g,
    'border: 1px solid rgba(228, 103, 95, .32); background: rgba(228, 103, 95, .07);']
];

for (const f of files) {
  const p = path.join(dir, f);
  let src = fs.readFileSync(p, 'utf8');
  const before = src;
  for (const [re, to] of rules) src = src.replace(re, to);
  if (src !== before) {
    fs.writeFileSync(p, src, 'utf8');
    console.log('updated', f);
  } else {
    console.log('unchanged', f);
  }
}
