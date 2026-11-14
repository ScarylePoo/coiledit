/* global require, monaco */
(() => {
'use strict';

const api = window.api;
const isWin = api.platform === 'win32';
const SEP = isWin ? '\\' : '/';
const $ = (s) => document.querySelector(s);

// ---------- path helpers ----------
const keyOf = (p) => (isWin ? p.toLowerCase() : p);
const lastSep = (p) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
const basename = (p) => p.slice(lastSep(p) + 1);
function dirname(p) {
  const i = lastSep(p);
  if (i < 0) return '';
  const d = p.slice(0, i);
  return /^[A-Za-z]:$/.test(d) || d === '' ? d + SEP : d;
}
function shortDir(dir, n = 2) {
  if (!dir) return '';
  const parts = dir.split(/[\\/]/).filter(Boolean);
  if (parts.length <= n) return dir;
  return '…' + SEP + parts.slice(-n).join(SEP);
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// ---------- state ----------
let editor = null;
const docs = new Map();
let activeId = null;
let nextId = 1;
let untitledCounter = 0;
let mru = []; // doc ids, most recent first
let recent = []; // file paths, most recent first
const closedStack = [];
const settings = {
  fontSize: 14,
  wordWrap: false,
  minimap: true,
  whitespace: false,
  sidebarWidth: 260,
  sidebarVisible: true,
  grouped: false,
  collapsed: [],
};

const activeDoc = () => docs.get(activeId) || null;
const docName = (d) => (d.path ? basename(d.path) : d.untitled);
const isDirty = (d) => d.model.getAlternativeVersionId() !== d.savedAlt || d.enc !== d.savedEnc;
const findByPath = (p) => { const k = keyOf(p); for (const d of docs.values()) if (d.path && keyOf(d.path) === k) return d; return null; };
const lastDir = () => { const a = activeDoc(); if (a && a.path) return dirname(a.path); const r = recent[0]; return r ? dirname(r) : undefined; };

// ---------- languages ----------
const EXTRA_EXT = {
  '.jsonc': 'json', '.json5': 'json', '.mjs': 'javascript', '.cjs': 'javascript', '.mts': 'typescript', '.cts': 'typescript',
  '.h': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.inl': 'cpp', '.glsl': 'cpp', '.vert': 'cpp', '.frag': 'cpp', '.geom': 'cpp', '.hlsl': 'cpp', '.shader': 'cpp',
  '.cfg': 'ini', '.conf': 'ini', '.toml': 'ini', '.env': 'ini', '.properties': 'ini', '.editorconfig': 'ini', '.gitconfig': 'ini',
  '.bat': 'bat', '.cmd': 'bat', '.ps1': 'powershell', '.psm1': 'powershell', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.vue': 'html', '.svelte': 'html', '.htm': 'html', '.xaml': 'xml', '.csproj': 'xml', '.svg': 'xml', '.luau': 'lua',
  '.txt': 'plaintext', '.log': 'plaintext',
};
const EXTRA_NAMES = { '.gitignore': 'shell', '.gitattributes': 'shell', '.bashrc': 'shell', '.profile': 'shell', 'makefile': 'shell', 'cmakelists.txt': 'shell' };

function detectLanguage(filename) {
  const lower = filename.toLowerCase();
  if (EXTRA_NAMES[lower]) return EXTRA_NAMES[lower];
  const langs = monaco.languages.getLanguages();
  for (const l of langs) if (l.filenames && l.filenames.some((f) => f.toLowerCase() === lower)) return l.id;
  let best = null, bestLen = 0;
  for (const [ext, id] of Object.entries(EXTRA_EXT)) if (lower.endsWith(ext) && ext.length > bestLen) { best = id; bestLen = ext.length; }
  for (const l of langs) for (const ext of l.extensions || []) {
    const e = ext.toLowerCase();
    if (lower.endsWith(e) && e.length > bestLen) { best = l.id; bestLen = e.length; }
  }
  return best || 'plaintext';
}
const langLabel = (id) => { const l = monaco.languages.getLanguages().find((x) => x.id === id); return (l && l.aliases && l.aliases[0]) || id; };

// ---------- documents ----------
function newDoc({ path = null, text = '', enc = 'utf8', lang = null, untitled = null }) {
  const id = nextId++;
  const language = lang || (path ? detectLanguage(basename(path)) : 'plaintext');
  const model = monaco.editor.createModel(text, language);
  const doc = {
    id, path, untitled, model, enc,
    savedEnc: enc,
    savedText: text,
    savedAlt: model.getAlternativeVersionId(),
    viewState: null,
    langOverride: !!lang,
    missing: false,
    wasDirty: false,
  };
  model.onDidChangeContent(() => {
    const d = isDirty(doc);
    if (d !== doc.wasDirty) { doc.wasDirty = d; renderTabs(); updateTitle(); }
    scheduleSave();
  });
  docs.set(id, doc);
  if (path) api.watch(path);
  return doc;
}

function replaceText(doc, text) {
  doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text }], () => null);
}

