'use strict';
// Builds a compact glossary of the Recoil engine Lua API from the LuaLS annotation
// files in https://github.com/beyond-all-reason/recoil-lua-library
//
// CLI:
//   node recoil-docs.js --fetch [out.json]          download latest from GitHub
//   node recoil-docs.js <library-folder> [out.json] parse a local checkout
const fs = require('fs');
const path = require('path');

const REPO = 'beyond-all-reason/recoil-lua-library';
const BRANCH = 'main';
const DEFAULT_OUT = path.join(__dirname, 'src', 'data', 'recoil-api.json');

// ---------- annotation parsing ----------

// Read one LuaLS type expression from the start of `s`; returns [type, rest].
function readType(s) {
  s = s.trimStart();
  let depth = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const ch = s[i];
    if ('(<{['.includes(ch)) depth++;
    else if (')>}]'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (/\s/.test(ch) && depth === 0) {
      const before = s.slice(0, i).trimEnd();
      const after = s.slice(i).trimStart();
      if (/[|,:]$/.test(before) || after.startsWith('|')) continue;
      break;
    }
  }
  return [s.slice(0, i).trim(), s.slice(i).trim()];
}

const cleanDesc = (s) => s.replace(/^#\s*/, '').trim();

function parseDoc(lines) {
  const d = { desc: [], params: [], returns: [], see: [], src: null, fields: [], overloads: [] };
  for (const l of lines) {
    const t = l.match(/^@(\w+)\s*(.*)$/);
    if (!t) { d.desc.push(l.replace(/^ /, '')); continue; }
    const [, tag, rest] = t;
    switch (tag) {
      case 'param': {
        const m = rest.match(/^(\S+)\s*(.*)$/);
        if (!m) break;
        const [type, desc] = readType(m[2]);
        d.params.push({ n: m[1], t: type, d: cleanDesc(desc) });
        break;
      }
      case 'return': {
        const [type, rest2] = readType(rest);
        const m = rest2.match(/^([A-Za-z_]\w*\??)(?:\s+(.*))?$/);
        if (m && !rest2.startsWith('#')) d.returns.push({ t: type, n: m[1], d: cleanDesc(m[2] || '') });
        else d.returns.push({ t: type, n: '', d: cleanDesc(rest2) });
        break;
      }
      case 'see': {
        const m = rest.match(/^\[([^\]]+)\]\(([^)]+)\)/);
        if (m && /\.(cpp|h|hpp|c)#L/.test(m[1]) && !d.src) d.src = m[2];
        else if (m) d.see.push(`[${m[1]}](${m[2]})`);
        else if (rest) d.see.push(rest);
        break;
      }
      case 'field': {
        const m = rest.replace(/^(public|private|protected|package)\s+/, '').match(/^(\S+)\s*(.*)$/);
        if (!m) break;
        const [type, desc] = readType(m[2]);
        d.fields.push({ n: m[1], t: type, d: cleanDesc(desc) });
        break;
      }
      case 'type': d.type = readType(rest)[0]; break;
      case 'class': {
        const m = rest.match(/^([\w.<>]+)\s*(?::\s*(.*))?$/);
        if (m) { d.class = m[1]; d.parents = m[2] ? m[2].split(',').map((x) => x.trim()) : []; }
        break;
      }
      case 'alias': {
        const m = rest.match(/^([\w.]+)\s*(.*)$/);
        if (m) { d.alias = m[1]; d.aliasType = m[2] || ''; }
        break;
      }
      case 'enum': d.enum = rest.trim(); break;
      case 'deprecated': d.deprecated = rest.trim() || true; break;
      case 'overload': d.overloads.push(rest.trim()); break;
      default: break; // @section, @x_helper, @meta, @generic, @nodiscard, ...
    }
  }
  // Pipe-style alias members (---| "value" # desc) end up as desc lines; keep them readable.
  d.desc = d.desc.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return d;
}

function compact(o) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v == null || v === '' || v === false || (Array.isArray(v) && !v.length)) delete o[k];
  }
  return o;
}

