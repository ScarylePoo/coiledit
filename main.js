'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, shell, clipboard, nativeTheme, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const recoilDocs = require('./recoil-docs');

const ROOT = __dirname;
const SHOT = process.env.COILEDIT_SCREENSHOT; // smoke-test hook: capture a screenshot then quit
if (SHOT) app.setPath('userData', path.join(app.getPath('temp'), 'coiledit-smoke'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// One-time carry-over of tabs/settings from when this app was called "Slate".
if (!SHOT) {
  try {
    const dst = app.getPath('userData');
    const src = path.join(app.getPath('appData'), 'Slate');
    if (!fs.existsSync(path.join(dst, 'session.json')) && fs.existsSync(path.join(src, 'session.json'))) {
      fs.mkdirSync(dst, { recursive: true });
      for (const f of ['session.json', 'window.json', 'recoil-api.json', 'handler-callins.json']) {
        if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f));
      }
    }
  } catch {}
}

let win = null;
let pendingPaths = filesFromArgv(process.argv, process.cwd());
let rendererReady = false;
const watched = new Map();

// ---------- helpers ----------
function userFile(name) {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
function readJSON(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; }
}
function writeJSON(f, data) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, f);
}
function filesFromArgv(argv, cwd) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  return args
    .filter((a) => a && !a.startsWith('-'))
    .map((a) => path.resolve(cwd || process.cwd(), a))
    .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
function send(cmd) { if (win) win.webContents.send('command', cmd); }

function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { enc: 'utf8bom', text: buf.subarray(3).toString('utf8') };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { enc: 'utf16le', text: buf.subarray(2).toString('utf16le') };
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return { binary: true };
  try {
    return { enc: 'utf8', text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { enc: 'latin1', text: buf.toString('latin1') };
  }
}
function encode(text, enc) {
  switch (enc) {
    case 'utf8bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'latin1': return Buffer.from(text, 'latin1');
    default: return Buffer.from(text, 'utf8');
  }
}

// ---------- single instance ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const files = filesFromArgv(argv, cwd);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (!files.length) return;
    if (rendererReady) win.webContents.send('open-paths', files);
    else pendingPaths.push(...files);
  });
  app.whenReady().then(start);
}

function start() {
  nativeTheme.themeSource = 'dark';
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const p = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname)));
    if (!p.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });
  Menu.setApplicationMenu(buildMenu());
  createWindow();
}

function onScreen(b) {
  if (b.x == null || b.y == null) return false;
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 50);
}

function createWindow() {
  const st = readJSON(userFile('window.json'), {});
  const bounds = { width: st.width || 1300, height: st.height || 850 };
  if (onScreen(st)) { bounds.x = st.x; bounds.y = st.y; }
  win = new BrowserWindow({
    ...bounds,
    minWidth: 500,
    minHeight: 300,
    show: false,
    title: 'CoilEdit',
    backgroundColor: '#1b1d23',
    icon: path.join(ROOT, 'src', 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => {
    if (st.maximized) win.maximize();
    win.show();
  });
  win.loadURL('app://local/src/index.html');
  win.on('close', () => {
    try { writeJSON(userFile('window.json'), { ...win.getNormalBounds(), maximized: win.isMaximized() }); } catch {}
  });
  win.on('closed', () => { win = null; });
  // keep links from navigating the editor window
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (SHOT) {
    win.webContents.on('console-message', (_e, level, msg) => console.log('[renderer]', msg));
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.COILEDIT_SMOKE_JS) {
        try { await win.webContents.executeJavaScript(fs.readFileSync(process.env.COILEDIT_SMOKE_JS, 'utf8')); } catch (e) { console.log('[smoke]', e.message); }
        await new Promise((r) => setTimeout(r, 1500));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(SHOT, img.toPNG());
      app.quit();
    }, 3500));
  }
}

app.on('window-all-closed', () => app.quit());

