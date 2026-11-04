/*
 * FocusDock core logic.
 * Pure functions only: no Electron, no DOM. Loaded by the main process via
 * require() and by the renderer via a <script> tag (exposed as window.FDCore).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FDCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;
  const HOUR = 3600000;
  const MINUTE = 60000;

  // Priority 1 is the most urgent. Colours live in CSS; xp is the reward.
  const PRIORITIES = [
    { id: 1, key: 'critical', label: 'Critical', xp: 40, weight: 40 },
    { id: 2, key: 'high', label: 'High', xp: 25, weight: 25 },
    { id: 3, key: 'normal', label: 'Normal', xp: 15, weight: 12 },
    { id: 4, key: 'low', label: 'Low', xp: 10, weight: 4 },
  ];
  const DEFAULT_PRIORITY = 3;
  const ALERT_OFFSETS = [3, 1]; // days before the deadline

  const DEFAULT_SETTINGS = {
    edge: 'left',            // 'left' | 'right' edge of the chosen monitor
    width: 380,              // panel width in DIP
    displayId: 'leftmost',   // 'leftmost' or a numeric Electron display id
    dockMode: 'appbar',      // 'appbar' (reserve space) | 'float' | 'ontop'
    dailyGoal: 5,
    sound: true,
    volume: 0.6,
    reduceMotion: false,
    openAtLogin: null,       // null means "use default for this build"
    morningHour: 9,          // when date-only alerts fire
    gpuAcceleration: false,  // off by default: software rendering is plenty for a panel
    shortcut: 'CommandOrControl+Alt+Space',
  };

  const pad = (n) => String(n).padStart(2, '0');

  /** Local calendar date as YYYY-MM-DD. */
  function ymd(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** Parse YYYY-MM-DD into a local Date at 00:00. Returns null if invalid. */
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
    return d;
  }

  function addDays(d, n) {
    const r = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
    return r;
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function parseTime(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return pad(h) + ':' + pad(mi);
  }

  /**
   * The moment a task is due. Date-only deadlines count as the end of that day,
   * so a task "due Friday" is not overdue until Friday is over.
   */
  function dueAt(task) {
    if (!task || !task.due) return null;
    const d = parseYmd(task.due.date);
    if (!d) return null;
    if (task.due.time) {
      const [h, m] = task.due.time.split(':').map(Number);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
    }
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  }

  /**
   * When the "N days before" alert should fire.
   * Timed deadline: exactly N x 24 h before.
   * Date-only deadline: at morningHour on the calendar day N days before.
   */
  function alertAt(task, days, morningHour) {
    if (!task || !task.due) return null;
    const d = parseYmd(task.due.date);
    if (!d) return null;
    if (task.due.time) return new Date(dueAt(task).getTime() - days * DAY);
    const mh = Number.isFinite(morningHour) ? morningHour : DEFAULT_SETTINGS.morningHour;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days, mh, 0, 0, 0);
  }

  /**
   * (Re)plan alerts for a task. Offsets whose moment has already passed are
   * marked 'skipped' so a task created two days before its deadline does not
   * immediately shout "3 days left".
   */
  function planAlerts(task, now, morningHour) {
    const alerts = {};
    if (task.due && !task.completedAt) {
      for (const off of ALERT_OFFSETS) {
        const at = alertAt(task, off, morningHour);
        alerts[off] = at && at.getTime() > now.getTime() ? 'pending' : 'skipped';
      }
    }
    task.alerts = alerts;
    return task;
  }

  /**
   * Find alerts that should fire now. Mutates task.alerts.
   * If the app was off and several thresholds passed for one task, only the
   * most urgent one fires; the older ones are marked 'skipped'.
   * Returns [{ taskId, offset }].
   */
  function collectDueAlerts(tasks, now, morningHour) {
    const fired = [];
    for (const t of tasks) {
      if (t.completedAt || !t.due || !t.alerts) continue;
      const ready = ALERT_OFFSETS.filter((off) => {
        if (t.alerts[off] !== 'pending') return false;
        const at = alertAt(t, off, morningHour);
        return at && at.getTime() <= now.getTime();
      });
      if (!ready.length) continue;
      const mostUrgent = Math.min(...ready);
      for (const off of ready) {
        t.alerts[off] = off === mostUrgent ? now.toISOString() : 'skipped';
      }
      // A smaller offset that already fired makes any larger pending one moot.
      for (const off of ALERT_OFFSETS) {
        if (off > mostUrgent && t.alerts[off] === 'pending') t.alerts[off] = 'skipped';
      }
      fired.push({ taskId: t.id, offset: mostUrgent });
    }
    return fired;
  }

  function sameDue(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.date === b.date && (a.time || null) === (b.time || null);
  }

  /* ---------- Time language ---------- */

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtDate(d, now) {
    const s = WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
    return now && d.getFullYear() !== now.getFullYear() ? s + ' ' + d.getFullYear() : s;
  }

  /** "Today", "Tomorrow", "Yesterday" or "Fri 6 Nov", plus time if set. */
  function fmtDue(task, now) {
    if (!task.due) return 'No deadline';
    const d = parseYmd(task.due.date);
    if (!d) return 'No deadline';
    const diff = Math.round((startOfDay(d) - startOfDay(now)) / DAY);
    let s;
    if (diff === 0) s = 'Today';
    else if (diff === 1) s = 'Tomorrow';
    else if (diff === -1) s = 'Yesterday';
    else s = fmtDate(d, now);
    return task.due.time ? s + ' ' + task.due.time : s;
  }

  function spanText(ms) {
    const abs = Math.abs(ms);
    if (abs < HOUR) return Math.max(1, Math.round(abs / MINUTE)) + 'm';
    if (abs < DAY) return Math.floor(abs / HOUR) + 'h';
    const d = Math.floor(abs / DAY);
    const h = Math.floor((abs - d * DAY) / HOUR);
    return d < 3 && h > 0 ? d + 'd ' + h + 'h' : d + 'd';
  }

  /**
   * Urgency of a deadline, used for colour and copy.
   * level: 'over' | 'hot' (< 24 h) | 'warm' (<= 3 d) | 'mild' (<= 7 d) | 'cool' | 'none'
   */
  function urgency(task, now) {
    const due = dueAt(task);
    if (!due) return { level: 'none', ms: null, text: '' };
    const ms = due.getTime() - now.getTime();
    let level;
    if (ms < 0) level = 'over';
    else if (ms < DAY) level = 'hot';
    else if (ms <= 3 * DAY) level = 'warm';
    else if (ms <= 7 * DAY) level = 'mild';
    else level = 'cool';
    const isToday = ymd(due) === ymd(now);
    let text;
    if (ms < 0) text = spanText(ms) + ' overdue';
    else if (isToday && !task.due.time) text = 'due today';
    else text = 'in ' + spanText(ms);
    return { level, ms, text };
  }

  /** Grouping bucket for the main list. */
  const BUCKETS = [
    { key: 'over', label: 'Overdue' },
    { key: 'today', label: 'Today' },
    { key: 'tomorrow', label: 'Tomorrow' },
    { key: 'week', label: 'Next 7 days' },
    { key: 'later', label: 'Later' },
    { key: 'none', label: 'No deadline' },
  ];

  function bucketOf(task, now) {
    const due = dueAt(task);
    if (!due) return 'none';
    if (due.getTime() < now.getTime()) return 'over';
    const diff = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
    if (diff <= 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff <= 7) return 'week';
    return 'later';
  }

  const BUCKET_ORDER = BUCKETS.reduce((o, b, i) => ((o[b.key] = i), o), {});

  function compareTasks(a, b, now) {
    const ba = bucketOf(a, now), bb = bucketOf(b, now);
    if (ba !== bb) return BUCKET_ORDER[ba] - BUCKET_ORDER[bb];
    const da = dueAt(a), db = dueAt(b);
    const byPrio = a.priority - b.priority;
    const byDue = da && db ? da - db : 0;
    const byAge = String(a.createdAt).localeCompare(String(b.createdAt));
    // Close deadlines: priority first. Far deadlines: date first.
    if (ba === 'over' || ba === 'today' || ba === 'tomorrow' || ba === 'none') return byPrio || byDue || byAge;
    return byDue || byPrio || byAge;
  }

  function sortTasks(tasks, now) {
    return tasks.slice().sort((a, b) => compareTasks(a, b, now));
  }

  /** Group active tasks into ordered buckets, skipping empty ones. */
  function groupTasks(tasks, now) {
    const sorted = sortTasks(tasks, now);
    return BUCKETS.map((b) => ({ ...b, tasks: sorted.filter((t) => bucketOf(t, now) === b.key) })).filter(
      (g) => g.tasks.length
    );
  }

  const PRESSURE = { over: 45, today: 35, tomorrow: 25, week: 8, later: 2, none: 0 };

  /** How strongly a task asks to be done next. Priority plus time pressure. */
  function spotlightScore(task, now) {
    const p = PRIORITIES.find((x) => x.id === task.priority) || PRIORITIES[2];
    let pressure = PRESSURE[bucketOf(task, now)];
    const due = dueAt(task);
    if (due && bucketOf(task, now) === 'week' && due - now <= 3 * DAY) pressure = 15;
    return p.weight + pressure;
  }

  /** Best task to do next, skipping ids in `skip`. */
  function pickSpotlight(tasks, now, skip) {
    const pool = tasks.filter((t) => !(skip && skip.has(t.id)));
    if (!pool.length) return null;
    return pool.slice().sort((a, b) => spotlightScore(b, now) - spotlightScore(a, now) || compareTasks(a, b, now))[0];
  }

  /* ---------- Quick add parser ---------- */

  const DAY_WORDS = {
    sun: 0, sunday: 0, paz: 0, pazar: 0,
    mon: 1, monday: 1, pzt: 1, pazartesi: 1,
    tue: 2, tues: 2, tuesday: 2, sal: 2, 'salı': 2, sali: 2,
    wed: 3, wednesday: 3, 'çar': 3, car: 3, 'çarşamba': 3, carsamba: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4, per: 4, 'perşembe': 4, persembe: 4,
    fri: 5, friday: 5, cum: 5, cuma: 5,
    sat: 6, saturday: 6, cmt: 6, cumartesi: 6,
  };

  /** Parse the text after '@'. Returns { date?, time?, none? } or null. */
  function parseWhen(s, now) {
    const today = startOfDay(now);
    if (['none', 'nodeadline', 'nd', 'someday', 'yok'].includes(s)) return { none: true };
    if (['today', 'tod', 'bugün', 'bugun'].includes(s)) return { date: ymd(today) };
    if (['tomorrow', 'tmr', 'tom', 'yarın', 'yarin'].includes(s)) return { date: ymd(addDays(today, 1)) };
    if (Object.prototype.hasOwnProperty.call(DAY_WORDS, s)) {
      const target = DAY_WORDS[s];
      let diff = (target - today.getDay() + 7) % 7;
      if (diff === 0) diff = 7; // "@fri" on a Friday means next Friday
      return { date: ymd(addDays(today, diff)) };
    }
    let m;
    if ((m = /^\+?(\d{1,3})(d|g)$/.exec(s)) || (m = /^\+(\d{1,3})$/.exec(s))) {
      return { date: ymd(addDays(today, +m[1])) };
    }
    if ((m = /^(\d{1,2})w$/.exec(s))) return { date: ymd(addDays(today, 7 * +m[1])) };
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) {
      return parseYmd(s) ? { date: s } : null;
    }
    if ((m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/.exec(s))) {
      const day = +m[1], mon = +m[2];
      let year = m[3] ? +m[3] : today.getFullYear();
      if (year < 100) year += 2000;
      let d = new Date(year, mon - 1, day);
      if (d.getMonth() !== mon - 1 || d.getDate() !== day) return null;
      if (!m[3] && d < today) d = new Date(year + 1, mon - 1, day);
      return { date: ymd(d) };
    }
    const t = parseTime(s);
    if (t) return { time: t };
    return null;
  }

  /**
   * Quick add syntax, all optional, anywhere in the text:
   *   !1 .. !4   priority (1 = critical). '!!!' = critical, '!!' = high
   *   @today @tomorrow @fri @15.11 @15.11.2026 @2026-11-15 @3d @2w
   *   @14:00     time (alone: today, or tomorrow if already past)
   *   @none      explicitly no deadline
   * Turkish day words also work (@cuma, @yarın, @bugün).
   * Returns { title, priority (or undefined), due: {date,time} | null | undefined }.
   * due === undefined means "not mentioned".
   */
  function parseQuickAdd(text, now) {
    now = now || new Date();
    const rest = [];
    let priority, date, time, none = false;
    for (const tok of String(text || '').split(/\s+/)) {
      if (!tok) continue;
      let m;
      if ((m = /^!([1-4])$/.exec(tok))) { priority = +m[1]; continue; }
      if (tok === '!!!') { priority = 1; continue; }
      if (tok === '!!') { priority = 2; continue; }
      if (tok.length > 1 && tok[0] === '@') {
        const r = parseWhen(tok.slice(1).toLocaleLowerCase('tr'), now) || parseWhen(tok.slice(1).toLowerCase(), now);
        if (r) {
          if (r.none) none = true;
          if (r.date) date = r.date;
          if (r.time) time = r.time;
          continue;
        }
      }
      rest.push(tok);
    }
    if (time && !date) {
      const today = startOfDay(now);
      const [h, mi] = time.split(':').map(Number);
      const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, mi);
      date = ymd(at > now ? today : addDays(today, 1));
    }
    let due;
    if (none) due = null;
    else if (date) due = { date, time: time || null };
    return { title: rest.join(' ').trim(), priority, due };
  }

  /* ---------- Rewards ---------- */

  function xpFor(priority) {
    const p = PRIORITIES.find((x) => x.id === priority);
    return p ? p.xp : 15;
  }

  /** Cumulative XP needed to reach a level. L1 = 0, L2 = 100, L3 = 300, L4 = 600 ... */
  function xpForLevel(level) {
    return 50 * level * (level - 1);
  }

  function levelInfo(xp) {
    xp = Math.max(0, xp || 0);
    let level = 1;
    while (xpForLevel(level + 1) <= xp) level++;
    const base = xpForLevel(level), next = xpForLevel(level + 1);
    return { level, xp, into: xp - base, span: next - base, progress: (xp - base) / (next - base) };
  }

  /** Consecutive days with at least one completion, ending today or yesterday. */
  function streak(doneByDay, now) {
    doneByDay = doneByDay || {};
    let d = startOfDay(now);
    if (!doneByDay[ymd(d)]) d = addDays(d, -1);
    let n = 0;
    while (doneByDay[ymd(d)]) { n++; d = addDays(d, -1); }
    return n;
  }

  /** Short, specific alert copy for a task. */
  function alertText(task, now) {
    const u = urgency(task, now);
    const when = fmtDue(task, now);
    if (u.level === 'over') return 'Overdue: was due ' + when + '.';
    const due = dueAt(task);
    const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
    if (days === 0) return 'Due today' + (task.due.time ? ' at ' + task.due.time : '') + '.';
    if (days === 1) return 'Due tomorrow' + (task.due.time ? ' at ' + task.due.time : '') + '.';
    return 'Due in ' + days + ' days, ' + when + '.';
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Normalise and validate a task-ish object coming from the UI. */
  function cleanTask(input, now) {
    const title = String(input.title || '').trim().slice(0, 300);
    if (!title) throw new Error('A task needs a title.');
    let priority = Number(input.priority);
    if (![1, 2, 3, 4].includes(priority)) priority = DEFAULT_PRIORITY;
    let due = null;
    if (input.due && parseYmd(input.due.date)) {
      due = { date: input.due.date, time: parseTime(input.due.time) };
    }
    return {
      id: input.id || uid(),
      title,
      notes: String(input.notes || '').slice(0, 4000),
      priority,
      due,
      createdAt: input.createdAt || now.toISOString(),
      completedAt: input.completedAt || null,
      alerts: input.alerts || {},
      xpAwarded: input.xpAwarded || 0,
    };
  }

  function emptyState() {
    return {
      version: 1,
      tasks: [],
      history: [],
      inbox: [],
      stats: { xp: 0, doneByDay: {}, bestDay: 0 },
      settings: { ...DEFAULT_SETTINGS },
    };
  }

  /** Bring any loaded JSON up to the current shape without losing data. */
  function migrate(raw) {
    const s = emptyState();
    if (!raw || typeof raw !== 'object') return s;
    s.tasks = Array.isArray(raw.tasks) ? raw.tasks.filter((t) => t && t.id && t.title) : [];
    s.history = Array.isArray(raw.history) ? raw.history.filter((t) => t && t.id && t.title) : [];
    s.inbox = Array.isArray(raw.inbox) ? raw.inbox.filter((a) => a && a.id && a.taskId) : [];
    s.stats = { ...s.stats, ...(raw.stats || {}) };
    if (!s.stats.doneByDay || typeof s.stats.doneByDay !== 'object') s.stats.doneByDay = {};
    s.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
    return s;
  }

  return {
    DAY, HOUR, MINUTE,
    PRIORITIES, DEFAULT_PRIORITY, ALERT_OFFSETS, DEFAULT_SETTINGS, BUCKETS,
    ymd, parseYmd, parseTime, addDays, startOfDay,
    dueAt, alertAt, planAlerts, collectDueAlerts, sameDue,
    fmtDate, fmtDue, urgency, bucketOf, sortTasks, groupTasks, compareTasks,
    spotlightScore, pickSpotlight,
    parseWhen, parseQuickAdd,
    xpFor, xpForLevel, levelInfo, streak, alertText,
    uid, cleanTask, emptyState, migrate,
  };
});
