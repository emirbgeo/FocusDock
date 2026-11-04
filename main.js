'use strict';
/*
 * FocusDock main process.
 * Owns the data, the window placement (AppBar dock on the chosen monitor),
 * the tray, the global shortcut and the deadline alert scheduler.
 */
const {
  app, BrowserWindow, screen, ipcMain, Notification, Tray, Menu,
  nativeImage, shell, globalShortcut, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const core = require('./src/core');
const { AppBar } = require('./src/appbar');

const APP_ID = 'com.emirbalkan.focusdock';
const ASSETS = path.join(__dirname, 'assets');
const ICON_PNG = path.join(ASSETS, 'icon.png');
const ICON_ICO = path.join(ASSETS, 'icon.ico');
const TRAY_ICON = path.join(ASSETS, process.platform === 'win32' ? 'tray.ico' : 'tray.png');

app.setName('FocusDock');
// The interface speaks British English: 24 hour clock and day/month dates in pickers.
app.commandLine.appendSwitch('lang', 'en-GB');
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

/* ---------------------------------------------------------------- logging */

let logFile = null;
function log(msg) {
  try {
    if (!logFile) logFile = path.join(app.getPath('userData'), 'focusdock.log');
    const line = new Date().toISOString() + '  ' + msg + '\n';
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 256 * 1024) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, line);
  } catch (_) { /* logging must never crash the app */ }
}

/* ------------------------------------------------------------------ store */

const store = {
  dir: null,
  file: null,
  state: null,
  timer: null,

  load() {
    this.dir = app.getPath('userData');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'focusdock-data.json');
    const bak = path.join(this.dir, 'focusdock-data.bak.json');
    let raw = null;
    for (const f of [this.file, bak]) {
      try {
        if (fs.existsSync(f)) {
          raw = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (f === this.file) fs.copyFileSync(f, bak); // one good backup per launch
          else log('Main data file unreadable; restored from backup.');
          break;
        }
      } catch (err) {
        log('Could not read ' + f + ': ' + err.message);
      }
    }
    this.state = core.migrate(raw);
    return this.state;
  },

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 250);
  },

  saveNow() {
    clearTimeout(this.timer);
    if (!this.state || !this.file) return;
    const json = JSON.stringify(this.state, null, 1);
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log('Atomic save failed (' + err.message + '); writing directly.');
      try { fs.writeFileSync(this.file, json); } catch (e2) { log('Save failed: ' + e2.message); }
    }
  },
};

/* ---------------------------------------------------------- app lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const state = store.load();
  if (!state.settings.gpuAcceleration) app.disableHardwareAcceleration();
  app.on('second-instance', () => showPanel(true));
  app.whenReady().then(boot);
}

let win = null;
let tray = null;
let appbar = null;
let quitting = false;
let panelVisible = true;
let fullscreenActive = false;
let runtimeMode = null;  // mode actually in use (may differ from setting after a fallback)
let lastDockKey = '';
let dockLog = [];
const liveToasts = new Set();

const S = () => store.state.settings;

function boot() {
  createWindow();
  createTray();
  registerShortcut();
  applyLoginItem();
  ensureDevShortcut();

  screen.on('display-added', () => scheduleReposition(true));
  screen.on('display-removed', () => scheduleReposition(true));
  screen.on('display-metrics-changed', () => scheduleReposition(false));

  powerMonitor.on('resume', () => { scheduleReposition(true); setTimeout(checkAlerts, 3000); });
  powerMonitor.on('unlock-screen', () => setTimeout(checkAlerts, 1500));
  setInterval(checkAlerts, 30 * 1000);
  setInterval(updateTray, 60 * 1000);
  log('Started ' + app.getVersion() + ' (packaged=' + app.isPackaged + ', gpu=' + S().gpuAcceleration + ')');
}

app.on('before-quit', () => {
  quitting = true;
  if (appbar) appbar.remove();
  store.saveNow();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

/* ----------------------------------------------------------------- window */

function createWindow() {
  win = new BrowserWindow({
    width: S().width,
    height: 900,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: 'FocusDock',
    backgroundColor: '#0E1830',
    icon: process.platform === 'win32' ? ICON_ICO : ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    placeWindow(true);
    win.showInactive();
    setTimeout(checkAlerts, 2000);
  });

  // Closing (Alt+F4) hides to the tray; Quit lives in the tray menu.
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); hidePanel(); }
  });
  // Windows logoff or shutdown.
  win.on('session-end', () => { if (appbar) appbar.remove(); store.saveNow(); });

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('render-process-gone', (_e, d) => {
    log('Renderer gone: ' + d.reason + '; reloading.');
    setTimeout(() => win && !win.isDestroyed() && win.reload(), 1000);
  });
}

