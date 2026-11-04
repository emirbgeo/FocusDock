'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('focusdock', {
  getState: () => ipcRenderer.invoke('state:get'),
  addTask: (task) => ipcRenderer.invoke('task:add', task),
  updateTask: (id, patch) => ipcRenderer.invoke('task:update', id, patch),
  completeTask: (id) => ipcRenderer.invoke('task:complete', id),
  restoreTask: (id) => ipcRenderer.invoke('task:restore', id),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  reinsertTask: (task, where) => ipcRenderer.invoke('task:reinsert', task, where),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  ackAlert: (id) => ipcRenderer.invoke('inbox:ack', id),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  testAlert: () => ipcRenderer.invoke('app:test-alert'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data'),
  hide: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onState: listen('state'),
  onAlert: listen('alert'),
  onFocusInput: listen('focus-input'),
  onHighlight: listen('highlight'),
  onNotice: listen('notice'),
});
