// Regenerates the bundled data snapshots in src/data/.
//   node tools/recoil-docs-cli.js --fetch [out.json]                 Recoil API from GitHub
//   node tools/recoil-docs-cli.js <recoil-lua-library> [out.json]    Recoil API from a checkout
//   node tools/recoil-docs-cli.js --handlers <game-folder> [label] [out.json]
'use strict';
const fs = require('fs');
const path = require('path');
const RecoilDocs = require('../src/recoil-docs.js');

const DATA = path.join(__dirname, '..', 'src', 'data');

function walkLua(dir) {
  const files = [];
  const lib = fs.existsSync(path.join(dir, 'library')) ? path.join(dir, 'library') : dir;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { if (!ent.name.startsWith('.')) walk(p); }
      else if (ent.name.endsWith('.lua')) files.push({ path: path.relative(lib, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(lib);
  return files;
}

function handlerFiles(dir) {
  const seen = new Set();
  const files = [];
  for (const sub of ['', 'luaui', 'LuaUI', 'luarules', 'LuaRules']) {
    let list;
    try { list = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const f of list) {
      if (!f.toLowerCase().endsWith('.lua')) continue;
      const p = path.join(dir, sub, f);
      const key = path.resolve(p).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ path: path.relative(dir, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') });
    }
  }
  return files;
}

function write(out, data) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data));
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--handlers') {
    const [, dir, label, out = path.join(DATA, 'handler-callins.json')] = args;
    const h = RecoilDocs.buildHandlers(handlerFiles(dir), label || path.basename(path.resolve(dir)));
    write(out, h);
    console.log(`${h.widget.length} widget + ${h.gadget.length} gadget call-ins from ${h.files.join(', ')} -> ${out}`);
    return;
  }
  const [src, out = path.join(DATA, 'recoil-api.json')] = args;
  if (!src) { console.error('usage: see header of tools/recoil-docs-cli.js'); process.exit(1); }
  const db = src === '--fetch'
    ? await RecoilDocs.updateFromGitHub()
    : RecoilDocs.build(walkLua(src), path.resolve(src));
  write(out, db);
  console.log(`${db.entries.length} entries (${db.entries.filter((e) => e.k === 'f').length} functions), ${db.types.length} types -> ${out}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
