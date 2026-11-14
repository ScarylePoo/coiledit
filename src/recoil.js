/* global monaco */
// Recoil engine Lua API: hover docs, completion and signature help for Lua files.
(() => {
'use strict';

const byName = new Map();   // canonical name ("Spring.GetUnitPosition", "Callins.UnitCreated") -> entry
const members = new Map();  // owner -> [entry]
const callins = new Map();  // "UnitCreated" -> entry
const types = new Map();    // "UnitID" -> type
const roots = [];           // top-level global tables
let accessed = {};          // "Spring.MoveCtrl" -> "MoveCtrl"
let info = null;
let registered = false;
let tokensChanged = null; // monaco.Emitter, created on first register

// Call-ins dispatched by the game's widget/gadget handler rather than the engine.
const handlers = { widget: new Set(), gadget: new Set(), source: null };
const LIFECYCLE = {
  GetInfo: 'Returns the info table the handler uses to list and load this addon: `name`, `desc`, `author`, `date`, `license`, `layer`, `enabled`, `handler`, …',
  GetConfigData: 'Return a table of settings to persist. The widget handler saves it to its config file.',
  SetConfigData: 'Receives the table previously returned by `GetConfigData`, before `Initialize`.',
};
function handlerKinds(name) {
  const k = [];
  if (handlers.widget.has(name) || name in LIFECYCLE) k.push('widget');
  if (handlers.gadget.has(name) || name === 'GetInfo') k.push('gadget');
  return k;
}
function isHandlerCallin(owner, name) {
  if (callins.has(name)) return false;
  const k = handlerKinds(name);
  return owner === 'addon' ? k.length > 0 : k.includes(owner);
}
function setHandlers(data) {
  handlers.widget = new Set((data && data.widget) || []);
  handlers.gadget = new Set((data && data.gadget) || []);
  handlers.source = data ? data.source : null;
  if (tokensChanged) tokensChanged.fire();
}

const norm = (s) => s.replace(/\s+/g, '').replace(/:/g, '.');
const lastSegment = (n) => n.slice(Math.max(n.lastIndexOf('.'), n.lastIndexOf(':')) + 1);
const CALLIN_OWNERS = /^(Callins|SyncedCallins|UnsyncedCallins)[.:]/;

function setData(db) {
  byName.clear(); members.clear(); callins.clear(); types.clear(); roots.length = 0;
  accessed = {};
  info = null;
  if (!db || !Array.isArray(db.entries)) return;
  info = { source: db.source, built: db.built, rev: db.rev, count: db.entries.length };
  accessed = db.accessed || {};
  const owners = new Set();
  for (const e of db.entries) {
    const key = norm(e.n);
    byName.set(key, e);
    const i = Math.max(e.n.lastIndexOf('.'), e.n.lastIndexOf(':'));
    if (i > 0) {
      const owner = norm(e.n.slice(0, i));
      if (!members.has(owner)) members.set(owner, []);
      members.get(owner).push(e);
      owners.add(owner.split('.')[0]);
    }
    if (e.k === 'f' && CALLIN_OWNERS.test(e.n)) callins.set(lastSegment(e.n), e);
  }
  for (const t of db.types || []) types.set(t.n, t);
  for (const e of db.entries) if (e.k === 't' && !e.n.includes('.')) roots.push(e);
  if (!registered) register();
  else if (tokensChanged) tokensChanged.fire();
}

// ---------- name resolution ----------
const aliasCache = new WeakMap();

function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

// `local spGetUnitPosition = Spring.GetUnitPosition` style aliases in the current file
function aliasesFor(model) {
  const v = model.getVersionId();
  const c = aliasCache.get(model);
  if (c && c.v === v) return c.map;
  const map = new Map();
  const text = model.getValue();
  const re = /^[ \t]*local[ \t]+([A-Za-z_][\w \t,]*?)[ \t]*=[ \t]*([^\r\n]+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const names = m[1].split(',').map((s) => s.trim());
    const vals = splitTop(m[2].replace(/--.*$/, '')).map((s) => s.trim());
    names.forEach((n, i) => {
      const val = vals[i];
      if (val && val !== n && /^[A-Za-z_]\w*(?:\s*[.:]\s*[A-Za-z_]\w*)*$/.test(val)) map.set(n, norm(val));
    });
  }
  aliasCache.set(model, { v, map });
  return map;
}

// Rewrite an expression to the name used in the database (through local aliases and
// "accessed via" tables such as Spring.MoveCtrl -> MoveCtrl).
function canonical(expr, aliases, want) {
  let e = norm(expr);
  const seen = new Set();
  for (let step = 0; step < 8; step++) {
    if (want(e)) return e;
    let changed = false;
    for (const [from, to] of Object.entries(accessed)) {
      if (e === from || e.startsWith(from + '.')) { e = to + e.slice(from.length); changed = true; break; }
    }
    if (changed) continue;
    const parts = e.split('.');
    if (aliases && aliases.has(parts[0]) && !seen.has(parts[0])) {
      seen.add(parts[0]);
      e = aliases.get(parts[0]) + (parts.length > 1 ? '.' + parts.slice(1).join('.') : '');
      continue;
    }
    break;
  }
  return want(e) ? e : null;
}

function resolve(expr, aliases) {
  const m = expr.match(/^(?:widget|gadget|addon|self|GG|gadgetHandler|widgetHandler)\s*[:.]\s*(\w+)$/);
  if (m && callins.has(m[1])) return { entry: callins.get(m[1]), callin: true };
  const hm = expr.match(/^(widget|gadget|addon)\s*[:.]\s*(\w+)$/);
  if (hm && isHandlerCallin(hm[1], hm[2])) return { handler: { owner: hm[1], name: hm[2] } };
  const name = canonical(expr, aliases, (e) => byName.has(e));
  if (name) return { entry: byName.get(name), via: norm(expr) !== name ? expr : null };
  if (types.has(expr)) return { type: types.get(expr) };
  return null;
}

// ---------- markdown ----------
const code = (s) => '```lua\n' + s + '\n```';
const esc = (s) => String(s).replace(/([*_`\\[\]<>])/g, '\\$1');

function sigLabel(name, v) {
  const params = (v.p || []).map((p) => (p.t ? `${p.n}: ${p.t}` : p.n)).join(', ');
  let s = `function ${name}(${params})`;
  const r = (v.r || []).map((x) => (x.n ? `${x.n}: ${x.t}` : x.t));
  if (r.length) s += `\n  -> ${r.join(', ')}`;
  return s;
}

function displayName(e, callin) {
  return callin ? `widget:${lastSegment(e.n)}` : e.n;
}

function functionMarkdown(e, opts = {}) {
  const out = [];
  if (opts.via) out.push(`*${esc(opts.via)} → ${esc(e.n)}*`);
  if (opts.callin) out.push(`*Callin* · \`${esc(e.n.replace(/[.:].*/, ''))}\``);
  const variants = e.v.slice(0, 4);
  variants.forEach((v, i) => {
    if (i) out.push('---');
    out.push(code(sigLabel(displayName(e, opts.callin), v)));
    if (v.dep) out.push(`**Deprecated.** ${v.dep === true ? '' : v.dep}`);
    if (v.d) out.push(v.d);
    if (v.p && v.p.some((p) => p.d || p.t)) {
      out.push('**Parameters**\n\n' + v.p.map((p) => `- \`${p.n}\`${p.t ? ` *${esc(p.t)}*` : ''}${p.d ? ' — ' + p.d : ''}`).join('\n'));
    }
    if (v.r && v.r.length && v.r.some((r) => r.d)) {
      out.push('**Returns**\n\n' + v.r.map((r) => `- *${esc(r.t)}*${r.n ? ` \`${r.n}\`` : ''}${r.d ? ' — ' + r.d : ''}`).join('\n'));
    }
    if (v.ov && v.ov.length) out.push('**Overloads**\n\n' + v.ov.map((o) => '- `' + o + '`').join('\n'));
    const links = [];
    if (v.see && v.see.length) links.push('See ' + v.see.map((s) => (s.startsWith('[') ? s : '`' + s + '`')).join(', '));
    if (v.src) links.push(`[Engine source](${v.src})`);
    if (links.length) out.push(links.join(' · '));
  });
  if (e.v.length > variants.length) out.push(`*…and ${e.v.length - variants.length} more overloads*`);
  return out.join('\n\n');
}

function valueMarkdown(e, opts = {}) {
  const out = [];
  if (opts.via) out.push(`*${esc(opts.via)} → ${esc(e.n)}*`);
  let head = e.n;
  if (e.t) head += `: ${e.t}`;
  if (e.val != null && e.k === 'v') head += ` = ${e.val}`;
  if (e.k === 't') head = `${e.n} = { … }`;
  out.push(code(head));
  if (e.dep) out.push(`**Deprecated.** ${e.dep === true ? '' : e.dep}`);
  const t = types.get(e.n);
  if (e.d) out.push(e.d);
  else if (t && t.d) out.push(t.d);
  if (e.k === 't') {
    const ms = members.get(norm(e.n)) || [];
    if (ms.length) out.push(`*${ms.length} members — type \`${esc(e.n)}.\` to list them*`);
  }
  const links = [];
  if (e.see && e.see.length) links.push('See ' + e.see.map((s) => (s.startsWith('[') ? s : '`' + s + '`')).join(', '));
  if (e.src) links.push(`[Engine source](${e.src})`);
  if (links.length) out.push(links.join(' · '));
  return out.join('\n\n');
}

function typeMarkdown(t) {
  const out = [];
  if (t.k === 'alias') out.push(code(`---@alias ${t.n} ${t.t || ''}`));
  else out.push(code(`---@${t.k} ${t.n}${t.parents ? ' : ' + t.parents.join(', ') : ''}`));
  if (t.d) out.push(t.d);
  if (t.fields && t.fields.length) {
    const f = t.fields.slice(0, 40).map((x) => `- \`${x.n}\` *${esc(x.t)}*${x.d ? ' — ' + x.d : ''}`);
    if (t.fields.length > 40) f.push(`- *…${t.fields.length - 40} more*`);
    out.push('**Fields**\n\n' + f.join('\n'));
  }
  if (t.src) out.push(`[Engine source](${t.src})`);
  return out.join('\n\n');
}

function handlerMarkdown(h) {
  const kinds = handlerKinds(h.name);
  const out = [code(`function ${h.owner}:${h.name}(...)`)];
  out.push(`*Handler call-in* · dispatched by the ${kinds.join(' and ')} handler${kinds.length > 1 ? 's' : ''}, not the engine`);
  if (LIFECYCLE[h.name]) out.push(LIFECYCLE[h.name]);
  if (handlers.source && !LIFECYCLE[h.name]) out.push(`From ${esc(handlers.source)}`);
  return out.join('\n\n');
}

function markdownFor(r) {
  if (r.type) return typeMarkdown(r.type);
  if (r.handler) return handlerMarkdown(r.handler);
  return r.entry.k === 'f' ? functionMarkdown(r.entry, r) : valueMarkdown(r.entry, r);
}

// ---------- providers ----------
function exprAt(model, position) {
  const w = model.getWordAtPosition(position);
  if (!w) return null;
  const line = model.getLineContent(position.lineNumber);
  let s = w.startColumn - 1;
  for (;;) {
    let j = s;
    while (j > 0 && /\s/.test(line[j - 1])) j--;
    if (j === 0 || !/[.:]/.test(line[j - 1])) break;
    let k = j - 1;
    while (k > 0 && /\s/.test(line[k - 1])) k--;
    let st = k;
    while (st > 0 && /\w/.test(line[st - 1])) st--;
    if (st === k) break;
    s = st;
  }
  return {
    text: line.slice(s, w.endColumn - 1),
    range: new monaco.Range(position.lineNumber, s + 1, position.lineNumber, w.endColumn),
  };
}

function hoverProvider() {
  return {
    provideHover(model, position) {
      const x = exprAt(model, position);
      if (!x) return null;
      // inside a comment? still allow — LuaLS-style docs often mention API names
      const r = resolve(x.text, aliasesFor(model));
      if (!r) return null;
      return { range: x.range, contents: [{ value: markdownFor(r), supportThemeIcons: false }] };
    },
  };
}

function kindOf(e) {
  const K = monaco.languages.CompletionItemKind;
  if (e.k === 'f') return K.Function;
  if (e.k === 't') return K.Module;
  return /^[A-Z0-9_]+$/.test(lastSegment(e.n)) ? K.Constant : K.Field;
}

function shortDetail(e) {
  if (e.k === 'f') {
    const v = e.v[0];
    const r = (v.r || []).map((x) => x.t);
    return `(${(v.p || []).map((p) => p.n).join(', ')})${r.length ? ' → ' + r.join(', ') : ''}`;
  }
  if (e.k === 'v') return [e.t, e.val != null ? '= ' + e.val : ''].filter(Boolean).join(' ');
  return 'table';
}

function completionProvider() {
  return {
    triggerCharacters: ['.', ':'],
    provideCompletionItems(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const doc = (e) => ({ value: e.k === 'f' ? functionMarkdown(e) : valueMarkdown(e) });

      // function widget:|  -> callins with their parameters
      const fm = before.match(/\bfunction\s+(widget|gadget|addon)\s*:\s*\w*$/);
      if (fm) {
        const owner = fm[1];
        const extra = [...new Set([...handlers.widget, ...handlers.gadget, ...Object.keys(LIFECYCLE)])]
          .filter((n) => isHandlerCallin(owner, n))
          .map((n) => ({
            label: n, kind: monaco.languages.CompletionItemKind.Event, detail: 'handler call-in',
            documentation: { value: handlerMarkdown({ owner, name: n }) }, insertText: `${n}()`, range,
          }));
        return {
          suggestions: extra.concat([...callins.values()].map((e) => {
            const name = lastSegment(e.n);
            const params = (e.v[0].p || []).map((p) => p.n).join(', ');
            return {
              label: name, kind: monaco.languages.CompletionItemKind.Event, detail: `(${params})`,
              documentation: { value: functionMarkdown(e, { callin: true }) },
              insertText: `${name}(${params})`, range,
            };
          })),
        };
      }

      const m = before.match(/([A-Za-z_]\w*(?:\s*[.:]\s*[A-Za-z_]\w*)*)\s*[.:]\s*\w*$/);
      if (m) {
        const owner = canonical(m[1], aliasesFor(model), (e) => members.has(e));
        if (!owner) return { suggestions: [] };
        return {
          suggestions: members.get(owner).map((e) => ({
            label: lastSegment(e.n), kind: kindOf(e), detail: shortDetail(e), documentation: doc(e),
            insertText: lastSegment(e.n), range, tags: e.dep || (e.v && e.v[0].dep) ? [1] : [],
          })),
        };
      }
      if (!word.word) return { suggestions: [] };
      return {
        suggestions: roots.map((e) => ({ label: e.n, kind: kindOf(e), detail: 'Recoil', documentation: doc(e), insertText: e.n, range })),
      };
    },
  };
}

function signatureProvider() {
  return {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    provideSignatureHelp(model, position) {
      const end = model.getOffsetAt(position);
      const startPos = model.getPositionAt(Math.max(0, end - 4000));
      const text = model.getValueInRange(new monaco.Range(startPos.lineNumber, startPos.column, position.lineNumber, position.column));
      let depth = 0, commas = 0, i = text.length - 1, quote = null;
      for (; i >= 0; i--) {
        const ch = text[i];
        if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (')]}'.includes(ch)) depth++;
        else if ('([{'.includes(ch)) {
          if (depth === 0) { if (ch === '(') break; return null; }
          depth--;
        } else if (ch === ',' && depth === 0) commas++;
        else if (ch === '\n' && /\b(end|then|do)\s*$/.test(text.slice(0, i))) return null;
      }
      if (i < 0) return null;
      const m = text.slice(0, i).match(/([A-Za-z_]\w*(?:\s*[.:]\s*[A-Za-z_]\w*)*)\s*$/);
      if (!m) return null;
      const r = resolve(m[1], aliasesFor(model));
      if (!r || !r.entry || r.entry.k !== 'f') return null;
      const e = r.entry;
      const signatures = e.v.map((v) => {
        const parts = (v.p || []).map((p) => (p.t ? `${p.n}: ${p.t}` : p.n));
        let label = `${r.callin ? lastSegment(e.n) : e.n}(`;
        const parameters = parts.map((p, k) => {
          const s = label.length;
          label += p + (k < parts.length - 1 ? ', ' : '');
          const pd = v.p[k];
          return { label: [s, s + p.length], documentation: pd.d ? { value: pd.d } : undefined };
        });
        label += ')';
        const r2 = (v.r || []).map((x) => x.t);
        if (r2.length) label += ' -> ' + r2.join(', ');
        return { label, parameters, documentation: v.d ? { value: v.d } : undefined };
      });
      let active = signatures.findIndex((s) => s.parameters.length > commas);
      if (active < 0) active = 0;
      return { value: { signatures, activeSignature: active, activeParameter: commas }, dispose() {} };
    },
  };
}

// ---------- semantic colouring ----------
const TOKEN_TYPES = ['recoilNamespace', 'recoilCallout', 'recoilCallin', 'recoilConstant', 'recoilHandler'];
const T_NS = 0, T_CALLOUT = 1, T_CALLIN = 2, T_CONST = 3, T_HANDLER = 4;
const HANDLERS = new Set(['widget', 'gadget', 'addon']);

// Walk the Lua source, skipping strings, comments and numbers, and yield dotted name
// chains like `Spring . GetUnitPosition` as [{ name, offset, sep }].
function* chains(text) {
  const n = text.length;
  const isStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isWord = (c) => isStart(c) || (c >= '0' && c <= '9');
  const longBracket = (i) => { // at '[', returns level or -1
    let j = i + 1, lvl = 0;
    while (text[j] === '=') { lvl++; j++; }
    return text[j] === '[' ? lvl : -1;
  };
  const skipLong = (i, lvl) => {
    const close = ']' + '='.repeat(lvl) + ']';
    const k = text.indexOf(close, i);
    return k < 0 ? n : k + close.length;
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      if (text[i + 2] === '[') { const lvl = longBracket(i + 2); if (lvl >= 0) { i = skipLong(i + 2, lvl); continue; } }
      const k = text.indexOf('\n', i);
      i = k < 0 ? n : k + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '[') { const lvl = longBracket(i); if (lvl >= 0) { i = skipLong(i, lvl); continue; } i++; continue; }
    if (c >= '0' && c <= '9') { while (i < n && (isWord(text[i]) || text[i] === '.')) i++; continue; }
    if (isStart(c)) {
      const segs = [];
      let j = i, sep = '';
      for (;;) {
        const st = j;
        while (j < n && isWord(text[j])) j++;
        segs.push({ name: text.slice(st, j), offset: st, sep });
        let k = j;
        while (text[k] === ' ' || text[k] === '\t') k++;
        const d = text[k];
        if ((d === '.' && text[k + 1] !== '.') || (d === ':' && text[k + 1] !== ':')) {
          let m = k + 1;
          while (text[m] === ' ' || text[m] === '\t') m++;
          if (isStart(text[m])) { sep = d; j = m; continue; }
        }
        break;
      }
      yield segs;
      i = j;
      continue;
    }
    i++;
  }
}

// Token type for each segment of a chain (or null), using the longest prefix that is a
// known engine name.
function classify(segs, aliases) {
  const out = new Array(segs.length).fill(null);
  if (segs.length === 2 && HANDLERS.has(segs[0].name)) {
    if (callins.has(segs[1].name)) { out[1] = T_CALLIN; return out; }
    if (isHandlerCallin(segs[0].name, segs[1].name)) { out[1] = T_HANDLER; return out; }
  }
  for (let len = segs.length; len >= 1; len--) {
    const expr = segs.slice(0, len).map((x) => x.name).join('.');
    const name = canonical(expr, aliases, (e) => byName.has(e));
    if (!name) continue;
    const e = byName.get(name);
    for (let k = 0; k < len - 1; k++) out[k] = T_NS;
    out[len - 1] = e.k === 'f' ? T_CALLOUT : e.k === 'v' ? T_CONST : T_NS;
    return out;
  }
  return out;
}

function semanticProvider() {
  return {
    onDidChange: tokensChanged.event,
    getLegend: () => ({ tokenTypes: TOKEN_TYPES, tokenModifiers: [] }),
    provideDocumentSemanticTokens(model) {
      const data = [];
      if (!byName.size) return { data: new Uint32Array(0) };
      const aliases = aliasesFor(model);
      const text = model.getValue();
      let prevLine = 0, prevCol = 0;
      for (const segs of chains(text)) {
        const types = classify(segs, aliases);
        segs.forEach((seg, k) => {
          if (types[k] == null) return;
          const pos = model.getPositionAt(seg.offset);
          const line = pos.lineNumber - 1, col = pos.column - 1;
          data.push(line - prevLine, line === prevLine ? col - prevCol : col, seg.name.length, types[k], 0);
          prevLine = line;
          prevCol = col;
        });
      }
      return { data: new Uint32Array(data) };
    },
    releaseDocumentSemanticTokens() {},
  };
}

function register() {
  registered = true;
  tokensChanged = new monaco.Emitter();
  monaco.languages.registerDocumentSemanticTokensProvider('lua', semanticProvider());
  monaco.languages.registerHoverProvider('lua', hoverProvider());
  monaco.languages.registerCompletionItemProvider('lua', completionProvider());
  monaco.languages.registerSignatureHelpProvider('lua', signatureProvider());
}

// For a searchable lookup list: every documented name.
function allItems() {
  return [...byName.values()].map((e) => ({ name: e.n, entry: e }));
}

window.Recoil = { setData, setHandlers, info: () => info, allItems, markdownFor: (e) => markdownFor({ entry: e }) };
})();