function newUntitled() {
  const doc = newDoc({ untitled: `Untitled-${++untitledCounter}` });
  activate(doc.id);
}

function addRecent(p) {
  const k = keyOf(p);
  recent = [p, ...recent.filter((r) => keyOf(r) !== k)].slice(0, 40);
}

async function openPaths(paths) {
  const only = docs.size === 1 ? [...docs.values()][0] : null;
  const pristine = only && !only.path && only.model.getValueLength() === 0 && !isDirty(only) ? only : null;
  let last = null;
  for (const p of paths) {
    const existing = findByPath(p);
    if (existing) { last = existing; continue; }
    const r = await api.readFile(p);
    if (r.error) { addRecentRemove(p, r); api.alert(`Couldn't open ${basename(p)}`, r.error); continue; }
    if (r.binary) { api.alert(`${basename(p)} looks like a binary file.`, 'It was not opened.'); continue; }
    last = newDoc({ path: p, text: r.text, enc: r.enc });
    addRecent(p);
  }
  if (last) {
    activate(last.id);
    if (pristine && pristine !== last) closeDoc(pristine.id);
  }
  renderTabs();
  scheduleSave();
}
function addRecentRemove(p, r) {
  if (r.code === 'ENOENT') recent = recent.filter((x) => keyOf(x) !== keyOf(p));
}

function activate(id) {
  const doc = docs.get(id);
  if (!doc) return;
  const cur = activeDoc();
  if (cur && cur !== doc) cur.viewState = editor.saveViewState();
  activeId = id;
  mru = [id, ...mru.filter((x) => x !== id)];
  if (editor.getModel() !== doc.model) {
    editor.setModel(doc.model);
    if (doc.viewState) editor.restoreViewState(doc.viewState);
  }
  $('#empty').hidden = true;
  editor.focus();
  renderTabs();
  updateStatus();
  updateTitle();
  scheduleSave();
}

async function closeDoc(id) {
  const doc = docs.get(id);
  if (!doc) return true;
  if (isDirty(doc)) {
    activate(id);
    const r = await api.confirmClose(docName(doc));
    if (r === 2) return false;
    if (r === 0 && !(await saveDoc(doc))) return false;
  }
  let next = null;
  if (activeId === id) {
    next = docs.get(mru.find((x) => x !== id && docs.has(x)));
  }
  if (doc.path) { closedStack.push(doc.path); api.unwatch(doc.path); }
  docs.delete(id);
  mru = mru.filter((x) => x !== id);
  if (activeId === id) {
    activeId = null;
    if (next) activate(next.id);
    else { editor.setModel(null); $('#empty').hidden = false; }
  }
  doc.model.dispose();
  renderTabs();
  updateStatus();
  updateTitle();
  scheduleSave();
  return true;
}

async function closeMany(list) {
  for (const d of list) if (!(await closeDoc(d.id))) return false;
  return true;
}

async function saveDoc(doc, saveAs = false) {
  let p = doc.path;
  if (!p || saveAs) {
    const dir = (doc.path && dirname(doc.path)) || lastDir();
    p = await api.saveDialog(dir ? dir.replace(/[\\/]$/, '') + SEP + docName(doc) : docName(doc));
    if (!p) return false;
  }
  const text = doc.model.getValue();
  const r = await api.writeFile(p, text, doc.enc);
  if (r.error) { api.alert(`Couldn't save ${basename(p)}`, r.error); return false; }
  if (p !== doc.path) {
    if (doc.path) api.unwatch(doc.path);
    doc.path = p;
    doc.untitled = null;
    api.watch(p);
    if (!doc.langOverride) monaco.editor.setModelLanguage(doc.model, detectLanguage(basename(p)));
    addRecent(p);
  }
  doc.savedText = text;
  doc.savedAlt = doc.model.getAlternativeVersionId();
  doc.savedEnc = doc.enc;
  doc.missing = false;
  doc.wasDirty = false;
  renderTabs();
  updateTitle();
  updateStatus();
  scheduleSave();
  return true;
}

