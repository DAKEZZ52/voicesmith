'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const channels = ['phase', 'log', 'download-progress', 'install-progress', 'batch:item', 'batch:done',
  'train:step', 'train:log', 'train:epoch', 'updater'];

contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('state'),
  boot: () => ipcRenderer.invoke('boot'),
  voices: () => ipcRenderer.invoke('voices'),
  refs: () => ipcRenderer.invoke('refs'),
  importRef: () => ipcRenderer.invoke('import-ref'),
  updateRefText: (payload) => ipcRenderer.invoke('update-ref-text', payload),
  selectVoice: (payload) => ipcRenderer.invoke('select-voice', payload),
  tts: (payload) => ipcRenderer.invoke('tts', payload),
  batchRun: (payload) => ipcRenderer.invoke('batch-run', payload),
  batchCancel: () => ipcRenderer.invoke('batch-cancel'),
  batchExport: (payload) => ipcRenderer.invoke('batch-export', payload),
  readAudio: (payload) => ipcRenderer.invoke('read-audio', payload),
  trimRef: (payload) => ipcRenderer.invoke('trim-ref', payload),
  pickTrainDir: () => ipcRenderer.invoke('train:list-audio'),
  trainInspect: (payload) => ipcRenderer.invoke('train:inspect', payload),
  trainPrepare: (payload) => ipcRenderer.invoke('train:prepare', payload),
  trainStart: (payload) => ipcRenderer.invoke('train:start', payload),
  trainCancel: () => ipcRenderer.invoke('train:cancel'),
  updaterState: () => ipcRenderer.invoke('updater:state'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  pickPayload: () => ipcRenderer.invoke('pick-payload'),
  downloadModels: () => ipcRenderer.invoke('download-models'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openOutput: () => ipcRenderer.invoke('open-output'),
  on: (channel, cb) => {
    if (!channels.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
