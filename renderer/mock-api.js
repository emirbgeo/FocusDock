/*
 * In-browser stand-in for the Electron bridge. Only active when the page is
 * opened outside the app (window.focusdock missing), e.g. to preview the UI.
 */
(function () {
  'use strict';
  if (window.focusdock) return;
  const C = window.FDCore;
  const listeners = { state: [], alert: [], 'focus-input': [], highlight: [], notice: [] };
  const emit = (ch, p) => listeners[ch].forEach((cb) => cb(p));
  const now = () => new Date();
  const day = (n) => C.ymd(C.addDays(new Date(), n));

  const st = C.emptyState();
  const seed = [
    { title: 'Send referee report', priority: 1, due: { date: day(2), time: null } },
    { title: 'Terrain correction check on profile 4', priority: 2, due: { date: day(0), time: '18:00' } },
    { title: 'Reply to project partners about the pilot schedule', priority: 3, due: { date: day(-1), time: null } },
    { title: 'Prepare week 7 lecture slides', priority: 2, due: { date: day(5), time: null } },
    { title: 'Order a replacement workstation fan', priority: 4, due: null },
    { title: 'Read thesis draft, chapter 2', priority: 3, due: { date: day(1), time: '10:00' } },
    { title: 'Try XGM2019e on the basin margin', priority: 3, due: null },
    { title: 'Book the seminar room for the thesis defence', priority: 4, due: { date: day(16), time: null } },
  ];
  for (const s of seed) {
    const t = C.cleanTask(s, now());
    C.planAlerts(t, now(), 9);
    st.tasks.push(t);
  }
  st.tasks[6].createdAt = C.addDays(new Date(), -19).toISOString();
  const hist = ['Upload conference abstract', 'Fix colour scale on Bouguer map', 'Answer the department email', 'Grade quizzes', 'Back up survey GPS logs'];
  hist.forEach((title, i) => {
    const t = C.cleanTask({ title, priority: (i % 4) + 1 }, now());
    const d = C.addDays(new Date(), i < 2 ? 0 : -1);
    d.setHours(9 + i, 12 * i);
    t.completedAt = d.toISOString();
    t.xpAwarded = C.xpFor(t.priority);
    st.history.push(t);
    st.stats.xp += t.xpAwarded;
    const k = C.ymd(d);
    st.stats.doneByDay[k] = (st.stats.doneByDay[k] || 0) + 1;
  });
  for (let i = 2; i < 7; i++) st.stats.doneByDay[day(-i)] = 2 + (i % 3);
  st.stats.xp += 260;
  st.stats.bestDay = 7;
  st.inbox.push({ id: 'demo', taskId: st.tasks[0].id, offset: 3, firedAt: now().toISOString() });

  const snap = () => JSON.parse(JSON.stringify({
    ...st,
    env: { platform: 'browser', version: 'preview', packaged: false, mode: 'appbar', appbarAvailable: false, openAtLogin: false,
      displays: [{ id: '1', label: 'Screen 1 (3840×2160, leftmost)', leftmost: true }, { id: '2', label: 'Screen 2 (3840×2160)' }] },
  }));
  const commit = () => setTimeout(() => emit('state', snap()), 0);
  const find = (list, id) => list.findIndex((t) => t.id === id);

  window.focusdock = {
    getState: async () => snap(),
    addTask: async (input) => { const t = C.cleanTask(input, now()); C.planAlerts(t, now(), 9); st.tasks.push(t); commit(); return t; },
    updateTask: async (id, patch) => {
      const i = find(st.tasks, id); if (i < 0) return null;
      const t = C.cleanTask({ ...st.tasks[i], ...patch }, now());
      if (!C.sameDue(st.tasks[i].due, t.due)) C.planAlerts(t, now(), 9);
      st.tasks[i] = t; commit(); return t;
    },
    completeTask: async (id) => {
      const i = find(st.tasks, id); if (i < 0) return null;
      const [t] = st.tasks.splice(i, 1);
      const before = C.levelInfo(st.stats.xp).level;
      t.completedAt = now().toISOString(); t.xpAwarded = C.xpFor(t.priority);
      st.stats.xp += t.xpAwarded;
      const k = C.ymd(now()); st.stats.doneByDay[k] = (st.stats.doneByDay[k] || 0) + 1;
      st.history.unshift(t); st.inbox = st.inbox.filter((a) => a.taskId !== id); commit();
      const after = C.levelInfo(st.stats.xp).level;
      return { xp: t.xpAwarded, levelUp: after > before, level: after, doneToday: st.stats.doneByDay[k] };
    },
    restoreTask: async (id) => {
      const i = find(st.history, id); if (i < 0) return null;
      const [t] = st.history.splice(i, 1);
      st.stats.xp = Math.max(0, st.stats.xp - (t.xpAwarded || 0));
      const k = C.ymd(new Date(t.completedAt)); if (st.stats.doneByDay[k]) st.stats.doneByDay[k]--;
      t.completedAt = null; t.xpAwarded = 0; C.planAlerts(t, now(), 9); st.tasks.push(t); commit(); return t;
    },
    deleteTask: async (id) => {
      for (const where of ['tasks', 'history']) {
        const i = find(st[where], id);
        if (i >= 0) { const [t] = st[where].splice(i, 1); commit(); return { task: t, where }; }
      }
      return null;
    },
    reinsertTask: async (task, where) => { (where === 'history' ? st.history : st.tasks).push(task); commit(); return task; },
    clearHistory: async () => { st.history = []; commit(); return true; },
    ackAlert: async (id) => { st.inbox = id === '*' ? [] : st.inbox.filter((a) => a.id !== id); commit(); return true; },
    setSettings: async (patch) => { Object.assign(st.settings, patch); commit(); return st.settings; },
    testAlert: async () => { emit('alert', [{ id: 'test', taskId: null, offset: 0, test: true }]); return true; },
    openDataFolder: async () => {},
    hide: async () => {},
    quit: async () => {},
    onState: (cb) => listeners.state.push(cb),
    onAlert: (cb) => listeners.alert.push(cb),
    onFocusInput: (cb) => listeners['focus-input'].push(cb),
    onHighlight: (cb) => listeners.highlight.push(cb),
    onNotice: (cb) => listeners.notice.push(cb),
  };
})();
