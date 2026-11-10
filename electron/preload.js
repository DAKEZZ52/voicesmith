'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const channels = ['phase', 'log', 'download-progress', 'install-progress', 'batch:item', 'batch:done',
  'train:step', 'train:log', 'train:epoch', 'updater', 'book:progress', 'book:chapter', 'book:export', 'sing:progress', 'rvc:progress'];

contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('state'),
  boot: () => ipcRenderer.invoke('boot'),
  voices: () => ipcRenderer.invoke('voices'),
  refs: () => ipcRenderer.invoke('refs'),
  importRef: () => ipcRenderer.invoke('import-ref'),
  pickTextFile: () => ipcRenderer.invoke('pick-text'),
  deleteRef: (payload) => ipcRenderer.invoke('refs:delete', payload),
  tidyRefs: () => ipcRenderer.invoke('refs:tidy'),
  listModels: () => ipcRenderer.invoke('models:list'),
  deleteModel: (payload) => ipcRenderer.invoke('models:delete', payload),
  listOutputs: () => ipcRenderer.invoke('outputs:list'),
  deleteOutput: (payload) => ipcRenderer.invoke('outputs:delete', payload),
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
  bookParse: (payload) => ipcRenderer.invoke('book:parse', payload),
  bookStart: (payload) => ipcRenderer.invoke('book:start', payload),
  bookStop: () => ipcRenderer.invoke('book:stop'),
  bookList: () => ipcRenderer.invoke('book:list'),
  pickAudio: () => ipcRenderer.invoke('pick-audio'),
  rvcInfo: () => ipcRenderer.invoke('rvc:info'),
  rvcConvert: (payload) => ipcRenderer.invoke('rvc:convert', payload),
  rvcCancel: () => ipcRenderer.invoke('rvc:cancel'),
  singStart: (payload) => ipcRenderer.invoke('sing:start', payload),
  singCancel: () => ipcRenderer.invoke('sing:cancel'),
  bookDetail: (payload) => ipcRenderer.invoke('book:detail', payload),
  bookResume: (payload) => ipcRenderer.invoke('book:resume', payload),
  bookState: () => ipcRenderer.invoke('book:state'),
  updaterState: () => ipcRenderer.invoke('updater:state'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  pickPayload: () => ipcRenderer.invoke('pick-payload'),
  downloadModels: () => ipcRenderer.invoke('download-models'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  logPath: () => ipcRenderer.invoke('log-path'),
  openOutput: () => ipcRenderer.invoke('open-output'),
  openPath: (payload) => ipcRenderer.invoke('open-path', payload),
  openDir: (payload) => ipcRenderer.invoke('open-dir', payload),
  on: (channel, cb) => {
    if (!channels.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
