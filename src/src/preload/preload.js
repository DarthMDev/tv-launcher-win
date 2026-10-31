// The only functions the launcher page can call. Passwords go straight to the
// main process (only a password saved with "Remember password" comes back,
// to fill in the form); tokens never come back to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (changes) => ipcRenderer.invoke('settings:save', changes),
  // rememberPassword: the "Remember password" box, ticked to keep a saved password.
  resetSettings: (rememberPassword) => ipcRenderer.invoke('settings:reset', { rememberPassword: rememberPassword === true }),
  chooseFolder: (startIn) => ipcRenderer.invoke('settings:chooseFolder', startIn),
  chooseFile: (startIn) => ipcRenderer.invoke('settings:chooseFile', startIn),
  checkStatus: () => ipcRenderer.invoke('status:check'),
  login: (username, password, rememberPassword) => ipcRenderer.invoke('auth:login', { username, password, rememberPassword: Boolean(rememberPassword) }),
  getSavedLogin: () => ipcRenderer.invoke('auth:savedLogin'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  play: () => ipcRenderer.invoke('game:play'),
  leaveLine: () => ipcRenderer.invoke('line:leave'),
  onLineUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('line:update', listener);
    return () => ipcRenderer.removeListener('line:update', listener);
  },
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  getNews: () => ipcRenderer.invoke('news:get'),
  checkUpdates: () => ipcRenderer.invoke('patcher:check'),
  update: (options) => ipcRenderer.invoke('patcher:update', options),
  cancelUpdate: () => ipcRenderer.invoke('patcher:cancel'),
  restartLauncher: () => ipcRenderer.invoke('launcher:restart'),
  openLogs: () => ipcRenderer.invoke('game:openLogs'),
  launcherUpdated: () => ipcRenderer.invoke('launcher:updated'),
  checkLauncher: () => ipcRenderer.invoke('launcher:check'),
  whatsNew: () => ipcRenderer.invoke('launcher:whatsNew'),
  onLauncherUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launcher:updated', listener);
    return () => ipcRenderer.removeListener('launcher:updated', listener);
  },
  onLauncherProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launcher:progress', listener);
    return () => ipcRenderer.removeListener('launcher:progress', listener);
  },
  onLauncherFailed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launcher:failed', listener);
    return () => ipcRenderer.removeListener('launcher:failed', listener);
  },
  onUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('patcher:progress', listener);
    return () => ipcRenderer.removeListener('patcher:progress', listener);
  },
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  onGameEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('game:event', listener);
    return () => ipcRenderer.removeListener('game:event', listener);
  },
});