// external changes
api.onFileChanged(async (p) => {
  const doc = findByPath(p);
  if (!doc) return;
  const r = await api.readFile(p);
  if (r.error) {
    if (!doc.missing) { doc.missing = true; renderTabs(); }
    return;
  }
  const wasMissing = doc.missing;
  doc.missing = false;
  if (r.binary || r.text === doc.savedText) { if (wasMissing) renderTabs(); return; }
  if (isDirty(doc) && !(await api.confirmReload(docName(doc)))) {
    doc.savedText = r.text; // don't ask again for this version
    renderTabs();
    return;
  }
  const view = doc === activeDoc() ? editor.saveViewState() : null;
  replaceText(doc, r.text);
  doc.savedText = r.text;
  doc.savedAlt = doc.model.getAlternativeVersionId();
  doc.enc = doc.savedEnc = r.enc;
  doc.wasDirty = false;
  if (view) editor.restoreViewState(view);
  renderTabs();
  updateTitle();
  updateStatus();
});

// ---------- ordering ----------
function sortedByName() {
  return [...docs.values()].sort((a, b) =>
    collator.compare(docName(a), docName(b)) || collator.compare(a.path || '', b.path || ''));
}
function groups() {
  const map = new Map();
  for (const d of sortedByName()) {
    const dir = d.path ? dirname(d.path) : '';
    const k = keyOf(dir);
    if (!map.has(k)) map.set(k, { dir, docs: [] });
    map.get(k).docs.push(d);
  }
  return [...map.values()].sort((a, b) => (a.dir === '' ? -1 : b.dir === '' ? 1 : collator.compare(a.dir, b.dir)));
}
function visualOrder() {
  return settings.grouped ? groups().flatMap((g) => g.docs) : sortedByName();
}

// ---------- sidebar ----------
function tabEl(doc) {
  const el = document.createElement('div');
  el.className = 'tab';
  if (doc.id === activeId) el.classList.add('active');
  if (isDirty(doc)) el.classList.add('dirty');
  if (doc.missing) el.classList.add('missing');
  if (!doc.path) el.classList.add('untitled');
  el.title = doc.path || docName(doc);
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = docName(doc);
  const dir = document.createElement('span');
  dir.className = 'dir';
  dir.textContent = doc.path ? basename(dirname(doc.path).replace(/[\\/]$/, '')) || dirname(doc.path) : '';
  const x = document.createElement('span');
  x.className = 'x';
  x.title = 'Close (Ctrl+W)';
  x.addEventListener('mousedown', (e) => e.stopPropagation());
  x.addEventListener('click', (e) => { e.stopPropagation(); closeDoc(doc.id); });
  el.append(name, dir, x);
  el.addEventListener('mousedown', (e) => { if (e.button === 0) activate(doc.id); });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeDoc(doc.id); } });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.tabMenu({ id: doc.id, path: doc.path, name: docName(doc) });
  });
  return el;
}