// ---------- menu ----------
function buildMenu() {
  const c = (label, accelerator, cmd, extra = {}) => ({ label, accelerator, click: () => send(cmd), ...extra });
  const passive = { registerAccelerator: false }; // show the shortcut, but let the editor handle the key itself
  return Menu.buildFromTemplate([
    { label: '&File', submenu: [
      c('&New', 'CmdOrCtrl+N', 'new'),
      c('&Open…', 'CmdOrCtrl+O', 'open'),
      c('Open &Recent…', 'CmdOrCtrl+R', 'recent'),
      c('Reopen Closed Tab', 'CmdOrCtrl+Shift+T', 'reopenClosed'),
      { type: 'separator' },
      c('&Save', 'CmdOrCtrl+S', 'save'),
      c('Save &As…', 'CmdOrCtrl+Shift+S', 'saveAs'),
      c('Save A&ll', 'CmdOrCtrl+Alt+S', 'saveAll'),
      { type: 'separator' },
      c('&Close Tab', 'CmdOrCtrl+W', 'close'),
      c('Close All Tabs', 'CmdOrCtrl+Shift+W', 'closeAll'),
      { type: 'separator' },
      { label: 'E&xit', role: 'quit' },
    ] },
    { label: '&Edit', submenu: [
      c('&Undo', 'CmdOrCtrl+Z', 'undo', passive),
      c('&Redo', 'CmdOrCtrl+Y', 'redo', passive),
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      c('Select &All', 'CmdOrCtrl+A', 'selectAll', passive),
      { type: 'separator' },
      c('&Find', 'CmdOrCtrl+F', 'find', passive),
      c('&Replace', 'CmdOrCtrl+H', 'replace', passive),
      c('&Go to Line…', 'CmdOrCtrl+G', 'gotoLine', passive),
      { type: 'separator' },
      c('Toggle Line &Comment', 'CmdOrCtrl+/', 'comment', passive),
      c('&Format Document', 'Shift+Alt+F', 'format', passive),
    ] },
    { label: '&View', submenu: [
      c('Toggle &Sidebar', 'CmdOrCtrl+B', 'toggleSidebar'),
      c('Group Tabs by &Folder', 'CmdOrCtrl+Shift+G', 'toggleGrouping'),
      { type: 'separator' },
      c('&Word Wrap', 'Alt+Z', 'toggleWrap'),
      c('&Minimap', 'CmdOrCtrl+M', 'toggleMinimap'),
      c('Show &Whitespace', 'CmdOrCtrl+Shift+8', 'toggleWhitespace'),
      { type: 'separator' },
      c('Zoom &In', 'CmdOrCtrl+=', 'zoomIn'),
      c('Zoom &Out', 'CmdOrCtrl+-', 'zoomOut'),
      c('Reset &Zoom', 'CmdOrCtrl+0', 'zoomReset'),
      { type: 'separator' },
      c('&Language…', 'CmdOrCtrl+Alt+L', 'pickLanguage'),
      c('Command &Palette…', 'F1', 'palette', passive),
      { type: 'separator' },
      { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
    ] },
    { label: '&Recoil', submenu: [
      { label: 'Update API Docs from GitHub', click: () => recoilUpdate(false) },
      { label: 'Load API Docs from Local Folder…', click: () => recoilUpdate(true) },
      { label: 'Load Handler Call-ins from Game Folder…', click: handlerUpdate },
      { label: 'Reset Handler Call-ins to Default (BAR)', click: handlerReset },
      { type: 'separator' },
      { label: 'About Current API Docs', click: recoilAbout },
    ] },
    { label: '&Go', submenu: [
      c('Go to &Tab…', 'CmdOrCtrl+P', 'quickOpen'),
      c('&Next Tab', 'Ctrl+Tab', 'nextTab'),
      c('&Previous Tab', 'Ctrl+Shift+Tab', 'prevTab'),
      c('Next Tab ', 'Ctrl+PageDown', 'nextTab'),
      c('Previous Tab ', 'Ctrl+PageUp', 'prevTab'),
    ] },
  ]);
}

// ---------- IPC ----------
ipcMain.handle('read-file', (_e, p) => {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { error: 'Not a file' };
    if (st.size > 64 * 1024 * 1024) return { error: 'File is larger than 64 MB.' };
    return decode(fs.readFileSync(p));
  } catch (err) {
    return { error: err.message, code: err.code };
  }
});

ipcMain.handle('write-file', (_e, p, text, enc) => {
  try { fs.writeFileSync(p, encode(text, enc)); return { ok: true }; } catch (err) { return { error: err.message }; }
});

ipcMain.handle('open-dialog', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], defaultPath: defaultPath || undefined });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('save-dialog', async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultPath || undefined });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('confirm-close', async (_e, name) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
    message: `Save changes to ${name}?`,
  });
  return r.response;
});

ipcMain.handle('confirm-reload', async (_e, name) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Reload from Disk', 'Keep My Version'], defaultId: 1, cancelId: 1, noLink: true,
    message: `${name} was changed on disk.`,
    detail: 'You have unsaved changes in this tab. Reload and discard them?',
  });
  return r.response === 0;
});

ipcMain.handle('alert', (_e, message, detail) => dialog.showMessageBox(win, { type: 'error', message, detail: detail || '' }));

ipcMain.on('watch', (_e, p) => {
  if (watched.has(p)) return;
  const listener = (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) win && win.webContents.send('file-changed', p);
  };
  fs.watchFile(p, { interval: 1000, persistent: false }, listener);
  watched.set(p, listener);
});
ipcMain.on('unwatch', (_e, p) => {
  const l = watched.get(p);
  if (l) { fs.unwatchFile(p, l); watched.delete(p); }
});