function displayList() {
  const all = screen.getAllDisplays();
  const leftmost = sortedDisplays()[0];
  return sortedDisplays().map((d, i) => ({
    id: String(d.id),
    label: 'Screen ' + (i + 1) + ' (' + d.size.width + '×' + d.size.height + (d.id === leftmost.id ? ', leftmost' : '') + ')',
    leftmost: d.id === leftmost.id,
    primary: d.id === screen.getPrimaryDisplay().id,
    scale: d.scaleFactor,
    count: all.length,
  }));
}

function sortedDisplays() {
  return screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

function targetDisplay() {
  const all = sortedDisplays();
  if (S().displayId !== 'leftmost') {
    const d = all.find((x) => String(x.id) === String(S().displayId));
    if (d) return d;
  }
  return all[0];
}

function setBoundsSafe(b) {
  const r = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  win.setBounds(r);
  // Moving between monitors with different scaling can land at the wrong size once.
  const got = win.getBounds();
  if (got.x !== r.x || got.y !== r.y || got.width !== r.width || got.height !== r.height) win.setBounds(r);
}

let repositionTimer = null;
function scheduleReposition(force) {
  clearTimeout(repositionTimer);
  repositionTimer = setTimeout(() => panelVisible && placeWindow(force), force ? 250 : 450);
}

function placeWindow(force) {
  if (!win || win.isDestroyed()) return;
  const d = targetDisplay();
  let mode = S().dockMode;

  if (mode === 'appbar' && process.platform === 'win32') {
    if (dockAppBar(d, force)) { runtimeMode = 'appbar'; broadcast(); return; }
    mode = 'ontop';
    notice('Could not reserve screen space, so the panel is floating on top instead. Details are in focusdock.log.');
  } else if (appbar && appbar.registered) {
    appbar.remove();
    lastDockKey = '';
    // The work area updates a moment after the strip is released.
    setTimeout(() => placeWindow(false), 300);
  }
  if (mode === 'appbar') mode = 'ontop'; // non-Windows

  const wa = d.workArea;
  const w = Math.min(S().width, wa.width);
  const x = S().edge === 'right' ? wa.x + wa.width - w : wa.x;
  setBoundsSafe({ x, y: wa.y, width: w, height: wa.height });
  win.setAlwaysOnTop(mode === 'ontop');
  runtimeMode = mode;
  broadcast();
}

function dockAppBar(d, force) {
  if (!AppBar.available()) {
    log('AppBar unavailable: ' + (AppBar.error() ? AppBar.error().message : 'unknown'));
    return false;
  }
  try {
    if (!appbar) {
      appbar = new AppBar(win, {
        onPosChanged: () => scheduleReposition(true),
        onFullscreen: (isFs) => {
          // Step out of the way of full screen games and videos.
          fullscreenActive = isFs;
          if (win && !win.isDestroyed()) win.setAlwaysOnTop(!isFs);
        },
        log,
      });
    }
    const phys = screen.dipToScreenRect(null, d.bounds);
    const physWork = screen.dipToScreenRect(null, d.workArea);
    const monitor = {
      left: phys.x,
      right: phys.x + phys.width,
      top: physWork.y,
      bottom: physWork.y + physWork.height,
    };
    const widthPx = Math.round(S().width * d.scaleFactor);
    const key = JSON.stringify([monitor.left, monitor.right, monitor.top, monitor.bottom, widthPx, S().edge, d.id]);
    if (!force && key === lastDockKey && appbar.registered) return true;

    // Back off if something keeps bouncing us (another app bar fighting for the edge).
    const now = Date.now();
    dockLog = dockLog.filter((t) => now - t < 4000);
    if (dockLog.length > 6) {
      log('Dock loop detected; pausing re-dock for 5 s.');
      setTimeout(() => { dockLog = []; }, 5000);
      return appbar.registered;
    }
    dockLog.push(now);

    const rc = appbar.dock(S().edge, monitor, widthPx);
    if (!rc) { log('ABM_NEW refused.'); return false; }
    lastDockKey = key;
    const dip = screen.screenToDipRect(null, {
      x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top,
    });
    setBoundsSafe(dip);
    win.setAlwaysOnTop(!fullscreenActive);
    return true;
  } catch (err) {
    log('AppBar dock failed: ' + (err && err.stack ? err.stack : err));
    return false;
  }
}

function hidePanel() {
  panelVisible = false;
  if (appbar) { appbar.remove(); lastDockKey = ''; }
  if (win && !win.isDestroyed()) win.hide();
  rebuildTrayMenu();
}

function showPanel(focus) {
  if (!win || win.isDestroyed()) return;
  const wasHidden = !panelVisible;
  panelVisible = true;
  if (wasHidden || !win.isVisible()) {
    win.showInactive();
    placeWindow(true);
  }
  if (focus) { win.show(); win.focus(); }
  rebuildTrayMenu();
}

/* ------------------------------------------------------------------- tray */

function createTray() {
  let img = nativeImage.createFromPath(TRAY_ICON);
  if (img.isEmpty()) img = nativeImage.createFromPath(ICON_PNG).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', () => { showPanel(true); send('focus-input'); });
  rebuildTrayMenu();
  updateTray();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const s = S();
  const displays = displayList();
  const menu = Menu.buildFromTemplate([
    panelVisible
      ? { label: 'Hide panel', click: hidePanel }
      : { label: 'Show panel', click: () => showPanel(false) },
    { label: 'Add a task', accelerator: s.shortcut, click: () => { showPanel(true); send('focus-input'); } },
    { type: 'separator' },
    {
      label: 'Placement',
      submenu: [
        { label: 'Reserve a strip (windows stop at its edge)', type: 'radio', checked: s.dockMode === 'appbar', click: () => applySettings({ dockMode: 'appbar' }) },
        { label: 'Float on top of other windows', type: 'radio', checked: s.dockMode === 'ontop', click: () => applySettings({ dockMode: 'ontop' }) },
        { label: 'Normal window', type: 'radio', checked: s.dockMode === 'float', click: () => applySettings({ dockMode: 'float' }) },
      ],
    },
    {
      label: 'Edge',
      submenu: [
        { label: 'Left edge', type: 'radio', checked: s.edge === 'left', click: () => applySettings({ edge: 'left' }) },
        { label: 'Right edge', type: 'radio', checked: s.edge === 'right', click: () => applySettings({ edge: 'right' }) },
      ],
    },
    {
      label: 'Screen',
      submenu: [
        { label: 'Leftmost screen (automatic)', type: 'radio', checked: s.displayId === 'leftmost', click: () => applySettings({ displayId: 'leftmost' }) },
        { type: 'separator' },
        ...displays.map((d) => ({
          label: d.label, type: 'radio', checked: s.displayId === d.id, click: () => applySettings({ displayId: d.id }),
        })),
      ],
    },
    { label: 'Start with Windows', type: 'checkbox', checked: loginEnabled(), click: (item) => applySettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: 'Open data folder', click: () => shell.openPath(store.dir) },
    { label: 'Quit FocusDock', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function updateTray() {
  if (!tray) return;
  const now = new Date();
  const over = store.state.tasks.filter((t) => core.urgency(t, now).level === 'over').length;
  const soon = store.state.tasks.filter((t) => ['hot', 'warm'].includes(core.urgency(t, now).level)).length;
  const bits = [store.state.tasks.length + ' open'];
  if (over) bits.push(over + ' overdue');
  if (soon) bits.push(soon + ' due within 3 days');
  tray.setToolTip('FocusDock: ' + bits.join(', '));
}

/* ------------------------------------------------------- settings & login */

function sanitizeSettings(s) {
  const d = core.DEFAULT_SETTINGS;
  const clamp = (v, lo, hi, def) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : def);
  return {
    ...s,
    edge: s.edge === 'right' ? 'right' : 'left',
    width: clamp(s.width, 280, 600, d.width),
    displayId: s.displayId ? String(s.displayId) : 'leftmost',
    dockMode: ['appbar', 'float', 'ontop'].includes(s.dockMode) ? s.dockMode : 'appbar',
    dailyGoal: clamp(s.dailyGoal, 1, 20, d.dailyGoal),
    sound: !!s.sound,
    volume: Math.min(1, Math.max(0, Number.isFinite(+s.volume) ? +s.volume : d.volume)),
    reduceMotion: !!s.reduceMotion,
    openAtLogin: s.openAtLogin === null ? null : !!s.openAtLogin,
    morningHour: clamp(s.morningHour, 0, 23, d.morningHour),
    gpuAcceleration: !!s.gpuAcceleration,
    shortcut: typeof s.shortcut === 'string' && s.shortcut ? s.shortcut : d.shortcut,
  };
}

function applySettings(patch) {
  const prev = { ...S() };
  store.state.settings = sanitizeSettings({ ...prev, ...patch });
  const s = S();
  if (['edge', 'width', 'displayId', 'dockMode'].some((k) => prev[k] !== s[k])) placeWindow(true);
  if (prev.openAtLogin !== s.openAtLogin) applyLoginItem();
  if (prev.shortcut !== s.shortcut) registerShortcut();
  if (prev.gpuAcceleration !== s.gpuAcceleration) notice('Graphics acceleration changes apply after you quit and reopen FocusDock.');
  commit();
  rebuildTrayMenu();
  return s;
}

function loginEnabled() {
  const v = S().openAtLogin;
  return v === null ? app.isPackaged : v;
}

function applyLoginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const opts = { openAtLogin: loginEnabled() };
  if (!app.isPackaged) {
    opts.path = process.execPath;
    opts.args = [path.resolve(app.getAppPath())];
  }
  try { app.setLoginItemSettings(opts); } catch (err) { log('Login item failed: ' + err.message); }
}

/**
 * Windows only shows toasts for apps that have a Start menu shortcut carrying
 * their AppUserModelID. The installer creates one; for `npm start` runs we
 * create a small "(dev)" shortcut so alerts work there too.
 */
function ensureDevShortcut() {
  if (process.platform !== 'win32' || app.isPackaged) return;
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'FocusDock (dev).lnk');
    if (fs.existsSync(lnk)) return;
    shell.writeShortcutLink(lnk, 'create', {
      target: process.execPath,
      args: '"' + path.resolve(app.getAppPath()) + '"',
      description: 'FocusDock (run from source)',
      icon: ICON_ICO,
      iconIndex: 0,
      appUserModelId: APP_ID,
    });
  } catch (err) {
    log('Dev shortcut failed: ' + err.message);
  }
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  try {
    const ok = globalShortcut.register(S().shortcut, () => { showPanel(true); send('focus-input'); });
    if (!ok) log('Shortcut ' + S().shortcut + ' is taken by another app.');
  } catch (err) {
    log('Shortcut error: ' + err.message);
  }
}

/* ----------------------------------------------------------------- alerts */

function checkAlerts() {
  const st = store.state;
  const now = new Date();
  const fired = core.collectDueAlerts(st.tasks, now, S().morningHour);
  if (!fired.length) { updateTray(); return; }
  const payload = [];
  for (const f of fired) {
    const t = st.tasks.find((x) => x.id === f.taskId);
    if (!t) continue;
    st.inbox = st.inbox.filter((a) => a.taskId !== f.taskId); // newest alert per task wins
    const item = { id: core.uid(), taskId: f.taskId, offset: f.offset, firedAt: now.toISOString() };
    st.inbox.push(item);
    payload.push(item);
    toast(t.title, core.alertText(t, now), t.id);
  }
  log('Fired ' + payload.length + ' alert(s).');
  commit();
  send('alert', payload);
}

function toast(title, body, taskId) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title,
      body,
      icon: ICON_PNG,
      timeoutType: 'never', // stays until dismissed: a reminder you can miss is not a reminder
      urgency: 'critical',
    });
    liveToasts.add(n);
    n.on('click', () => { showPanel(true); if (taskId) send('highlight', taskId); });
    n.on('close', () => liveToasts.delete(n));
    n.on('failed', (_e, err) => { log('Toast failed: ' + err); liveToasts.delete(n); });
    n.show();
  } catch (err) {
    log('Toast error: ' + err.message);
  }
}

