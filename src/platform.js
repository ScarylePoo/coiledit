/* global RecoilDocs */
// Platform layer: implements window.api (used by renderer.js) on top of Tauri.
// Menus, dialogs, file I/O, change polling, session storage and the Recoil importers.
(() => {
'use strict';

const T = window.__TAURI__;
const { invoke } = T.core;
const appWindow = T.window.getCurrentWindow();
const ua = navigator.userAgent;
const platform = /Windows/.test(ua) ? 'win32' : /Macintosh|Mac OS X/.test(ua) ? 'darwin' : 'linux';
const isMac = platform === 'darwin';
const fileManager = platform === 'win32' ? 'File Explorer' : isMac ? 'Finder' : 'File Manager';

const listeners = { command: [], openPaths: [], fileChanged: [], tabAction: [], recoilDb: [], handlerCallins: [] };
const emit = (k, ...args) => listeners[k].forEach((f) => f(...args));
const on = (k) => (f) => listeners[k].push(f);
const beforeClose = [];

// ---------- in-app dialogs ----------
let modalQueue = Promise.resolve();
function modal({ message, detail = '', buttons = ['OK'], defaultId = 0, cancelId = buttons.length - 1, kind = 'info' }) {
  const run = () => new Promise((resolve) => {
    const ov = document.getElementById('modal');
    ov.querySelector('.modal-box').dataset.kind = kind;
    ov.querySelector('.modal-msg').textContent = message;
    ov.querySelector('.modal-detail').textContent = detail;
    const row = ov.querySelector('.modal-buttons');
    row.textContent = '';
    const prevFocus = document.activeElement;
    const done = (i) => {
      ov.hidden = true;
      document.removeEventListener('keydown', key, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(i);
    };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(cancelId); }
      else if (e.key === 'Tab') {
        const bs = [...row.children];
        const i = bs.indexOf(document.activeElement);
        bs[(i + (e.shiftKey ? bs.length - 1 : 1)) % bs.length].focus();
        e.preventDefault();
        e.stopPropagation();
      }
    };
    buttons.forEach((label, i) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (i === defaultId) b.className = 'primary';
      b.addEventListener('click', () => done(i));
      row.append(b);
    });
    ov.hidden = false;
    document.addEventListener('keydown', key, true);
    (row.children[defaultId] || row.children[0]).focus();
  });
  const p = modalQueue.then(run);
  modalQueue = p.catch(() => {});
  return p;
}

let toastTimer = null;
function toast(text, ms = 0) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = !text;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ---------- external change polling ----------
const watched = new Map(); // path -> last signature (undefined until first poll)
async function poll() {
  const paths = [...watched.keys()];
  if (paths.length) {
    try {
      const stats = await invoke('stat_files', { paths });
      paths.forEach((p, i) => {
        if (!watched.has(p)) return;
        const sig = stats[i] ? stats[i].join(':') : 'missing';
        const prev = watched.get(p);
        watched.set(p, sig);
        if (prev !== undefined && prev !== sig) emit('fileChanged', p);
      });
    } catch {}
  }
  setTimeout(poll, 1200);
}
poll();

// ---------- Recoil data ----------
async function loadData(name) {
  try {
    const user = await invoke('load_json', { name });
    if (user) return user;
  } catch {}
  try { return await (await fetch(`data/${name}`)).json(); } catch { return null; }
}

async function recoilUpdate(fromFolder) {
  try {
    let db;
    if (fromFolder) {
      const dir = await T.dialog.open({ directory: true, title: 'Select your recoil-lua-library folder' });
      if (!dir) return;
      db = RecoilDocs.build(await invoke('read_lua_tree', { dir }), dir);
    } else {
      toast('Downloading Recoil API docs…');
      db = await RecoilDocs.updateFromGitHub();
    }
    toast('');
    await invoke('save_json', { name: 'recoil-api.json', data: db });
    emit('recoilDb', db);
    const fns = db.entries.filter((e) => e.k === 'f').length;
    modal({
      message: 'Recoil API docs updated',
      detail: `${fns} functions, ${db.entries.length - fns} constants/fields, ${db.types.length} types\nfrom ${db.source}`,
    });
  } catch (e) {
    toast('');
    modal({ kind: 'error', message: "Couldn't update the Recoil API docs", detail: String((e && e.message) || e) });
  }
}

async function recoilAbout() {
  const db = await loadData('recoil-api.json');
  const h = await loadData('handler-callins.json');
  const lines = db
    ? [`${db.entries.length} entries, ${db.types.length} types`, `Source: ${db.source}${db.rev ? ' @ ' + db.rev.slice(0, 10) : ''}`, `Built: ${new Date(db.built).toLocaleString()}`]
    : ['No API docs loaded.'];
  if (h) lines.push('', `Handler call-ins: ${h.widget.length} widget, ${h.gadget.length} gadget`, `From: ${h.source}`);
  modal({ message: 'Recoil API docs', detail: lines.join('\n') });
}

