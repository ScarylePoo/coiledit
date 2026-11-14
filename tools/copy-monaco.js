// Copies the Monaco editor build into src/vendor so the app can be served as plain files.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const from = path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const to = path.join(root, 'src', 'vendor', 'monaco', 'vs');
if (!fs.existsSync(from)) { console.error('monaco-editor not installed; run npm install'); process.exit(1); }
const stamp = path.join(to, '.version');
const version = require(path.join(root, 'node_modules', 'monaco-editor', 'package.json')).version;
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === version) process.exit(0);
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
fs.writeFileSync(stamp, version);
console.log(`monaco-editor ${version} -> src/vendor/monaco`);