function renderTabs() {
  const box = $('#tabs');
  const scroll = box.scrollTop;
  box.textContent = '';
  box.classList.toggle('grouped', settings.grouped);
  $('#btn-group').classList.toggle('on', settings.grouped);
  $('#tab-count').textContent = docs.size ? String(docs.size) : '';
  let activeEl = null;
  const add = (doc) => { const el = tabEl(doc); if (doc.id === activeId) activeEl = el; box.append(el); };
  if (settings.grouped) {
    for (const g of groups()) {
      const key = keyOf(g.dir);
      const collapsed = settings.collapsed.includes(key) && !g.docs.some((d) => d.id === activeId);
      const h = document.createElement('div');
      h.className = 'group' + (collapsed ? ' collapsed' : '');
      h.title = g.dir || 'Unsaved files';
      h.innerHTML = '<span class="chev">▼</span><span class="gname"></span><span class="count"></span>';
      h.querySelector('.gname').textContent = g.dir ? '‎' + shortDir(g.dir, 3) : 'Unsaved';
      h.querySelector('.count').textContent = g.docs.length;
      h.addEventListener('click', () => {
        settings.collapsed = settings.collapsed.includes(key) ? settings.collapsed.filter((k) => k !== key) : [...settings.collapsed, key];
        renderTabs();
        scheduleSave();
      });
      h.addEventListener('contextmenu', (e) => { e.preventDefault(); api.tabMenu({ group: g.dir }); });
      box.append(h);
      if (!collapsed) g.docs.forEach(add);
    }
  } else {
    sortedByName().forEach(add);
  }
  box.scrollTop = scroll;
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

api.onTabAction(async (action, id, group) => {
  const doc = docs.get(id);
  const all = visualOrder();
  switch (action) {
    case 'close': if (doc) closeDoc(id); break;
    case 'closeOthers': closeMany(all.filter((d) => d.id !== id)); break;
    case 'closeSaved': closeMany(all.filter((d) => !isDirty(d))); break;
    case 'closeAll': closeMany(all); break;
    case 'closeFolder': if (doc && doc.path) { const k = keyOf(dirname(doc.path)); closeMany(all.filter((d) => d.path && keyOf(dirname(d.path)) === k)); } break;
    case 'closeGroup': { const k = keyOf(group || ''); closeMany(all.filter((d) => keyOf(d.path ? dirname(d.path) : '') === k)); break; }
  }
});

// ---------- status bar & title ----------
const ENC_LABEL = { utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', utf16le: 'UTF-16 LE', latin1: 'Windows-1252' };

function updateStatus() {
  const doc = activeDoc();
  const ids = ['#st-path', '#st-pos', '#st-indent', '#st-enc', '#st-eol', '#st-lang'];
  if (!doc) { ids.forEach((s) => ($(s).textContent = '')); return; }
  const m = doc.model;
  $('#st-path').textContent = doc.path || docName(doc);
  const sel = editor.getSelection();
  let pos = sel ? `Ln ${sel.positionLineNumber}, Col ${sel.positionColumn}` : '';
  if (sel && !sel.isEmpty()) {
    const n = m.getValueLengthInRange(sel);
    const sels = editor.getSelections().length;
    pos += sels > 1 ? ` (${sels} selections)` : ` (${n} selected)`;
  }
  $('#st-pos').textContent = pos;
  const o = m.getOptions();
  $('#st-indent').textContent = o.insertSpaces ? `Spaces: ${o.indentSize}` : `Tab Size: ${o.tabSize}`;
  $('#st-enc').textContent = ENC_LABEL[doc.enc] || doc.enc;
  $('#st-eol').textContent = m.getEOL() === '\r\n' ? 'CRLF' : 'LF';
  $('#st-lang').textContent = langLabel(m.getLanguageId());
}

function updateTitle() {
  const doc = activeDoc();
  if (!doc) { api.setTitle('CoilEdit'); return; }
  const dirty = isDirty(doc) ? '● ' : '';
  const where = doc.path ? ` — ${dirname(doc.path)}` : '';
  api.setTitle(`${dirty}${docName(doc)}${where} — CoilEdit`);
}

// ---------- quick pick ----------
function score(item, q) {
  const label = item.label.toLowerCase();
  const full = ((item.detail || '') + ' ' + label).toLowerCase();
  if (label.startsWith(q)) return 1000 - label.length;
  const i = label.indexOf(q);
  if (i >= 0) return 800 - i;
  if (full.includes(q)) return 500;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => full.includes(w))) return 400;
  let j = 0;
  for (const ch of label) if (ch === q[j]) j++;
  if (j === q.length) return 200;
  j = 0;
  for (const ch of full) if (ch === q[j]) j++;
  return j === q.length ? 100 : 0;
}

