const fs = require('fs');
const path = require('path');

const root = process.argv[2];

// ---------- main.js ----------
const mp = path.join(root, 'electron', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes("'rvc:delete'")) {
  const anchor = "ipcMain.handle('rvc:prune', () => {";
  const code = `ipcMain.handle('rvc:delete', (_e, { path: weightPath }) => {
  try {
    const rroot = rvcRoot();
    if (!rroot) return { ok: false, error: '没有找到 RVC 安装' };
    const wdir = path.join(rroot, 'assets', 'weights');
    const idir = path.join(rroot, 'assets', 'indices');
    const full = path.resolve(String(weightPath || ''));
    if (!full.toLowerCase().startsWith(path.resolve(wdir).toLowerCase())) {
      return { ok: false, error: '只能删除 assets/weights 里的模型' };
    }
    if (!fs.existsSync(full)) return { ok: false, error: '模型文件不存在' };
    const file = path.basename(full);
    const base = file.replace(/_e\\d+_s\\d+\\.pth$/i, '').replace(/\\.pth$/i, '');
    const deleted = [];
    let bytes = 0;
    const del = (p) => {
      try {
        const st = fs.statSync(p);
        fs.rmSync(p, { force: true });
        bytes += st.size;
        deleted.push(path.basename(p));
      } catch (_) {}
    };
    del(full);
    if (fs.existsSync(idir)) {
      for (const f of fs.readdirSync(idir)) {
        if (!f.toLowerCase().endsWith('.index')) continue;
        if (f.toLowerCase().startsWith(base.toLowerCase())) del(path.join(idir, f));
      }
    }
    return { ok: true, deleted, freedMB: +(bytes / 1048576).toFixed(1), base };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

`;
  m = m.replace(anchor, code + anchor);
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main patched');
} else {
  console.log('main already patched');
}

// ---------- preload.js ----------
const pp = path.join(root, 'electron', 'preload.js');
let p = fs.readFileSync(pp, 'utf8');
if (!p.includes('rvcDelete')) {
  p = p.replace(
    "  rvcPrune: () => ipcRenderer.invoke('rvc:prune'),",
    "  rvcPrune: () => ipcRenderer.invoke('rvc:prune'),\n  rvcDelete: (payload) => ipcRenderer.invoke('rvc:delete', payload),"
  );
  fs.writeFileSync(pp, p, 'utf8');
  console.log('preload patched');
} else {
  console.log('preload already patched');
}