async function handlerLoad() {
  const dir = await T.dialog.open({ directory: true, title: 'Select your game folder (the one containing luaui/ and luarules/)' });
  if (!dir) return;
  try {
    const name = dir.split(/[\\/]/).filter(Boolean).pop();
    const h = RecoilDocs.buildHandlers(await invoke('read_handler_files', { dir }), name);
    await invoke('save_json', { name: 'handler-callins.json', data: h });
    emit('handlerCallins', h);
    modal({ message: 'Handler call-ins loaded', detail: `${h.widget.length} widget and ${h.gadget.length} gadget call-ins from\n${h.files.join('\n')}` });
  } catch (e) {
    modal({ kind: 'error', message: "Couldn't read handler call-ins", detail: String((e && e.message) || e) });
  }
}

async function handlerReset() {
  try { await invoke('delete_json', { name: 'handler-callins.json' }); } catch {}
  emit('handlerCallins', await loadData('handler-callins.json'));
}

// ---------- menus ----------
const { Menu, Submenu, MenuItem, PredefinedMenuItem } = T.menu;
const local = {
  quit: () => appWindow.close(),
  recoilGitHub: () => recoilUpdate(false),
  recoilFolder: () => recoilUpdate(true),
  recoilAbout,
  handlerLoad,
  handlerReset,
};
const run = (cmd) => (local[cmd] ? local[cmd]() : emit('command', cmd));

async function buildMenu() {
  const item = (text, accelerator, cmd) => MenuItem.new({ text, accelerator, action: () => run(cmd) });
  const sep = () => PredefinedMenuItem.new({ item: 'Separator' });
  const sub = async (text, items) => Submenu.new({ text, items: await Promise.all(items) });

  const submenus = [];
  if (isMac) {
    submenus.push(sub('CoilEdit', [
      PredefinedMenuItem.new({ item: { About: null } }),
      sep(),
      PredefinedMenuItem.new({ item: 'Hide' }),
      PredefinedMenuItem.new({ item: 'HideOthers' }),
      sep(),
      item('Quit CoilEdit', 'CmdOrCtrl+Q', 'quit'),
    ]));
  }
  submenus.push(sub('File', [
    item('New', 'CmdOrCtrl+N', 'new'),
    item('Open…', 'CmdOrCtrl+O', 'open'),
    item('Open Recent…', 'CmdOrCtrl+R', 'recent'),
    item('Reopen Closed Tab', 'CmdOrCtrl+Shift+T', 'reopenClosed'),
    sep(),
    item('Save', 'CmdOrCtrl+S', 'save'),
    item('Save As…', 'CmdOrCtrl+Shift+S', 'saveAs'),
    item('Save All', 'CmdOrCtrl+Alt+S', 'saveAll'),
    sep(),
    item('Close Tab', 'CmdOrCtrl+W', 'close'),
    item('Close All Tabs', 'CmdOrCtrl+Shift+W', 'closeAll'),
    ...(isMac ? [] : [sep(), item('Exit', undefined, 'quit')]),
  ]));
  // Editing keys (undo, find, ...) are left to the editor itself, so these items carry
  // no accelerators. On macOS the clipboard items must be native for Cmd+C/V to work.
  submenus.push(sub('Edit', [
    item('Undo', undefined, 'undo'),
    item('Redo', undefined, 'redo'),
    sep(),
    ...(isMac
      ? [PredefinedMenuItem.new({ item: 'Cut' }), PredefinedMenuItem.new({ item: 'Copy' }), PredefinedMenuItem.new({ item: 'Paste' })]
      : [item('Cut', undefined, 'cut'), item('Copy', undefined, 'copy'), item('Paste', undefined, 'paste')]),
    item('Select All', undefined, 'selectAll'),
    sep(),
    item('Find', undefined, 'find'),
    item('Replace', undefined, 'replace'),
    item('Go to Line…', undefined, 'gotoLine'),
    sep(),
    item('Toggle Line Comment', undefined, 'comment'),
    item('Format Document', undefined, 'format'),
  ]));
  submenus.push(sub('View', [
    item('Toggle Sidebar', 'CmdOrCtrl+B', 'toggleSidebar'),
    item('Group Tabs by Folder', 'CmdOrCtrl+Shift+G', 'toggleGrouping'),
    sep(),
    item('Word Wrap', 'Alt+Z', 'toggleWrap'),
    item('Minimap', 'CmdOrCtrl+M', 'toggleMinimap'),
    item('Show Whitespace', 'CmdOrCtrl+Shift+8', 'toggleWhitespace'),
    sep(),
    item('Zoom In', 'CmdOrCtrl+=', 'zoomIn'),
    item('Zoom Out', 'CmdOrCtrl+-', 'zoomOut'),
    item('Reset Zoom', 'CmdOrCtrl+0', 'zoomReset'),
    sep(),
    item('Language…', 'CmdOrCtrl+Alt+L', 'pickLanguage'),
    item('Command Palette…', undefined, 'palette'),
  ]));
  submenus.push(sub('Recoil', [
    item('Update API Docs from GitHub', undefined, 'recoilGitHub'),
    item('Load API Docs from Local Folder…', undefined, 'recoilFolder'),
    item('Load Handler Call-ins from Game Folder…', undefined, 'handlerLoad'),
    item('Reset Handler Call-ins to Default (BAR)', undefined, 'handlerReset'),
    sep(),
    item('About Current API Docs', undefined, 'recoilAbout'),
  ]));
  submenus.push(sub('Go', [
    item('Go to Tab…', 'CmdOrCtrl+P', 'quickOpen'),
    item('Next Tab', 'Ctrl+Tab', 'nextTab'),
    item('Previous Tab', 'Ctrl+Shift+Tab', 'prevTab'),
    item('Next Tab ', 'Ctrl+PageDown', 'nextTab'),
    item('Previous Tab ', 'Ctrl+PageUp', 'prevTab'),
  ]));
  const menu = await Menu.new({ items: await Promise.all(submenus) });
  await menu.setAsAppMenu();
}