let qpClose = null;
function quickPick(items, placeholder) {
  if (qpClose) qpClose();
  const ov = $('#qp'), input = $('#qp-input'), list = $('#qp-list');
  let shown = items, sel = 0, open = true;
  ov.hidden = false;
  input.value = '';
  input.placeholder = placeholder;
  input.focus();
  const close = (refocus = true) => {
    if (!open) return;
    open = false;
    qpClose = null;
    ov.hidden = true;
    input.oninput = input.onkeydown = input.onblur = null;
    if (refocus && editor && editor.getModel()) editor.focus();
  };
  qpClose = close;
  const pick = (it) => { close(); if (it) it.run(); };
  const render = () => {
    list.textContent = '';
    if (!shown.length) { list.innerHTML = '<div class="qp-empty">No matches</div>'; return; }
    shown.slice(0, 300).forEach((it, i) => {
      const el = document.createElement('div');
      el.className = 'qp-item' + (i === sel ? ' sel' : '');
      const a = document.createElement('span'); a.className = 'qp-label'; a.textContent = it.label;
      const b = document.createElement('span'); b.className = 'qp-detail'; b.textContent = it.detail || '';
      el.append(a, b);
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(it); });
      list.append(el);
    });
    const s = list.children[sel];
    if (s) s.scrollIntoView({ block: 'nearest' });
  };
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    shown = q ? items.map((it, i) => ({ it, s: score(it, q), i })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.it) : items;
    sel = 0;
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'PageDown') { sel = Math.min(sel + 10, shown.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'PageUp') { sel = Math.max(sel - 10, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  input.onblur = () => close(false);
  render();
}

function quickOpen() {
  const open = [...mru.map((id) => docs.get(id)).filter(Boolean), ...sortedByName().filter((d) => !mru.includes(d.id))];
  // most-recent-first, but put the current tab last so Enter jumps to the previous one
  const cur = activeDoc();
  const ordered = cur ? [...open.filter((d) => d !== cur), cur] : open;
  const items = ordered.map((d) => ({ label: docName(d), detail: d.path ? dirname(d.path) : 'unsaved', run: () => activate(d.id) }));
  for (const p of recent) {
    if (findByPath(p)) continue;
    items.push({ label: basename(p), detail: `${dirname(p)}  · recent`, run: () => openPaths([p]) });
  }
  quickPick(items, 'Go to an open tab or recent file…');
}

function recentPick() {
  const items = recent.map((p) => ({ label: basename(p), detail: dirname(p) + (findByPath(p) ? '  · open' : ''), run: () => openPaths([p]) }));
  quickPick(items, recent.length ? 'Open a recent file…' : 'No recent files yet');
}

function pickLanguage() {
  const doc = activeDoc();
  if (!doc) return;
  const items = monaco.languages.getLanguages()
    .map((l) => ({ label: (l.aliases && l.aliases[0]) || l.id, detail: l.id, run: () => setLang(doc, l.id, true) }))
    .sort((a, b) => collator.compare(a.label, b.label));
  const auto = doc.path ? detectLanguage(basename(doc.path)) : 'plaintext';
  items.unshift({ label: 'Auto Detect', detail: langLabel(auto), run: () => setLang(doc, auto, false) });
  quickPick(items, `Language mode (currently ${langLabel(doc.model.getLanguageId())})`);
}
function setLang(doc, id, override) {
  monaco.editor.setModelLanguage(doc.model, id);
  doc.langOverride = override;
  updateStatus();
  scheduleSave();
}

function pickIndent() {
  const doc = activeDoc();
  if (!doc) return;
  const set = (o) => () => { doc.model.updateOptions(o); updateStatus(); };
  quickPick([
    { label: 'Spaces: 4', run: set({ insertSpaces: true, tabSize: 4, indentSize: 4 }) },
    { label: 'Spaces: 2', run: set({ insertSpaces: true, tabSize: 2, indentSize: 2 }) },
    { label: 'Tabs (width 4)', run: set({ insertSpaces: false, tabSize: 4, indentSize: 4 }) },
    { label: 'Tabs (width 2)', run: set({ insertSpaces: false, tabSize: 2, indentSize: 2 }) },
    { label: 'Tabs (width 8)', run: set({ insertSpaces: false, tabSize: 8, indentSize: 8 }) },
    { label: 'Convert Indentation to Spaces', run: () => editor.trigger('status', 'editor.action.indentationToSpaces') },
    { label: 'Convert Indentation to Tabs', run: () => editor.trigger('status', 'editor.action.indentationToTabs') },
    { label: 'Detect from Content', run: () => { editor.trigger('status', 'editor.action.detectIndentation'); updateStatus(); } },
  ], 'Indentation');
}

function pickEncoding() {
  const doc = activeDoc();
  if (!doc) return;
  quickPick(Object.entries(ENC_LABEL).map(([k, v]) => ({
    label: v, detail: k === doc.enc ? 'current' : 'save with this encoding',
    run: () => { doc.enc = k; doc.wasDirty = isDirty(doc); updateStatus(); renderTabs(); updateTitle(); },
  })), 'Save with encoding…');
}

function toggleEol() {
  const doc = activeDoc();
  if (!doc) return;
  const crlf = doc.model.getEOL() === '\r\n';
  doc.model.pushEOL(crlf ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
  updateStatus();
}

// ---------- session ----------
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveSession(sessionData()), 1500);
}
function sessionData() {
  const order = visualOrder();
  const act = activeDoc();
  if (act && editor) act.viewState = editor.saveViewState();
  return {
    v: 1,
    settings,
    recent,
    untitledCounter,
    active: act ? order.indexOf(act) : -1,
    docs: order.map((d) => ({
      path: d.path,
      untitled: d.untitled,
      lang: d.langOverride ? d.model.getLanguageId() : null,
      enc: d.enc,
      dirty: isDirty(d) ? d.model.getValue() : null,
      view: d.viewState,
    })),
  };
}

async function restoreDocs(s) {
  if (!s || !Array.isArray(s.docs)) return;
  const reads = await Promise.all(s.docs.map((t) => (t.path ? api.readFile(t.path) : null)));
  let toActivate = null;
  s.docs.forEach((t, i) => {
    let doc = null;
    const r = reads[i];
    if (t.path) {
      if (r && !r.error && !r.binary) {
        doc = newDoc({ path: t.path, text: r.text, enc: r.enc, lang: t.lang });
        if (t.dirty != null && t.dirty !== r.text) replaceText(doc, t.dirty);
        if (t.enc && t.enc !== r.enc) doc.enc = t.enc;
      } else if (t.dirty != null) {
        doc = newDoc({ path: t.path, text: t.dirty, enc: t.enc || 'utf8', lang: t.lang });
        doc.savedAlt = -1;
        doc.missing = true;
      }
    } else {
      doc = newDoc({ untitled: t.untitled || `Untitled-${++untitledCounter}`, text: t.dirty || '', lang: t.lang });
      if (t.dirty) doc.savedAlt = -1;
    }
    if (!doc) return;
    doc.wasDirty = isDirty(doc);
    doc.viewState = t.view || null;
    if (i === s.active) toActivate = doc;
  });
  const first = toActivate || visualOrder()[0];
  if (first) activate(first.id);
}

// Saved by the platform layer when the window is closing.
api.onBeforeClose(() => {
  clearTimeout(saveTimer);
  return sessionData();
});

// ---------- settings application ----------
function applySettings() {
  document.documentElement.style.setProperty('--sidebar-w', settings.sidebarWidth + 'px');
  document.body.classList.toggle('no-sidebar', !settings.sidebarVisible);
  if (editor) {
    editor.updateOptions({
      fontSize: settings.fontSize,
      wordWrap: settings.wordWrap ? 'on' : 'off',
      minimap: { enabled: settings.minimap },
      renderWhitespace: settings.whitespace ? 'all' : 'selection',
    });
  }
}

// ---------- commands ----------
function nav(step) {
  const order = visualOrder();
  if (!order.length) return;
  const i = order.indexOf(activeDoc());
  activate(order[(i + step + order.length) % order.length].id);
}
// Menu edit commands go to the editor unless a text box (quick pick) has focus.
function editAction(editorAction, domCommand) {
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.closest('.monaco-editor')) {
    document.execCommand(domCommand);
  } else if (editor && editor.getModel()) {
    editor.focus();
    editor.trigger('menu', editorAction, null);
  }
}
function setting(key, value) { settings[key] = value; applySettings(); scheduleSave(); }