ipcMain.handle('session-load', () => readJSON(userFile('session.json'), null));
ipcMain.on('session-save', (_e, data) => { try { writeJSON(userFile('session.json'), data); } catch {} });
ipcMain.on('session-save-sync', (e, data) => {
  try { writeJSON(userFile('session.json'), data); } catch {}
  e.returnValue = true;
});
ipcMain.handle('initial-paths', () => {
  rendererReady = true;
  const p = pendingPaths;
  pendingPaths = [];
  return p;
});
ipcMain.on('set-title', (_e, t) => { if (win) win.setTitle(t); });
ipcMain.on('reveal', (_e, p) => shell.showItemInFolder(p));

ipcMain.on('tab-menu', (_e, info) => {
  if (!win) return;
  const act = (a) => () => win.webContents.send('tab-action', a, info.id, info.group);
  const explorer = process.platform === 'win32' ? 'File Explorer' : 'Folder';
  const items = info.group != null
    ? [
        { label: 'Close Tabs in This Folder', click: act('closeGroup') },
        { label: `Open in ${explorer}`, enabled: !!info.group, click: () => shell.openPath(info.group) },
        { label: 'Copy Folder Path', enabled: !!info.group, click: () => clipboard.writeText(info.group) },
      ]
    : [
        { label: 'Close', click: act('close') },
        { label: 'Close Others', click: act('closeOthers') },
        { label: 'Close Tabs in Same Folder', enabled: !!info.path, click: act('closeFolder') },
        { label: 'Close Saved Tabs', click: act('closeSaved') },
        { label: 'Close All', click: act('closeAll') },
        { type: 'separator' },
        { label: 'Copy Full Path', enabled: !!info.path, click: () => clipboard.writeText(info.path) },
        { label: 'Copy File Name', click: () => clipboard.writeText(info.name) },
        { label: `Reveal in ${explorer}`, enabled: !!info.path, click: () => shell.showItemInFolder(info.path) },
      ];
  Menu.buildFromTemplate(items).popup({ window: win });
});

// ---------- Recoil API docs ----------
function loadRecoilDb() {
  for (const f of [userFile('recoil-api.json'), path.join(ROOT, 'src', 'data', 'recoil-api.json')]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return null;
}
ipcMain.handle('recoil-db', () => loadRecoilDb());

async function recoilUpdate(fromFolder) {
  if (!win) return;
  try {
    let db;
    if (fromFolder) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Select your recoil-lua-library folder',
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths.length) return;
      db = recoilDocs.buildFromFolder(r.filePaths[0]);
    } else {
      db = await recoilDocs.updateFromGitHub((url, opts) => net.fetch(url, opts));
    }
    writeJSON(userFile('recoil-api.json'), db);
    win.webContents.send('recoil-db', db);
    const fns = db.entries.filter((e) => e.k === 'f').length;
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'Recoil API docs updated',
      detail: `${fns} functions, ${db.entries.length - fns} constants/fields, ${db.types.length} types\nfrom ${db.source}`,
    });
  } catch (err) {
    dialog.showMessageBox(win, { type: 'error', message: "Couldn't update the Recoil API docs", detail: err.message });
  }
}

function recoilAbout() {
  const db = loadRecoilDb();
  dialog.showMessageBox(win, {
    type: 'info',
    message: 'Recoil API docs',
    detail: db
      ? `${db.entries.length} entries, ${db.types.length} types\nSource: ${db.source}${db.rev ? ' @ ' + db.rev.slice(0, 10) : ''}\nBuilt: ${new Date(db.built).toLocaleString()}`
      : 'No API docs loaded.',
  });
}

// ---------- widget/gadget handler call-ins ----------
function loadHandlers() {
  for (const f of [userFile('handler-callins.json'), path.join(ROOT, 'src', 'data', 'handler-callins.json')]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return null;
}
ipcMain.handle('handler-callins', () => loadHandlers());

async function handlerUpdate() {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    title: 'Select your game folder (the one containing luaui/ and luarules/)',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return;
  try {
    const h = recoilDocs.scanHandlers(r.filePaths[0], path.basename(r.filePaths[0]));
    writeJSON(userFile('handler-callins.json'), h);
    win.webContents.send('handler-callins', h);
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'Handler call-ins loaded',
      detail: `${h.widget.length} widget and ${h.gadget.length} gadget call-ins from\n${h.files.join('\n')}`,
    });
  } catch (err) {
    dialog.showMessageBox(win, { type: 'error', message: "Couldn't read handler call-ins", detail: err.message });
  }
}

function handlerReset() {
  try { fs.unlinkSync(userFile('handler-callins.json')); } catch {}
  if (win) win.webContents.send('handler-callins', loadHandlers());
}