function parseFiles(files) {
  const entries = new Map();
  const types = new Map();
  const accessed = {};

  const registerType = (doc, declaredAs) => {
    const name = doc.class || doc.alias || doc.enum;
    if (!name) return;
    const prev = types.get(name);
    const t = prev || { n: name, k: doc.class ? 'class' : doc.alias ? 'alias' : 'enum' };
    if (doc.desc && !t.d) t.d = doc.desc;
    if (doc.parents && doc.parents.length) t.parents = doc.parents;
    if (doc.aliasType) t.t = doc.aliasType;
    if (doc.fields.length) t.fields = [...(t.fields || []), ...doc.fields];
    if (doc.src && !t.src) t.src = doc.src;
    if (declaredAs && declaredAs !== name) t.as = declaredAs;
    types.set(name, compact(t));
    const via = (doc.desc || '').match(/(?:Accessed via|Registered as)([^\n]*)/);
    if (via) for (const [, g] of via[1].matchAll(/`([\w.]+)`/g)) if (g !== name) accessed[g] = name;
  };

  const addFunction = (name, args, doc, file) => {
    doc = doc || parseDoc([]);
    const argNames = args.split(',').map((a) => a.trim()).filter(Boolean);
    const params = argNames.map((a) => {
      const p = doc.params.find((x) => x.n === a || x.n === a + '?');
      return compact({ n: a, t: p ? p.t : (a === '...' ? 'any' : ''), d: p ? p.d : '' });
    });
    // documented params not present in the arg list (rare) are appended
    for (const p of doc.params) if (!argNames.includes(p.n) && !argNames.includes(p.n.replace(/\?$/, ''))) params.push(compact({ ...p }));
    const variant = compact({
      d: doc.desc, p: params, r: doc.returns.map((r) => compact({ ...r })), src: doc.src,
      see: doc.see, dep: doc.deprecated, ov: doc.overloads,
    });
    const e = entries.get(name);
    if (e && e.k === 'f') e.v.push(variant);
    else entries.set(name, { n: name, k: 'f', v: [variant], f: file });
  };

  const addValue = (name, kind, value, doc, file) => {
    const e = compact({
      n: name, k: kind, t: doc && doc.type, val: value, d: doc && doc.desc, src: doc && doc.src,
      see: doc && doc.see, dep: doc && doc.deprecated, f: file,
    });
    const prev = entries.get(name);
    if (prev && prev.k !== 'f') Object.assign(prev, { ...e, d: e.d || prev.d, src: e.src || prev.src });
    else if (!prev) entries.set(name, e);
  };

  for (const { path: file, text } of files) {
    const lines = text.split(/\r?\n/);
    let block = null;
    const stack = [];
    const qualify = (n) => (stack.length ? stack[stack.length - 1] + '.' + n : n);
    // A description block separated from its ---@class block by a blank line is carried over.
    let orphan = null;
    const typeDoc = (d) => { if (!d.desc && orphan) d.desc = orphan; orphan = null; registerType(d); };
    const flush = () => {
      if (block) {
        const d = parseDoc(block);
        if (d.class || d.alias || d.enum) typeDoc(d);
        else orphan = d.desc || null;
      }
      block = null;
    };

    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('---')) {
        if (line === '---@meta' || /^---@meta\b/.test(line)) continue;
        (block = block || []).push(line.slice(3));
        continue;
      }
      if (line.startsWith('--')) continue;
      if (!line) { flush(); continue; }
      if (/^local\s/.test(line)) {
        if (block) { const d = parseDoc(block); if (d.class || d.alias || d.enum) typeDoc(d); }
        block = null;
        orphan = null;
        continue;
      }

      const doc = block ? parseDoc(block) : null;
      block = null;
      if (doc && !doc.desc && orphan && (doc.class || doc.enum)) doc.desc = orphan;
      orphan = null;
      let m;
      if ((m = line.match(/^function\s+([A-Za-z_][\w.]*[.:][A-Za-z_]\w*)\s*\(([^)]*)\)/))) {
        addFunction(m[1], m[2], doc, file);
      } else if ((m = line.match(/^function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/))) {
        addFunction(qualify(m[1]), m[2], doc, file);
      } else if ((m = line.match(/^\[?["']?([A-Za-z_][\w.]*)["']?\]?\s*=\s*\{\s*(\})?\s*,?\s*(--.*)?$/))) {
        const full = qualify(m[1]);
        addValue(full, 't', null, doc, file);
        if (doc && (doc.class || doc.enum)) registerType(doc, full);
        if (!m[2]) stack.push(full);
      } else if ((m = line.match(/^\[?["']?([A-Za-z_][\w.]*)["']?\]?\s*=\s*(.+?)\s*,?\s*(--.*)?$/))) {
        let val = m[2].replace(/,$/, '').trim();
        if (val === 'nil') val = null;
        addValue(qualify(m[1]), 'v', val, doc, file);
        if (doc && (doc.class || doc.alias || doc.enum)) registerType(doc, qualify(m[1]));
      } else if (/^\}/.test(line)) {
        stack.pop();
      } else if (doc && (doc.class || doc.alias || doc.enum)) {
        registerType(doc);
      }
    }
    flush();
  }

  // a table declared with a ---@class (e.g. `Spring = {}`) gets the class description
  for (const t of types.values()) {
    if (t.as && entries.has(t.as)) { const e = entries.get(t.as); if (!e.d && t.d) e.d = t.d; }
  }
  return {
    entries: [...entries.values()].sort((a, b) => a.n.localeCompare(b.n)),
    types: [...types.values()].sort((a, b) => a.n.localeCompare(b.n)),
    accessed,
  };
}

// ---------- sources ----------

function readFolder(dir) {
  const files = [];
  const lib = fs.existsSync(path.join(dir, 'library')) ? path.join(dir, 'library') : dir;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { if (!ent.name.startsWith('.')) walk(p); } else if (ent.name.endsWith('.lua')) {
        files.push({ path: path.relative(lib, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') });
      }
    }
  };
  walk(lib);
  return files;
}

async function fetchLibrary(fetchFn = fetch) {
  const res = await fetchFn(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'coiledit' },
  });
  if (!res.ok) throw new Error(`GitHub API: ${res.status} ${res.statusText}`);
  const tree = await res.json();
  const paths = tree.tree.filter((t) => t.type === 'blob' && t.path.startsWith('library/') && t.path.endsWith('.lua')).map((t) => t.path);
  if (!paths.length) throw new Error('No .lua files found in the repository.');
  const files = await Promise.all(paths.map(async (p) => {
    const r = await fetchFn(`https://raw.githubusercontent.com/${REPO}/${tree.sha}/${p}`);
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    return { path: p.replace(/^library\//, ''), text: await r.text() };
  }));
  return { files, rev: tree.sha };
}

function build(files, source, rev) {
  const db = parseFiles(files);
  return { v: 1, source, rev: rev || null, built: new Date().toISOString(), ...db };
}

async function updateFromGitHub(fetchFn) {
  const { files, rev } = await fetchLibrary(fetchFn);
  return build(files, `github.com/${REPO}`, rev);
}

function buildFromFolder(dir) {
  const files = readFolder(dir);
  if (!files.length) throw new Error('No .lua files found in that folder.');
  return build(files, dir);
}

// ---------- widget/gadget handler call-ins ----------
// Games dispatch extra call-ins from their Lua handlers (luaui/barwidgets.lua,
// luarules/gadgets.lua, ...). They are listed in tables like `callInLists = { "Name", ... }`.

function extractHandlerCallins(text) {
  const names = new Set();
  const re = /\b(\w*call\w*ins?\w*)\s*=\s*\{/gi;
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex, depth = 1;
    const start = i;
    while (i < text.length && depth) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    const body = text.slice(start, i - 1).replace(/--[^\n]*/g, '');
    for (const s of body.matchAll(/["']([A-Za-z_]\w*)["']/g)) names.add(s[1]);
  }
  // later additions: callInLists[#callInLists + 1] = "Name"
  for (const s of text.matchAll(/\w*call\w*ins?\w*\s*\[\s*#\s*\w+\s*\+\s*1\s*\]\s*=\s*["']([A-Za-z_]\w*)["']/gi)) names.add(s[1]);
  return names;
}

function scanHandlers(dir, source) {
  const seen = new Set();
  const out = { v: 1, source: source || dir, built: new Date().toISOString(), widget: new Set(), gadget: new Set(), files: [] };
  for (const sub of ['', 'luaui', 'LuaUI', 'luarules', 'LuaRules']) {
    const d = path.join(dir, sub);
    let list;
    try { list = fs.readdirSync(d); } catch { continue; }
    for (const f of list) {
      if (!f.toLowerCase().endsWith('.lua')) continue;
      const p = path.join(d, f);
      const key = path.resolve(p).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (!/callInLists|CallInsList/i.test(text)) continue;
      const names = extractHandlerCallins(text);
      if (!names.size) continue;
      const kind = /gadget|luarules/i.test(path.relative(dir, p)) ? 'gadget' : 'widget';
      names.forEach((n) => out[kind].add(n));
      out.files.push(path.relative(dir, p).replace(/\\/g, '/'));
    }
  }
  if (!out.files.length) throw new Error('No widget/gadget handler found (looked in luaui/ and luarules/ for files with a callInLists table).');
  out.widget = [...out.widget].sort();
  out.gadget = [...out.gadget].sort();
  return out;
}

const DEFAULT_HANDLERS_OUT = path.join(__dirname, 'src', 'data', 'handler-callins.json');

module.exports = { parseFiles, updateFromGitHub, buildFromFolder, scanHandlers, DEFAULT_OUT };

if (require.main === module) {
  (async () => {
    const [arg, out = DEFAULT_OUT] = process.argv.slice(2);
    if (!arg) { console.error('usage: node recoil-docs.js --fetch|<library-folder> [out.json]\n       node recoil-docs.js --handlers <game-folder> [label] [out.json]'); process.exit(1); }
    if (arg === '--handlers') {
      const [, dir, label, hout = DEFAULT_HANDLERS_OUT] = process.argv.slice(2);
      const h = scanHandlers(dir, label);
      fs.mkdirSync(path.dirname(hout), { recursive: true });
      fs.writeFileSync(hout, JSON.stringify(h));
      console.log(`${h.widget.length} widget + ${h.gadget.length} gadget call-ins from ${h.files.join(', ')} -> ${hout}`);
      return;
    }
    const db = arg === '--fetch' ? await updateFromGitHub() : buildFromFolder(arg);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(db));
    const fns = db.entries.filter((e) => e.k === 'f').length;
    console.log(`${db.entries.length} entries (${fns} functions), ${db.types.length} types -> ${out}`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