/* -------------------------------------------------------------------- IPC */

function snapshot() {
  return {
    ...store.state,
    env: {
      platform: process.platform,
      version: app.getVersion(),
      packaged: app.isPackaged,
      displays: displayList(),
      mode: runtimeMode,
      appbarAvailable: process.platform === 'win32' && AppBar.available(),
      openAtLogin: loginEnabled(),
    },
  };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcast() { send('state', snapshot()); }

function notice(text) { send('notice', text); log('Notice: ' + text); }

function commit() {
  store.save();
  broadcast();
  updateTray();
}

const findIn = (list, id) => list.findIndex((t) => t.id === id);

ipcMain.handle('state:get', () => snapshot());

ipcMain.handle('task:add', (_e, input) => {
  const now = new Date();
  const t = core.cleanTask({ title: input.title, notes: input.notes, priority: input.priority, due: input.due }, now);
  core.planAlerts(t, now, S().morningHour);
  store.state.tasks.push(t);
  commit();
  return t;
});

ipcMain.handle('task:update', (_e, id, patch) => {
  const st = store.state;
  const i = findIn(st.tasks, id);
  if (i < 0) return null;
  const now = new Date();
  const old = st.tasks[i];
  const allowed = {};
  for (const k of ['title', 'notes', 'priority', 'due']) if (k in patch) allowed[k] = patch[k];
  const t = core.cleanTask({ ...old, ...allowed }, now);
  if (!core.sameDue(old.due, t.due)) {
    core.planAlerts(t, now, S().morningHour);
    st.inbox = st.inbox.filter((a) => a.taskId !== id);
  } else {
    t.alerts = old.alerts;
  }
  st.tasks[i] = t;
  commit();
  return t;
});

ipcMain.handle('task:complete', (_e, id) => {
  const st = store.state;
  const i = findIn(st.tasks, id);
  if (i < 0) return null;
  const now = new Date();
  const [t] = st.tasks.splice(i, 1);
  const before = core.levelInfo(st.stats.xp).level;
  t.completedAt = now.toISOString();
  t.xpAwarded = core.xpFor(t.priority);
  st.stats.xp = (st.stats.xp || 0) + t.xpAwarded;
  const day = core.ymd(now);
  st.stats.doneByDay[day] = (st.stats.doneByDay[day] || 0) + 1;
  st.stats.bestDay = Math.max(st.stats.bestDay || 0, st.stats.doneByDay[day]);
  st.history.unshift(t);
  if (st.history.length > 3000) st.history.length = 3000;
  st.inbox = st.inbox.filter((a) => a.taskId !== id);
  pruneDays(now);
  const after = core.levelInfo(st.stats.xp).level;
  commit();
  return { xp: t.xpAwarded, levelUp: after > before, level: after, doneToday: st.stats.doneByDay[day] };
});

ipcMain.handle('task:restore', (_e, id) => {
  const st = store.state;
  const i = findIn(st.history, id);
  if (i < 0) return null;
  const now = new Date();
  const [t] = st.history.splice(i, 1);
  st.stats.xp = Math.max(0, (st.stats.xp || 0) - (t.xpAwarded || 0));
  if (t.completedAt) {
    const day = core.ymd(new Date(t.completedAt));
    if (st.stats.doneByDay[day]) {
      const wasBest = st.stats.doneByDay[day] === st.stats.bestDay;
      st.stats.doneByDay[day] -= 1;
      if (st.stats.doneByDay[day] <= 0) delete st.stats.doneByDay[day];
      if (wasBest) st.stats.bestDay = Math.max(0, ...Object.values(st.stats.doneByDay));
    }
  }
  t.completedAt = null;
  t.xpAwarded = 0;
  core.planAlerts(t, now, S().morningHour);
  st.tasks.push(t);
  commit();
  return t;
});

ipcMain.handle('task:delete', (_e, id) => {
  const st = store.state;
  for (const where of ['tasks', 'history']) {
    const i = findIn(st[where], id);
    if (i >= 0) {
      const [t] = st[where].splice(i, 1);
      st.inbox = st.inbox.filter((a) => a.taskId !== id);
      commit();
      return { task: t, where };
    }
  }
  return null;
});

ipcMain.handle('task:reinsert', (_e, task, where) => {
  const st = store.state;
  if (!task || !task.id || findIn(st.tasks, task.id) >= 0 || findIn(st.history, task.id) >= 0) return null;
  const t = core.cleanTask(task, new Date());
  if (where === 'history') st.history.unshift(t);
  else st.tasks.push(t);
  commit();
  return t;
});

ipcMain.handle('history:clear', () => {
  store.state.history = [];
  commit();
  return true;
});

ipcMain.handle('inbox:ack', (_e, id) => {
  store.state.inbox = id === '*' ? [] : store.state.inbox.filter((a) => a.id !== id);
  commit();
  return true;
});

ipcMain.handle('settings:set', (_e, patch) => applySettings(patch || {}));

ipcMain.handle('app:test-alert', () => {
  toast('FocusDock test reminder', 'If you can read this, deadline reminders will reach you.', null);
  send('alert', [{ id: 'test', taskId: null, offset: 0, firedAt: new Date().toISOString(), test: true }]);
  return true;
});

ipcMain.handle('app:open-data', () => shell.openPath(store.dir));
ipcMain.handle('app:hide', () => hidePanel());
ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });

function pruneDays(now) {
  const cutoff = core.ymd(core.addDays(now, -400));
  const days = store.state.stats.doneByDay;
  for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
}