const commands = {
  new: newUntitled,
  open: async () => { const paths = await api.openDialog(lastDir()); if (paths.length) openPaths(paths); },
  recent: recentPick,
  reopenClosed: () => { const p = closedStack.pop(); if (p) openPaths([p]); },
  save: () => { const d = activeDoc(); if (d) saveDoc(d); },
  saveAs: () => { const d = activeDoc(); if (d) saveDoc(d, true); },
  saveAll: async () => { for (const d of visualOrder()) if (isDirty(d) || !d.path && d.model.getValueLength()) if (!(await saveDoc(d))) break; },
  close: () => { if (activeId != null) closeDoc(activeId); },
  closeAll: () => closeMany(visualOrder()),
  undo: () => editAction('undo', 'undo'),
  redo: () => editAction('redo', 'redo'),
  selectAll: () => editAction('editor.action.selectAll', 'selectAll'),
  cut: () => editAction('editor.action.clipboardCutAction', 'cut'),
  copy: () => editAction('editor.action.clipboardCopyAction', 'copy'),
  paste: () => editAction('editor.action.clipboardPasteAction', 'paste'),
  find: () => editor.getModel() && editor.getAction('actions.find').run(),
  replace: () => editor.getModel() && editor.getAction('editor.action.startFindReplaceAction').run(),
  gotoLine: () => editor.getModel() && editor.getAction('editor.action.gotoLine').run(),
  comment: () => editor.getModel() && editor.getAction('editor.action.commentLine').run(),
  format: () => { const a = editor.getModel() && editor.getAction('editor.action.formatDocument'); if (a) a.run(); },
  palette: () => { editor.focus(); editor.getAction('editor.action.quickCommand').run(); },
  toggleSidebar: () => setting('sidebarVisible', !settings.sidebarVisible),
  toggleGrouping: () => { setting('grouped', !settings.grouped); renderTabs(); },
  toggleWrap: () => setting('wordWrap', !settings.wordWrap),
  toggleMinimap: () => setting('minimap', !settings.minimap),
  toggleWhitespace: () => setting('whitespace', !settings.whitespace),
  zoomIn: () => setting('fontSize', Math.min(settings.fontSize + 1, 40)),
  zoomOut: () => setting('fontSize', Math.max(settings.fontSize - 1, 8)),
  zoomReset: () => setting('fontSize', 14),
  pickLanguage,
  quickOpen,
  nextTab: () => nav(1),
  prevTab: () => nav(-1),
};
api.onCommand((c) => { if (commands[c]) commands[c](); });
api.onOpenPaths((paths) => openPaths(paths));