async function tabMenu(info) {
  const act = (a) => () => emit('tabAction', a, info.id, info.group);
  const mk = (text, action, enabled = true) => MenuItem.new({ text, action, enabled });
  const sep = () => PredefinedMenuItem.new({ item: 'Separator' });
  const items = info.group != null
    ? [
        mk('Close Tabs in This Folder', act('closeGroup')),
        mk(`Open in ${fileManager}`, () => T.opener.openPath(info.group), !!info.group),
        mk('Copy Folder Path', () => copyText(info.group), !!info.group),
      ]
    : [
        mk('Close', act('close')),
        mk('Close Others', act('closeOthers')),
        mk('Close Tabs in Same Folder', act('closeFolder'), !!info.path),
        mk('Close Saved Tabs', act('closeSaved')),
        mk('Close All', act('closeAll')),
        sep(),
        mk('Copy Full Path', () => copyText(info.path), !!info.path),
        mk('Copy File Name', () => copyText(info.name)),
        mk(`Reveal in ${fileManager}`, () => T.opener.revealItemInDir(info.path), !!info.path),
      ];
  const menu = await Menu.new({ items: await Promise.all(items) });
  await menu.popup();
}

// ---------- events from the native side ----------
T.event.listen('open-paths', (e) => emit('openPaths', e.payload));
T.webview.getCurrentWebview().onDragDropEvent((e) => {
  if (e.payload.type === 'drop' && e.payload.paths && e.payload.paths.length) emit('openPaths', e.payload.paths);
});
appWindow.onCloseRequested(async () => {
  for (const f of beforeClose) {
    try { await invoke('save_json', { name: 'session.json', data: f() }); } catch {}
  }
});

buildMenu().catch((e) => console.error('menu', e));

window.api = {
  platform,
  readFile: (path) => invoke('read_text', { path }),
  writeFile: (path, text, enc) => invoke('write_text', { path, text, enc }).then(() => ({ ok: true }), (e) => ({ error: String(e) })),
  openDialog: async (dir) => {
    const r = await T.dialog.open({ multiple: true, defaultPath: dir || undefined });
    return r ? (Array.isArray(r) ? r : [r]) : [];
  },
  saveDialog: async (def) => (await T.dialog.save({ defaultPath: def || undefined })) || null,
  confirmClose: (name) => modal({ kind: 'warning', message: `Save changes to ${name}?`, buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2 }),
  confirmReload: async (name) => (await modal({
    kind: 'warning',
    message: `${name} was changed on disk.`,
    detail: 'You have unsaved changes in this tab. Reload and discard them?',
    buttons: ['Reload from Disk', 'Keep My Version'],
    defaultId: 1,
    cancelId: 1,
  })) === 0,
  alert: (message, detail) => modal({ kind: 'error', message, detail }),
  watch: (p) => { if (!watched.has(p)) watched.set(p, undefined); },
  unwatch: (p) => watched.delete(p),
  loadSession: () => invoke('load_json', { name: 'session.json' }).catch(() => null),
  saveSession: (d) => { invoke('save_json', { name: 'session.json', data: d }).catch(() => {}); },
  onBeforeClose: (f) => beforeClose.push(f),
  initialPaths: () => invoke('initial_paths'),
  setTitle: (t) => { appWindow.setTitle(t).catch(() => {}); },
  reveal: (p) => T.opener.revealItemInDir(p),
  openUrl: (u) => T.opener.openUrl(u),
  copyText,
  tabMenu: (info) => { tabMenu(info).catch((e) => console.error('tab menu', e)); },
  onCommand: on('command'),
  onOpenPaths: on('openPaths'),
  onFileChanged: on('fileChanged'),
  onTabAction: on('tabAction'),
  recoilDb: () => loadData('recoil-api.json'),
  onRecoilDb: on('recoilDb'),
  handlerCallins: () => loadData('handler-callins.json'),
  onHandlerCallins: on('handlerCallins'),
};
})();
