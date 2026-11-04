const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

// Tuesday 3 Nov 2026, 17:20 local
const NOW = new Date(2026, 10, 3, 17, 20);

const task = (over) => C.cleanTask({ title: 'x', ...over }, NOW);

test('dueAt: date-only means end of day, timed means exact', () => {
  assert.equal(C.dueAt(task({ due: { date: '2026-11-06' } })).getHours(), 23);
  const t = C.dueAt(task({ due: { date: '2026-11-06', time: '14:00' } }));
  assert.equal(t.getHours(), 14);
  assert.equal(C.dueAt(task({})), null);
});

test('alertAt: date-only alerts fire at morning hour N days before', () => {
  const t = task({ due: { date: '2026-11-10' } });
  const a3 = C.alertAt(t, 3, 9);
  assert.equal(C.ymd(a3), '2026-11-07');
  assert.equal(a3.getHours(), 9);
  const a1 = C.alertAt(t, 1, 9);
  assert.equal(C.ymd(a1), '2026-11-09');
});

test('alertAt: timed alerts fire exactly 72h and 24h before', () => {
  const t = task({ due: { date: '2026-11-10', time: '14:30' } });
  assert.equal(C.dueAt(t) - C.alertAt(t, 3, 9), 3 * C.DAY);
  assert.equal(C.dueAt(t) - C.alertAt(t, 1, 9), C.DAY);
});

test('planAlerts skips thresholds already in the past', () => {
  const far = C.planAlerts(task({ due: { date: '2026-11-20' } }), NOW, 9);
  assert.deepEqual(far.alerts, { 3: 'pending', 1: 'pending' });
  const near = C.planAlerts(task({ due: { date: '2026-11-05' } }), NOW, 9); // 3d alert would be Nov 2
  assert.deepEqual(near.alerts, { 3: 'skipped', 1: 'pending' });
  const none = C.planAlerts(task({}), NOW, 9);
  assert.deepEqual(none.alerts, {});
});

test('collectDueAlerts fires once, in order, and catches up with only the most urgent', () => {
  const t = C.planAlerts(task({ due: { date: '2026-11-10' } }), NOW, 9);
  // Nov 7 08:59: nothing
  assert.equal(C.collectDueAlerts([t], new Date(2026, 10, 7, 8, 59), 9).length, 0);
  // Nov 7 09:00: 3-day alert
  let f = C.collectDueAlerts([t], new Date(2026, 10, 7, 9, 0), 9);
  assert.deepEqual(f, [{ taskId: t.id, offset: 3 }]);
  // same moment again: nothing (already fired)
  assert.equal(C.collectDueAlerts([t], new Date(2026, 10, 7, 9, 1), 9).length, 0);
  // Nov 9 10:00: 1-day alert
  f = C.collectDueAlerts([t], new Date(2026, 10, 9, 10, 0), 9);
  assert.deepEqual(f, [{ taskId: t.id, offset: 1 }]);

  // App was off from creation until Nov 9 noon: only the 1-day alert fires
  const t2 = C.planAlerts(task({ due: { date: '2026-11-10' } }), NOW, 9);
  f = C.collectDueAlerts([t2], new Date(2026, 10, 9, 12, 0), 9);
  assert.deepEqual(f, [{ taskId: t2.id, offset: 1 }]);
  assert.equal(t2.alerts[3], 'skipped');

  // Completed tasks never alert
  const t3 = C.planAlerts(task({ due: { date: '2026-11-10' } }), NOW, 9);
  t3.completedAt = NOW.toISOString();
  assert.equal(C.collectDueAlerts([t3], new Date(2026, 10, 9, 12, 0), 9).length, 0);
});

test('urgency levels and copy', () => {
  assert.equal(C.urgency(task({ due: { date: '2026-11-02' } }), NOW).level, 'over');
  assert.equal(C.urgency(task({ due: { date: '2026-11-03' } }), NOW).text, 'due today');
  assert.equal(C.urgency(task({ due: { date: '2026-11-03', time: '19:20' } }), NOW).text, 'in 2h');
  assert.equal(C.urgency(task({ due: { date: '2026-11-05' } }), NOW).level, 'warm');
  assert.equal(C.urgency(task({ due: { date: '2026-11-09' } }), NOW).level, 'mild');
  assert.equal(C.urgency(task({ due: { date: '2026-12-09' } }), NOW).level, 'cool');
  assert.equal(C.urgency(task({}), NOW).level, 'none');
});

test('fmtDue uses relative words near today', () => {
  assert.equal(C.fmtDue(task({ due: { date: '2026-11-03' } }), NOW), 'Today');
  assert.equal(C.fmtDue(task({ due: { date: '2026-11-04', time: '09:00' } }), NOW), 'Tomorrow 09:00');
  assert.equal(C.fmtDue(task({ due: { date: '2026-11-06' } }), NOW), 'Fri 6 Nov');
  assert.equal(C.fmtDue(task({ due: { date: '2027-01-06' } }), NOW), 'Wed 6 Jan 2027');
});