// ---------- UI wiring ----------
function wireUi() {
  $('#btn-new').addEventListener('click', newUntitled);
  $('#btn-open').addEventListener('click', commands.open);
  $('#btn-group').addEventListener('click', commands.toggleGrouping);
  $('#st-lang').addEventListener('click', pickLanguage);
  $('#st-indent').addEventListener('click', pickIndent);
  $('#st-enc').addEventListener('click', pickEncoding);
  $('#st-eol').addEventListener('click', toggleEol);
  $('#st-path').addEventListener('click', () => { const d = activeDoc(); if (d && d.path) api.copyText(d.path); });
  $('#st-path').addEventListener('dblclick', () => { const d = activeDoc(); if (d && d.path) api.reveal(d.path); });
  // double-click empty sidebar space = new file (Notepad++ habit)
  $('#tabs').addEventListener('dblclick', (e) => { if (e.target.id === 'tabs') newUntitled(); });

  // sidebar resize
  const resizer = $('#resizer');
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const move = (ev) => {
      settings.sidebarWidth = Math.max(140, Math.min(700, ev.clientX));
      applySettings();
    };
    const up = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      scheduleSave();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  // Files dropped from the file manager arrive through api.onOpenPaths.
}

// ---------- theme ----------
function defineTheme() {
  monaco.editor.defineTheme('coil', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'cdd3de' },
      { token: 'comment', foreground: '6a7489', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c792ea' },
      { token: 'string', foreground: 'a8d68f' },
      { token: 'string.escape', foreground: '89ddff' },
      { token: 'number', foreground: 'f5a97f' },
      { token: 'regexp', foreground: 'f78c6c' },
      { token: 'type', foreground: '7dcfff' },
      { token: 'type.identifier', foreground: '7dcfff' },
      { token: 'identifier', foreground: 'cdd3de' },
      { token: 'delimiter', foreground: '8b93a7' },
      { token: 'operator', foreground: '89ddff' },
      { token: 'tag', foreground: 'f07178' },
      { token: 'metatag', foreground: '89ddff' },
      { token: 'attribute.name', foreground: 'ffcb6b' },
      { token: 'attribute.value', foreground: 'a8d68f' },
      { token: 'variable', foreground: 'f07178' },
      { token: 'variable.predefined', foreground: '82aaff' },
      { token: 'constant', foreground: 'f5a97f' },
      { token: 'predefined', foreground: '82aaff' },
      { token: 'annotation', foreground: 'ffcb6b' },
      { token: 'key', foreground: '82aaff' },
      { token: 'string.key.json', foreground: '82aaff' },
      { token: 'string.value.json', foreground: 'a8d68f' },
      { token: 'keyword.json', foreground: 'f5a97f' },
      { token: 'tag.css', foreground: 'f07178' },
      { token: 'attribute.name.css', foreground: '82aaff' },
      { token: 'attribute.value.css', foreground: 'f5a97f' },
      { token: 'keyword.md', foreground: 'c792ea' },
      { token: 'strong', fontStyle: 'bold' },
      // Recoil engine API (semantic tokens from recoil.js)
      { token: 'recoilNamespace', foreground: '5fa8a0' },
      { token: 'recoilCallout', foreground: '4fd6be' },
      { token: 'recoilCallin', foreground: 'ffc777', fontStyle: 'bold' },
      { token: 'recoilConstant', foreground: 'fca7ea' },
      { token: 'recoilHandler', foreground: 'ff9f7a', fontStyle: 'bold' },
      { token: 'emphasis', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#1b1d23',
      'editor.foreground': '#cdd3de',
      'editor.lineHighlightBackground': '#21242c',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#454b59',
      'editorLineNumber.activeForeground': '#9aa3b4',
      'editorCursor.foreground': '#5eacff',
      'editor.selectionBackground': '#2f4366',
      'editor.inactiveSelectionBackground': '#2a3448',
      'editor.selectionHighlightBackground': '#2f436655',
      'editor.wordHighlightBackground': '#3a3f4e80',
      'editor.findMatchBackground': '#7a5c1f',
      'editor.findMatchHighlightBackground': '#7a5c1f66',
      'editorIndentGuide.background1': '#262a33',
      'editorIndentGuide.activeBackground1': '#3b4150',
      'editorWhitespace.foreground': '#3a3f4b',
      'editorGutter.background': '#1b1d23',
      'editorWidget.background': '#20232b',
      'editorWidget.border': '#30343f',
      'editorSuggestWidget.background': '#20232b',
      'editorSuggestWidget.selectedBackground': '#2c3240',
      'editorHoverWidget.background': '#20232b',
      'input.background': '#1b1d23',
      'input.border': '#343947',
      'focusBorder': '#5eacff88',
      'scrollbarSlider.background': '#2a2e3899',
      'scrollbarSlider.hoverBackground': '#363b47cc',
      'scrollbarSlider.activeBackground': '#40465599',
      'minimap.background': '#1b1d23',
      'editorBracketMatch.background': '#5eacff22',
      'editorBracketMatch.border': '#5eacff66',
      'editorBracketHighlight.foreground1': '#d8b26e',
      'editorBracketHighlight.foreground2': '#c38fd8',
      'editorBracketHighlight.foreground3': '#6fb3e8',
      'editorOverviewRuler.border': '#00000000',
      'quickInput.background': '#20232b',
      'list.activeSelectionBackground': '#2c3240',
      'list.hoverBackground': '#252933',
    },
  });
}

