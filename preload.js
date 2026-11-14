'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  writeFile: (p, text, enc) => ipcRenderer.invoke('write-file', p, text, enc),
  openDialog: (dir) => ipcRenderer.invoke('open-dialog', dir),
  saveDialog: (def) => ipcRenderer.invoke('save-dialog', def),
  confirmClose: (name) => ipcRenderer.invoke('confirm-close', name),
  confirmReload: (name) => ipcRenderer.invoke('confirm-reload', name),
  alert: (msg, detail) => ipcRenderer.invoke('alert', msg, detail),
  watch: (p) => ipcRenderer.send('watch', p),
  unwatch: (p) => ipcRenderer.send('unwatch', p),
  loadSession: () => ipcRenderer.invoke('session-load'),
  saveSession: (d) => ipcRenderer.send('session-save', d),
  saveSessionSync: (d) => ipcRenderer.sendSync('session-save-sync', d),
  initialPaths: () => ipcRenderer.invoke('initial-paths'),
  setTitle: (t) => ipcRenderer.send('set-title', t),
  reveal: (p) => ipcRenderer.send('reveal', p),
  tabMenu: (info) => ipcRenderer.send('tab-menu', info),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  onCommand: on('command'),
  onOpenPaths: on('open-paths'),
  onFileChanged: on('file-changed'),
  onTabAction: on('tab-action'),
  recoilDb: () => ipcRenderer.invoke('recoil-db'),
  onRecoilDb: on('recoil-db'),
  handlerCallins: () => ipcRenderer.invoke('handler-callins'),
  onHandlerCallins: on('handler-callins'),
});