test('grouping and sorting', () => {
  const ts = [
    task({ title: 'later', due: { date: '2026-12-01' } }),
    task({ title: 'none-low', priority: 4 }),
    task({ title: 'none-crit', priority: 1 }),
    task({ title: 'over', due: { date: '2026-11-01' } }),
    task({ title: 'today', due: { date: '2026-11-03' } }),
    task({ title: 'tomorrow', due: { date: '2026-11-04' } }),
    task({ title: 'week', due: { date: '2026-11-08' } }),
  ];
  const groups = C.groupTasks(ts, NOW);
  assert.deepEqual(groups.map((g) => g.key), ['over', 'today', 'tomorrow', 'week', 'later', 'none']);
  assert.deepEqual(groups[5].tasks.map((t) => t.title), ['none-crit', 'none-low']);
});

test('spotlight weighs priority against time pressure', () => {
  const critTomorrow = task({ title: 'crit tomorrow', priority: 1, due: { date: '2026-11-04' } });
  const lowOverdue = task({ title: 'low overdue', priority: 4, due: { date: '2026-11-01' } });
  const normalNone = task({ title: 'normal none', priority: 3 });
  assert.equal(C.pickSpotlight([lowOverdue, normalNone, critTomorrow], NOW).title, 'crit tomorrow');
  assert.equal(C.pickSpotlight([lowOverdue, normalNone, critTomorrow], NOW, new Set([critTomorrow.id])).title, 'low overdue');
  assert.equal(C.pickSpotlight([], NOW), null);
});

test('quick add parser', () => {
  let r = C.parseQuickAdd('Submit review !1 @fri', NOW);
  assert.equal(r.title, 'Submit review');
  assert.equal(r.priority, 1);
  assert.deepEqual(r.due, { date: '2026-11-06', time: null });

  r = C.parseQuickAdd('Call Bülent hoca @tomorrow @14:00 !!', NOW);
  assert.equal(r.title, 'Call Bülent hoca');
  assert.equal(r.priority, 2);
  assert.deepEqual(r.due, { date: '2026-11-04', time: '14:00' });

  r = C.parseQuickAdd('Grade exams @15.11', NOW);
  assert.deepEqual(r.due, { date: '2026-11-15', time: null });

  r = C.parseQuickAdd('New year thing @02.01', NOW); // already past this year
  assert.equal(r.due.date, '2027-01-02');

  r = C.parseQuickAdd('Thing @3d', NOW);
  assert.equal(r.due.date, '2026-11-06');

  r = C.parseQuickAdd('Thing @2w', NOW);
  assert.equal(r.due.date, '2026-11-17');

  r = C.parseQuickAdd('Ödev @cuma', NOW);
  assert.equal(r.due.date, '2026-11-06');

  r = C.parseQuickAdd('Ödev @YARIN', NOW);
  assert.equal(r.due.date, '2026-11-04');

  r = C.parseQuickAdd('Tue on a Tuesday @tue', NOW);
  assert.equal(r.due.date, '2026-11-10');

  r = C.parseQuickAdd('Seminar @16:00', NOW); // 16:00 already passed at 17:20, so tomorrow
  assert.deepEqual(r.due, { date: '2026-11-04', time: '16:00' });

  r = C.parseQuickAdd('Seminar @18:00', NOW);
  assert.equal(r.due.date, '2026-11-03');

  r = C.parseQuickAdd('Email @john about @31.02', NOW); // unknown tokens stay in title
  assert.equal(r.title, 'Email @john about @31.02');
  assert.equal(r.due, undefined);

  r = C.parseQuickAdd('Someday idea @none', NOW);
  assert.equal(r.due, null);

  r = C.parseQuickAdd('Plain task', NOW);
  assert.equal(r.priority, undefined);
  assert.equal(r.due, undefined);

  r = C.parseQuickAdd('ISO date @2026-12-24', NOW);
  assert.equal(r.due.date, '2026-12-24');
});

test('levels and streaks', () => {
  assert.equal(C.levelInfo(0).level, 1);
  assert.equal(C.levelInfo(99).level, 1);
  assert.equal(C.levelInfo(100).level, 2);
  assert.equal(C.levelInfo(300).level, 3);
  assert.equal(C.levelInfo(250).into, 150);
  const days = { '2026-11-03': 2, '2026-11-02': 1, '2026-11-01': 4, '2026-10-30': 1 };
  assert.equal(C.streak(days, NOW), 3);
  const noToday = { '2026-11-02': 1, '2026-11-01': 4 };
  assert.equal(C.streak(noToday, NOW), 2); // streak is alive until today ends
  assert.equal(C.streak({}, NOW), 0);
});

test('alertText', () => {
  assert.equal(C.alertText(task({ due: { date: '2026-11-06' } }), NOW), 'Due in 3 days, Fri 6 Nov.');
  assert.equal(C.alertText(task({ due: { date: '2026-11-04', time: '10:00' } }), NOW), 'Due tomorrow at 10:00.');
});

test('cleanTask validates input', () => {
  assert.throws(() => C.cleanTask({ title: '   ' }, NOW));
  const t = C.cleanTask({ title: ' a ', priority: 9, due: { date: 'bad' } }, NOW);
  assert.equal(t.title, 'a');
  assert.equal(t.priority, 3);
  assert.equal(t.due, null);
});

test('migrate keeps data and fills defaults', () => {
  const s = C.migrate({ tasks: [{ id: 'a', title: 'b' }], settings: { edge: 'right' } });
  assert.equal(s.tasks.length, 1);
  assert.equal(s.settings.edge, 'right');
  assert.equal(s.settings.dailyGoal, 5);
  assert.deepEqual(C.migrate(null).tasks, []);
});