// ---------- boot ----------
window.MonacoEnvironment = { getWorkerUrl: () => new URL('worker.js', location.href).href };
require.config({ paths: { vs: 'vendor/monaco/vs' } });
require(['vs/editor/editor.main'], async () => {
  const s = await api.loadSession();
  if (s && s.settings) Object.assign(settings, s.settings);
  if (s) { recent = s.recent || []; untitledCounter = s.untitledCounter || 0; }

  // Single-file editing: keep syntax errors, drop "can't find module/name" noise.
  const ts = monaco.languages.typescript;
  if (ts) {
    for (const d of [ts.javascriptDefaults, ts.typescriptDefaults]) d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  }
  if (monaco.languages.json) monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: 'ignore' });

  defineTheme();
  applySettings();
  editor = monaco.editor.create($('#editor'), {
    model: null,
    theme: 'coil',
    fontFamily: "'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono', monospace",
    fontSize: settings.fontSize,
    lineHeight: 0,
    minimap: { enabled: settings.minimap, renderCharacters: false, scale: 1 },
    wordWrap: settings.wordWrap ? 'on' : 'off',
    renderWhitespace: settings.whitespace ? 'all' : 'selection',
    automaticLayout: true,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'off',
    bracketPairColorization: { enabled: true },
    guides: { indentation: true, bracketPairs: false },
    dropIntoEditor: { enabled: false },
    stickyScroll: { enabled: false },
    renderLineHighlight: 'all',
    fixedOverflowWidgets: true,
    padding: { top: 6 },
    unicodeHighlight: { ambiguousCharacters: false },
    occurrencesHighlight: 'singleFile',
    links: true,
    contextmenu: true,
    'semanticHighlighting.enabled': true,
  });
  editor.onDidChangeCursorSelection(updateStatus);
  editor.onDidChangeModelOptions(updateStatus);
  editor.onDidChangeModelLanguage(updateStatus);
  editor.onDidChangeModelContent(() => { if (activeDoc()) updateStatus(); });

  wireUi();
  // Links in hovers (engine source etc.) open in the system browser.
  monaco.editor.registerLinkOpener({ open: (uri) => { api.openUrl(uri.toString(true)); return true; } });
  if (window.Recoil) {
    window.Recoil.setData(await api.recoilDb());
    api.onRecoilDb((db) => window.Recoil.setData(db));
    window.Recoil.setHandlers(await api.handlerCallins());
    api.onHandlerCallins((h) => window.Recoil.setHandlers(h));
  }
  await restoreDocs(s);
  const initial = await api.initialPaths();
  if (initial.length) await openPaths(initial);
  if (!docs.size) $('#empty').hidden = false;
  renderTabs();
  updateStatus();
  updateTitle();
});
})();
