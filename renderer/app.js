/* FocusDock renderer. Plain JS, no build step. */
(function () {
  'use strict';

  const C = window.FDCore;
  const api = window.focusdock;
  const FX = window.FX;
  const $ = (s, root) => (root || document).querySelector(s);

  const PRIO_COLOR = { 1: '#FF4F6E', 2: '#FFB020', 3: '#1FC2B0', 4: '#3D7BFF' };

  const ui = {
    state: null,
    view: 'tasks',
    editingId: null,
    skip: new Set(),
    lock: 0,
    dirty: false,
    capture: { priority: null, due: null },
    flashId: null,
    toastTimer: null,
    toastUndo: null,
    clearArmed: null,
    settingsOpen: false,
    lastDay: null,
  };

  /* ------------------------------------------------------------ helpers */

  const ICONS = {
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-2.6 3.6M6.6 6.6C4.4 8 2.8 10.1 2 12c1 2.5 5 7 10 7a9.6 9.6 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="3.2"/>',
    flame: '<path d="M12 2.5c1.2 3.2 4.8 5.3 4.8 9.8a4.8 4.8 0 0 1-9.6 0c0-2.3 1.1-3.6 2.3-4.7 0 2.1.9 3.3 2.1 3.3 0-3.3-1.1-5.4.4-8.4z" fill="currentColor" stroke="none"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  };
  const icon = (name) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    ICONS[name] + '</svg>';

  function h(tag, props) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'style') el.style.cssText = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = [].concat(arguments[i]);
      for (const kid of kids) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    }
    return el;
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const settings = () => (ui.state ? ui.state.settings : C.DEFAULT_SETTINGS);
  const volume = () => (settings().sound ? settings().volume : 0);
  const calm = () => !!settings().reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const findTask = (id) => ui.state.tasks.find((t) => t.id === id);
  const prioOf = (id) => C.PRIORITIES.find((p) => p.id === id) || C.PRIORITIES[2];

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }

  /* --------------------------------------------- header: anomaly isolines */

  // A daily "survey": a small gravity-like field from a few Gaussian sources,
  // contoured with marching squares. Seeded by the date, so it changes daily.
  function drawIsolines() {
    const svg = $('.isolines');
    const W = 400, H = 200, nx = 80, ny = 40;
    let seed = Number(C.ymd(new Date()).replace(/-/g, '')) % 2147483647;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const sources = Array.from({ length: 4 }, () => ({
      x: rnd() * W, y: rnd() * H * 1.2 - H * 0.1, a: (rnd() < 0.3 ? -1 : 1) * (0.6 + rnd()), s: 40 + rnd() * 70,
    }));
    const f = (x, y) => sources.reduce((acc, s) => acc + s.a * Math.exp(-((x - s.x) ** 2 + (y - s.y) ** 2) / (2 * s.s * s.s)), 0);
    const grid = [];
    let min = Infinity, max = -Infinity;
    for (let j = 0; j <= ny; j++) {
      grid[j] = [];
      for (let i = 0; i <= nx; i++) {
        const v = f((i / nx) * W, (j / ny) * H);
        grid[j][i] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    const dx = W / nx, dy = H / ny;
    let d = '';
    const levels = 11;
    for (let L = 1; L < levels; L++) {
      const z = min + ((max - min) * L) / levels;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], e = grid[j + 1][i];
          const pts = [];
          const edge = (v1, v2, x1, y1, x2, y2) => {
            if ((v1 < z) !== (v2 < z)) {
              const t = (z - v1) / (v2 - v1);
              pts.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
            }
          };
          const x0 = i * dx, y0 = j * dy;
          edge(a, b, x0, y0, x0 + dx, y0);
          edge(b, c, x0 + dx, y0, x0 + dx, y0 + dy);
          edge(c, e, x0 + dx, y0 + dy, x0, y0 + dy);
          edge(e, a, x0, y0 + dy, x0, y0);
          for (let k = 0; k + 1 < pts.length; k += 2) {
            d += 'M' + pts[k][0].toFixed(1) + ' ' + pts[k][1].toFixed(1) + 'L' + pts[k + 1][0].toFixed(1) + ' ' + pts[k + 1][1].toFixed(1);
          }
        }
      }
    }
    svg.innerHTML = '<path d="' + d + '"/>';
  }

  /* -------------------------------------------------------------- header */

  const DAYNAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHNAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function renderHeader(now) {
    const st = ui.state;
    $('#date').innerHTML = '';
    $('#date').append(DAYNAMES[now.getDay()], h('small', { text: now.getDate() + ' ' + MONTHNAMES[now.getMonth()] + ' ' + now.getFullYear() }));

    const goal = st.settings.dailyGoal;
    const done = st.stats.doneByDay[C.ymd(now)] || 0;
    const bar = $('#colorbar');
    const prevOn = bar.querySelectorAll('.cell.on').length;
    const cells = [];
    for (let i = 0; i < goal; i++) {
      const cell = h('div', {
        class: 'cell' + (i < prevOn && i < done ? ' on' : ''),
        style: '--n:' + goal * 100 + '%;--pos:' + (goal > 1 ? (i / (goal - 1)) * 100 : 0) + '%',
      });
      cells.push(cell);
    }
    bar.replaceChildren(...cells);
    if (done > goal) bar.append(h('span', { class: 'bonus', text: '+' + (done - goal) }));
    bar.classList.toggle('full', done >= goal);
    bar.setAttribute('aria-label', done + ' of ' + goal + ' tasks done today');
    // Let newly earned cells fill with a transition.
    requestAnimationFrame(() => cells.forEach((c, i) => c.classList.toggle('on', i < done)));

    const count = $('#today-count');
    count.innerHTML = '';
    if (done >= goal) count.append('Goal met: ', h('b', { text: String(done) }), ' done today');
    else count.append(h('b', { text: String(done) }), ' of ' + goal + ' done today');

    const s = C.streak(st.stats.doneByDay, now);
    const streakEl = $('#streak');
    streakEl.innerHTML = '';
    if (s > 0) streakEl.append(h('span', { class: 'flame', html: icon('flame'), style: 'display:inline-flex;width:13px;height:13px;vertical-align:-2px;margin-right:3px' }), s + ' day streak');

    const lv = C.levelInfo(st.stats.xp);
    const level = $('#level');
    level.innerHTML = '';
    level.append(
      h('span', { class: 'lv', text: 'Level ' + lv.level }),
      h('span', { class: 'xpbar', style: '--p:' + (lv.progress * 100).toFixed(1) + '%;--pf:' + lv.progress.toFixed(3) }, h('i')),
      h('span', { class: 'xptext', text: lv.into + ' / ' + lv.span + ' mGal' })
    );
    level.title = 'Experience is counted in mGal. Critical tasks give 40, high 25, normal 15, low 10.';
  }

  /* -------------------------------------------------------------- inbox */

  function renderInbox(now) {
    const box = $('#inbox');
    const items = ui.state.inbox.slice().reverse();
    box.replaceChildren(
      ...items.map((a) => {
        if (a.test) return null;
        const t = findTask(a.taskId);
        if (!t) return null;
        const u = C.urgency(t, now);
        const heat = u.level === 'over' || u.level === 'hot' ? 'var(--crit)' : 'var(--high)';
        return h('div', { class: 'alert', style: '--heat:' + heat },
          h('div', { class: 'a-kind' }, h('span', { html: icon('bell') }), a.offset === 1 ? '1 day reminder' : '3 day reminder'),
          h('div', { class: 'a-title', text: t.title }),
          h('div', { class: 'a-body', text: C.alertText(t, now) }),
          h('div', { class: 'a-actions' },
            h('button', { class: 'btn small primary', text: 'Got it', onclick: () => api.ackAlert(a.id) }),
            h('button', { class: 'btn small ghost', text: 'Show task', onclick: () => { api.ackAlert(a.id); highlight(t.id); } })
          )
        );
      }).filter(Boolean)
    );
  }

  function showTestAlert() {
    const box = $('#inbox');
    const card = h('div', { class: 'alert', style: '--heat:var(--normal)' },
      h('div', { class: 'a-title', text: 'Test reminder' }),
      h('div', { class: 'a-body', text: 'Reminders appear here and as a Windows notification. If you saw both, you are set.' }),
      h('div', { class: 'a-actions' }, h('button', { class: 'btn small primary', text: 'Got it', onclick: () => card.remove() }))
    );
    box.prepend(card);
  }

  /* ---------------------------------------------------------- spotlight */

  function dueChip(t, now) {
    if (!t.due) return null;
    const u = C.urgency(t, now);
    let label = C.fmtDue(t, now);
    if (u.text && u.text !== 'due today') label += ', ' + u.text;
    return h('span', { class: 'chip u-' + u.level, title: 'Deadline' }, h('span', { class: 'dot' }), label);
  }

  function prioChip(t, always) {
    if (!always && t.priority > 2) return null;
    const p = prioOf(t.priority);
    return h('span', { class: 'chip p-' + p.id, style: '--c:var(--pc)' }, h('span', { class: 'dot' }), p.label);
  }

  function renderSpotlight(now) {
    const tasks = ui.state.tasks;
    const box = $('#spotlight');
    for (const id of ui.skip) if (!findTask(id)) ui.skip.delete(id);
    if (ui.skip.size && ui.skip.size >= tasks.length) ui.skip.clear();
    const t = C.pickSpotlight(tasks, now, ui.skip);
    if (!t) {
      box.replaceChildren(h('div', { class: 'spot empty' },
        h('div', { class: 'spot-label' }, h('span', { text: 'Do this next' })),
        h('p', { class: 'spot-title', text: 'Nothing open. Capture the next thing below, or press Ctrl+Alt+Space from any screen.' })
      ));
      ui.spotId = null;
      return;
    }
    ui.spotId = t.id;
    const heat = PRIO_COLOR[t.priority];
    box.replaceChildren(h('div', { class: 'spot p-' + t.priority, style: '--heat:' + heat, 'data-id': t.id },
      h('div', { class: 'spot-label' },
        h('span', { text: 'Do this next' }),
        tasks.length > 1 ? h('span', { text: (tasks.length - 1) + ' more waiting' }) : null
      ),
      h('p', { class: 'spot-title', text: t.title }),
      h('div', { class: 'spot-meta' }, prioChip(t, true), dueChip(t, now)),
      h('div', { class: 'spot-actions' },
        h('button', { class: 'btn primary', html: icon('check') + 'Done', onclick: (e) => complete(t.id, e.currentTarget) }),
        tasks.length > 1 ? h('button', { class: 'btn ghost', text: 'Not now', title: 'Show the next best task instead', onclick: () => { ui.skip.add(t.id); render(); } }) : null
      )
    ));
  }

  /* --------------------------------------------------------------- list */

  function taskRow(t, now) {
    const editing = ui.editingId === t.id;
    const row = h('div', { class: 'task p-' + t.priority + (editing ? ' editing' : '') + (t.id === ui.spotId ? ' is-next' : ''), 'data-id': t.id });
    if (t.id === ui.spotId) row.style.borderLeftColor = 'color-mix(in srgb, var(--pc) 70%, transparent)';
    row.append(
      h('button', { class: 'check', html: icon('check'), 'aria-label': 'Complete: ' + t.title, title: 'Mark done', onclick: (e) => complete(t.id, e.currentTarget) })
    );

    const meta = h('div', { class: 't-meta' }, dueChip(t, now), prioChip(t, false));
    if (!t.due) {
      const age = Math.floor((now - new Date(t.createdAt)) / C.DAY);
      if (age >= 14) meta.append(h('span', { class: 'chip quiet', text: 'open ' + age + ' days', title: 'Old tasks without deadlines tend to rot. Do it, date it or delete it.' }));
    }
    const main = h('div', { class: 't-main', title: editing ? null : 'Click to edit', onclick: () => { if (!editing) startEdit(t.id); } },
      h('div', { class: 't-title', text: t.title }),
      meta.childNodes.length ? meta : null,
      t.notes && !editing ? h('div', { class: 't-notes', text: t.notes }) : null
    );
    row.append(main);
    row.append(h('div', { class: 't-actions' },
      h('button', { class: 'icon-btn', html: icon('pencil'), title: 'Edit', 'aria-label': 'Edit', onclick: () => startEdit(t.id) }),
      h('button', { class: 'icon-btn', html: icon('trash'), title: 'Delete', 'aria-label': 'Delete', onclick: () => removeTask(t.id) })
    ));
    if (editing) row.append(editor(t, now));
    if (ui.flashId === t.id) row.classList.add('flash');
    return row;
  }

  function renderList(now) {
    const list = $('#list');
    const groups = C.groupTasks(ui.state.tasks, now);
    if (!groups.length) {
      list.replaceChildren(h('p', { class: 'empty-list', text: 'No open tasks. Anything you add lands here, sorted by how hot it is.' }));
      return;
    }
    list.replaceChildren(...groups.map((g) =>
      h('section', { class: 'group' },
        h('h2', { class: 'group-head g-' + g.key }, g.label, h('span', { class: 'n', text: String(g.tasks.length) })),
        g.tasks.map((t) => taskRow(t, now))
      )
    ));
    ui.flashId = null;
  }

  /* ------------------------------------------------------------- editor */

  function prioSeg(current, onPick) {
    const seg = h('div', { class: 'seg prio-seg', role: 'radiogroup', 'aria-label': 'Priority' });
    for (const p of C.PRIORITIES) {
      seg.append(h('button', {
        type: 'button', class: 'p-' + p.id, role: 'radio', 'aria-checked': String(current === p.id),
        onclick: () => { seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', 'false')); seg.children[p.id - 1].setAttribute('aria-checked', 'true'); onPick(p.id); },
      }, h('span', { class: 'dot' }), p.label));
    }
    return seg;
  }

  function editor(t, now) {
    let priority = t.priority;
    const title = h('input', { type: 'text', value: t.title, 'aria-label': 'Title', maxlength: '300' });
    const notes = h('textarea', { rows: '2', placeholder: 'Notes (optional)', 'aria-label': 'Notes' });
    notes.value = t.notes || '';
    const date = h('input', { type: 'date', value: t.due ? t.due.date : '', 'aria-label': 'Deadline date' });
    const time = h('input', { type: 'time', value: t.due && t.due.time ? t.due.time : '', 'aria-label': 'Deadline time (optional)' });
    const syncTime = () => { time.disabled = !date.value; if (!date.value) time.value = ''; };
    date.addEventListener('input', syncTime);
    syncTime();
    const setDate = (n) => { date.value = n === null ? '' : C.ymd(C.addDays(now, n)); syncTime(); };

    const save = async () => {
      const title2 = title.value.trim();
      if (!title2) { title.focus(); return; }
      const due = date.value ? { date: date.value, time: time.value || null } : null;
      ui.editingId = null;
      await api.updateTask(t.id, { title: title2, notes: notes.value, priority, due });
      render();
    };
    const cancel = () => { ui.editingId = null; render(); };
    const box = h('div', {
      class: 'editor',
      onkeydown: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        if (e.key === 'Enter' && (e.target === title || e.ctrlKey)) { e.preventDefault(); save(); }
      },
    },
      h('label', null, 'Title', title),
      h('label', null, 'Notes', notes),
      h('div', null, prioSeg(priority, (p) => { priority = p; })),
      h('label', null, 'Deadline',
        h('div', { class: 'row' }, date, time,
          h('button', { type: 'button', class: 'btn small ghost', text: 'Today', onclick: () => setDate(0) }),
          h('button', { type: 'button', class: 'btn small ghost', text: 'Tomorrow', onclick: () => setDate(1) }),
          h('button', { type: 'button', class: 'btn small ghost', text: 'None', onclick: () => setDate(null) })
        )
      ),
      h('div', { class: 'actions' },
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small primary', style: '--heat:var(--normal)', text: 'Save', onclick: save }),
          h('button', { type: 'button', class: 'btn small ghost', text: 'Cancel', onclick: cancel })
        ),
        h('button', { type: 'button', class: 'btn small ghost danger', html: icon('trash') + 'Delete', onclick: () => { ui.editingId = null; removeTask(t.id); } })
      )
    );
    setTimeout(() => { title.focus(); title.setSelectionRange(title.value.length, title.value.length); }, 0);
    return box;
  }

  function startEdit(id) {
    ui.editingId = id;
    render();
  }

  /* ------------------------------------------------------------ actions */

  async function complete(id, sourceEl) {
    const t = findTask(id);
    if (!t || ui.completing === id) return;
    ui.completing = id;
    ui.lock++;
    const quiet = calm();
    const rows = Array.from(document.querySelectorAll('[data-id="' + id + '"]'));
    const r = sourceEl.getBoundingClientRect();
    const cx = r.left + (sourceEl.classList.contains('check') ? r.width / 2 : 22);
    const cy = r.top + r.height / 2;
    if (sourceEl.classList.contains('check')) sourceEl.classList.add('done');
    const color = PRIO_COLOR[t.priority];
    if (!quiet) {
      FX.ripple(cx, cy, color, t.priority === 1 ? 4 : 3);
      FX.burst(cx, cy, { count: [0, 70, 44, 30, 20][t.priority], power: t.priority === 1 ? 1.3 : 1 });
    }
    FX.sound.complete(t.priority, volume());
    await wait(quiet ? 0 : 160);
    rows.forEach((row) => row.classList.add('leaving'));
    let res = null;
    try { res = await api.completeTask(id); } catch (err) { console.error(err); }
    if (res) FX.floatText(cx, cy, '+' + res.xp + ' mGal');
    await wait(quiet ? 0 : 380);
    ui.skip.delete(id);
    ui.lock--;
    ui.completing = null;
    render();
    if (!res) return;
    showToast(['Done: ', h('b', { text: t.title })], () => api.restoreTask(id), '+' + res.xp + ' mGal');
    if (res.doneToday === settings().dailyGoal) celebrateGoal();
    if (res.levelUp) setTimeout(() => levelUp(res.level), res.doneToday === settings().dailyGoal ? 900 : 250);
  }

  async function removeTask(id) {
    const rows = Array.from(document.querySelectorAll('[data-id="' + id + '"]'));
    ui.lock++;
    rows.forEach((row) => row.classList.add('leaving'));
    await wait(calm() ? 0 : 300);
    const res = await api.deleteTask(id);
    ui.lock--;
    render();
    if (res) showToast(['Deleted: ', h('b', { text: res.task.title })], () => api.reinsertTask(res.task, res.where));
  }

  function celebrateGoal() {
    const bar = $('#colorbar');
    bar.classList.remove('celebrate');
    void bar.offsetWidth;
    bar.classList.add('celebrate');
    setTimeout(() => bar.classList.remove('celebrate'), 1700);
    FX.sound.goal(volume());
    if (calm()) return;
    const r = bar.getBoundingClientRect();
    FX.burst(r.left + r.width / 2, r.top + r.height / 2, { count: 80, power: 1.2, spread: 1.6 });
    FX.burst(r.left + 20, r.top + r.height / 2, { count: 25, power: 0.9 });
    FX.burst(r.right - 20, r.top + r.height / 2, { count: 25, power: 0.9 });
  }

  function levelUp(level) {
    const el = $('#levelup');
    el.innerHTML = '';
    el.append(h('div', { class: 'card' },
      h('div', { class: 'big', text: 'Level ' + level }),
      h('div', { class: 'small', text: C.xpForLevel(level) + ' mGal of done things. Keep the anomaly growing.' })
    ));
    el.hidden = false;
    FX.sound.levelUp(volume());
    if (!calm()) FX.rain();
    clearTimeout(ui.levelTimer);
    ui.levelTimer = setTimeout(() => { el.hidden = true; }, calm() ? 1600 : 2700);
  }

  function highlight(id) {
    setView('tasks');
    closeSettings();
    ui.flashId = id;
    render();
    const row = document.querySelector('#list [data-id="' + id + '"]');
    if (row) row.scrollIntoView({ block: 'center', behavior: calm() ? 'auto' : 'smooth' });
  }

  /* -------------------------------------------------------------- toast */

  function showToast(parts, undo, xp) {
    const el = $('#toast');
    clearTimeout(ui.toastTimer);
    ui.toastUndo = undo || null;
    el.replaceChildren(
      h('p', null, parts),
      xp ? h('span', { class: 'xp', text: xp }) : null,
      undo ? h('button', { class: 'btn small', text: 'Undo', title: 'Ctrl+Z', onclick: doUndo }) : null
    );
    el.hidden = false;
    ui.toastTimer = setTimeout(hideToast, 6000);
  }
  function hideToast() { $('#toast').hidden = true; ui.toastUndo = null; }
  async function doUndo() {
    const fn = ui.toastUndo;
    hideToast();
    if (fn) await fn();
  }

  /* ------------------------------------------------------------ capture */

  const cap = {
    form: $('#capture'),
    input: $('#capture-input'),
    prio: $('#capture-prio'),
    due: $('#capture-due'),
  };

  function captureParsed() {
    const now = new Date();
    const p = C.parseQuickAdd(cap.input.value, now);
    return {
      title: p.title,
      priority: p.priority || ui.capture.priority || C.DEFAULT_PRIORITY,
      due: p.due !== undefined ? p.due : ui.capture.due,
      typedPriority: p.priority !== undefined,
      typedDue: p.due !== undefined,
    };
  }

  function stripTokens(kind) {
    const now = new Date();
    cap.input.value = cap.input.value.split(/(\s+)/).filter((tok) => {
      if (kind === 'priority' && /^(!{2,3}|![1-4])$/.test(tok)) return false;
      if (kind === 'due' && tok[0] === '@' && tok.length > 1 &&
        (C.parseWhen(tok.slice(1).toLocaleLowerCase('tr'), now) || C.parseWhen(tok.slice(1).toLowerCase(), now))) return false;
      return true;
    }).join('').replace(/\s{2,}/g, ' ');
  }

  function renderCapture() {
    const now = new Date();
    const p = captureParsed();
    cap.prio.replaceChildren(...C.PRIORITIES.map((pr) =>
      h('button', {
        type: 'button', class: 'p-' + pr.id, role: 'radio', 'aria-checked': String(p.priority === pr.id),
        onclick: () => { ui.capture.priority = pr.id; stripTokens('priority'); renderCapture(); cap.input.focus(); },
      }, h('span', { class: 'dot' }), pr.label)
    ));

    const pick = (due) => { ui.capture.due = due; stripTokens('due'); renderCapture(); cap.input.focus(); };
    const dueIs = (n) => p.due && p.due.date === C.ymd(C.addDays(now, n));
    const date = h('input', { type: 'date', 'aria-label': 'Pick a deadline date', value: p.due ? p.due.date : '' });
    date.addEventListener('change', () => pick(date.value ? { date: date.value, time: p.due ? p.due.time : null } : null));
    const time = h('input', { type: 'time', 'aria-label': 'Deadline time (optional)', value: p.due && p.due.time ? p.due.time : '', disabled: !p.due });
    time.addEventListener('change', () => p.due && pick({ date: p.due.date, time: time.value || null }));

    let resolved;
    if (p.due) {
      const fake = { due: p.due };
      const u = C.urgency(fake, now);
      const reminders = C.ALERT_OFFSETS.map((off) => C.alertAt(fake, off, settings().morningHour)).filter((d) => d > now);
      resolved = h('div', { class: 'resolved' },
        'Deadline ', h('b', { text: C.fmtDue(fake, now) }), u.level === 'over' ? ' (already past)' : '',
        reminders.length
          ? '. Reminders ' + reminders.map((d) => C.fmtDate(d, now) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')).join(' and ') + '.'
          : '. Too close for reminders.'
      );
    } else {
      resolved = h('div', { class: 'resolved', text: 'No deadline. It goes to the bottom group, sorted by priority.' });
    }

    cap.due.replaceChildren(
      h('button', { type: 'button', 'aria-pressed': String(!p.due), text: 'No deadline', onclick: () => pick(null) }),
      h('button', { type: 'button', 'aria-pressed': String(!!dueIs(0)), text: 'Today', onclick: () => pick({ date: C.ymd(now), time: null }) }),
      h('button', { type: 'button', 'aria-pressed': String(!!dueIs(1)), text: 'Tomorrow', onclick: () => pick({ date: C.ymd(C.addDays(now, 1)), time: null }) }),
      date, time, resolved
    );
  }

  function resetCapture() {
    cap.input.value = '';
    ui.capture = { priority: null, due: null };
    renderCapture();
  }

  function openCapture(open) {
    cap.form.classList.toggle('open', open || !!cap.input.value);
  }

  cap.input.addEventListener('input', () => { renderCapture(); openCapture(true); });
  cap.form.addEventListener('focusin', () => openCapture(true));
  cap.form.addEventListener('focusout', () => setTimeout(() => openCapture(cap.form.contains(document.activeElement)), 0));
  cap.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = captureParsed();
    if (!p.title) { cap.input.focus(); return; }
    // Clear first, synchronously: fast typists start the next task before the save returns.
    const typed = cap.input.value;
    const picked = { ...ui.capture };
    resetCapture();
    try {
      const t = await api.addTask({ title: p.title, priority: p.priority, due: p.due });
      ui.flashId = t.id;
      render();
    } catch (err) {
      console.error(err);
      if (!cap.input.value) { cap.input.value = typed; ui.capture = picked; renderCapture(); }
    }
  });
  cap.input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (cap.input.value) resetCapture(); else cap.input.blur(); openCapture(false); }
  });

  function focusCapture() {
    setView('tasks');
    closeSettings();
    cap.input.focus();
    cap.input.select();
    openCapture(true);
  }

  /* ------------------------------------------------------------ history */

  function renderHistory(now) {
    const st = ui.state;
    const week = Array.from({ length: 7 }, (_, i) => st.stats.doneByDay[C.ymd(C.addDays(now, -i))] || 0).reduce((a, b) => a + b, 0);
    $('#history-stats').replaceChildren(
      h('div', { class: 'stat' }, h('b', { text: String(week) }), h('span', { text: 'done in 7 days' })),
      h('div', { class: 'stat' }, h('b', { text: String(st.stats.bestDay || 0) }), h('span', { text: 'best day' })),
      h('div', { class: 'stat' }, h('b', { text: String(C.streak(st.stats.doneByDay, now)) }), h('span', { text: 'day streak' }))
    );

    const box = $('#history');
    if (!st.history.length) {
      box.replaceChildren(h('p', { class: 'empty-list', text: 'Finished tasks land here, grouped by day. Click a filled circle to bring one back.' }));
      return;
    }
    const shown = st.history.slice(0, 400);
    const groups = new Map();
    for (const t of shown) {
      const d = new Date(t.completedAt || t.createdAt);
      const key = C.ymd(d);
      if (!groups.has(key)) groups.set(key, { date: d, tasks: [] });
      groups.get(key).tasks.push(t);
    }
    const label = (d) => {
      const diff = Math.round((C.startOfDay(now) - C.startOfDay(d)) / C.DAY);
      return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : C.fmtDate(d, now);
    };
    const nodes = [];
    for (const [, g] of groups) {
      nodes.push(h('section', { class: 'group' },
        h('h2', { class: 'group-head' }, label(g.date), h('span', { class: 'n', text: String(g.tasks.length) })),
        g.tasks.map((t) => {
          const d = new Date(t.completedAt);
          const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
          return h('div', { class: 'task p-' + t.priority, 'data-id': t.id },
            h('button', { class: 'check done', html: icon('check'), title: 'Restore to open tasks', 'aria-label': 'Restore: ' + t.title, onclick: () => restore(t.id) }),
            h('div', { class: 't-main', style: 'cursor:default' },
              h('div', { class: 't-title', text: t.title }),
              h('div', { class: 't-meta' },
                h('span', { class: 'chip quiet', text: 'Done ' + hm }),
                t.xpAwarded ? h('span', { class: 'chip quiet', text: '+' + t.xpAwarded + ' mGal' }) : null,
                lateness(t, d)
              )
            ),
            h('div', { class: 't-actions' },
              h('button', { class: 'icon-btn', html: icon('undo'), title: 'Restore', 'aria-label': 'Restore', onclick: () => restore(t.id) }),
              h('button', { class: 'icon-btn', html: icon('trash'), title: 'Delete for good', 'aria-label': 'Delete', onclick: () => removeTask(t.id) })
            )
          );
        })
      ));
    }
    if (st.history.length > shown.length) nodes.push(h('p', { class: 'empty-list', text: 'Showing the latest ' + shown.length + ' of ' + st.history.length + '.' }));
    const armed = ui.clearArmed && Date.now() < ui.clearArmed;
    nodes.push(h('div', { class: 'history-foot' },
      h('button', {
        class: 'btn small' + (armed ? ' armed' : ' ghost'),
        text: armed ? 'Click again to clear ' + plural(st.history.length, 'task') : 'Clear history',
        onclick: async () => {
          if (ui.clearArmed && Date.now() < ui.clearArmed) { ui.clearArmed = null; await api.clearHistory(); return; }
          ui.clearArmed = Date.now() + 4000;
          render();
          setTimeout(() => { if (ui.clearArmed) { ui.clearArmed = null; render(); } }, 4100);
        },
      })
    ));
    box.replaceChildren(...nodes);
  }

  function lateness(t, doneAt) {
    const due = C.dueAt(t);
    if (!due) return null;
    const late = doneAt - due;
    if (late <= 0) return h('span', { class: 'chip ontime', text: 'on time' });
    const days = Math.ceil(late / C.DAY);
    return h('span', { class: 'chip quiet', text: days <= 1 ? 'a day late' : days + ' days late' });
  }

  async function restore(id) {
    const rows = Array.from(document.querySelectorAll('#history [data-id="' + id + '"]'));
    ui.lock++;
    rows.forEach((r) => r.classList.add('leaving'));
    await wait(calm() ? 0 : 300);
    const t = await api.restoreTask(id);
    ui.lock--;
    render();
    if (t) showToast(['Back on the list: ', h('b', { text: t.title })]);
  }

  /* ---------------------------------------------------------- settings */

  function sw(on, onToggle, label) {
    const b = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label });
    b.addEventListener('click', () => {
      const v = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(v));
      onToggle(v);
    });
    return b;
  }

  function choice(options, current, onPick, cls) {
    const seg = h('div', { class: 'seg ' + (cls || ''), role: 'radiogroup' });
    options.forEach(([value, label]) => {
      seg.append(h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(value === current), text: label,
        onclick: (e) => {
          seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', 'false'));
          e.currentTarget.setAttribute('aria-checked', 'true');
          onPick(value);
        },
      }));
    });
    return seg;
  }

  function setting(name, control, desc) {
    return h('div', { class: 'setting' },
      h('div', { class: 'name', text: name }),
      control && !control.classList.contains('seg') ? control : null,
      control && control.classList.contains('seg') ? h('div', { class: 'wide' }, control) : null,
      desc ? h('div', { class: 'desc', text: desc }) : null
    );
  }

  function openSettings() {
    ui.settingsOpen = true;
    const s = settings();
    const env = ui.state.env || {};
    const set = (patch) => api.setSettings(patch);
    const panel = $('#settings');

    const display = h('select', { 'aria-label': 'Screen' },
      h('option', { value: 'leftmost', text: 'Leftmost (automatic)' }),
      (env.displays || []).map((d) => h('option', { value: d.id, text: d.label }))
    );
    display.value = s.displayId;
    display.addEventListener('change', () => set({ displayId: display.value }));

    const widthLabel = h('span', { text: s.width + ' px', style: 'font-size:12px;color:var(--mute);margin-right:8px' });
    const width = h('input', { type: 'range', min: '300', max: '520', step: '10', value: String(s.width), 'aria-label': 'Panel width' });
    width.addEventListener('input', () => { widthLabel.textContent = width.value + ' px'; });
    width.addEventListener('change', () => set({ width: +width.value }));

    const hour = h('select', { 'aria-label': 'Reminder time' },
      Array.from({ length: 24 }, (_, i) => h('option', { value: String(i), text: String(i).padStart(2, '0') + ':00' })));
    hour.value = String(s.morningHour);
    hour.addEventListener('change', () => set({ morningHour: +hour.value }));

    const goalVal = h('b', { text: String(s.dailyGoal), style: 'min-width:22px;text-align:center;font-family:var(--display)' });
    let goal = s.dailyGoal;
    const step = (d) => { goal = Math.max(1, Math.min(20, goal + d)); goalVal.textContent = String(goal); set({ dailyGoal: goal }); };
    const goalCtl = h('div', { style: 'display:flex;align-items:center;gap:6px' },
      h('button', { class: 'btn small', text: '−', 'aria-label': 'Lower goal', onclick: () => step(-1) }), goalVal,
      h('button', { class: 'btn small', text: '+', 'aria-label': 'Raise goal', onclick: () => step(1) }));

    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.volume), 'aria-label': 'Volume' });
    vol.addEventListener('change', () => { set({ volume: +vol.value }); FX.sound.complete(3, +vol.value); });

    const modeName = { appbar: 'a reserved strip', ontop: 'a floating panel on top', float: 'a normal window' }[env.mode] || 'starting up';

    panel.replaceChildren(
      h('div', { class: 'head' },
        h('h2', { text: 'Settings' }),
        h('button', { class: 'icon-btn', html: icon('close'), 'aria-label': 'Close settings', onclick: closeSettings })
      ),

      h('h3', { text: 'Where the panel lives' }),
      setting('Placement', choice([['appbar', 'Reserve strip'], ['ontop', 'On top'], ['float', 'Window']], s.dockMode, (v) => set({ dockMode: v })),
        'Reserve strip works like the taskbar: maximised windows stop at the panel instead of covering it. On top floats over other windows. Window behaves like any app.'),
      setting('Screen', display, (env.displays || []).length > 1 ? 'Automatic follows whichever screen sits furthest left in Windows display settings.' : null),
      setting('Edge', choice([['left', 'Left edge'], ['right', 'Right edge']], s.edge, (v) => set({ edge: v }), 'two')),
      setting('Width', h('div', { style: 'display:flex;align-items:center' }, widthLabel, width)),

      h('h3', { text: 'Reminders' }),
      setting('Reminder time', hour, 'Deadlines without a time remind you at this hour, 3 days and 1 day before. Deadlines with a time remind you exactly 72 and 24 hours before.'),
      setting('Check that reminders reach you', h('button', { class: 'btn small', html: icon('bell') + 'Send a test', onclick: () => api.testAlert() })),

      h('h3', { text: 'Feel' }),
      setting('Daily goal', goalCtl, 'How many tasks fill the colorbar. Set it to what a decent day looks like, not a heroic one.'),
      setting('Sounds', sw(s.sound, (v) => set({ sound: v }), 'Sounds')),
      setting('Volume', vol),
      setting('Calm mode', sw(s.reduceMotion, (v) => { set({ reduceMotion: v }); document.body.classList.toggle('calm', v); }, 'Calm mode'),
        'No confetti, ripples or pulsing. Completing a task still counts.'),

      h('h3', { text: 'System' }),
      setting('Start with Windows', sw(env.openAtLogin, (v) => set({ openAtLogin: v }), 'Start with Windows')),
      setting('Graphics acceleration', sw(s.gpuAcceleration, (v) => set({ gpuAcceleration: v }), 'Graphics acceleration'),
        'Off by default: software drawing is plenty for this panel and keeps an always-on app away from the GPU driver. Applies after you quit and reopen.'),

      h('div', { class: 'buttons' },
        h('button', { class: 'btn small', text: 'Open data folder', onclick: () => api.openDataFolder() }),
        h('button', { class: 'btn small', text: 'Hide panel', onclick: () => api.hide() }),
        h('button', { class: 'btn small danger', text: 'Quit FocusDock', onclick: () => api.quit() })
      ),
      h('p', { class: 'foot', text: 'FocusDock ' + (env.version || '') + '. Running as ' + modeName + '. Ctrl+Alt+Space opens quick add from anywhere; the tray icon has the same controls.' })
    );
    panel.hidden = false;
    panel.scrollTop = 0;
  }

  function closeSettings() {
    ui.settingsOpen = false;
    $('#settings').hidden = true;
  }

  /* ------------------------------------------------------------- views */

  function setView(v) {
    ui.view = v;
    $('#view-tasks').hidden = v !== 'tasks';
    $('#view-history').hidden = v !== 'history';
    $('#tab-tasks').setAttribute('aria-selected', String(v === 'tasks'));
    $('#tab-history').setAttribute('aria-selected', String(v === 'history'));
    render();
  }

  function render() {
    if (!ui.state) return;
    if (ui.lock) { ui.dirty = true; return; }
    ui.dirty = false;
    const now = new Date();
    if (ui.lastDay !== C.ymd(now)) { ui.lastDay = C.ymd(now); drawIsolines(); }
    document.body.classList.toggle('calm', !!settings().reduceMotion);
    renderHeader(now);
    renderInbox(now);
    $('#count-tasks').textContent = String(ui.state.tasks.length);
    $('#count-history').textContent = String(ui.state.history.length);
    if (ui.view === 'tasks') {
      renderSpotlight(now);
      // Leave an open editor alone; it re-renders when it closes.
      if (!ui.editingId || !document.querySelector('.task.editing')) renderList(now);
    } else {
      renderHistory(now);
    }
  }

  /* -------------------------------------------------------------- boot */

  $('#btn-settings').innerHTML = icon('sliders');
  $('#btn-hide').innerHTML = icon('eyeOff');
  $('#btn-settings').addEventListener('click', () => (ui.settingsOpen ? closeSettings() : openSettings()));
  $('#btn-hide').addEventListener('click', () => api.hide());
  $('#tab-tasks').addEventListener('click', () => setView('tasks'));
  $('#tab-history').addEventListener('click', () => setView('history'));

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (ui.settingsOpen) { closeSettings(); return; }
      if (ui.editingId) { ui.editingId = null; render(); return; }
    }
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z') && !typing && ui.toastUndo) { e.preventDefault(); doUndo(); return; }
    if (!typing && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'n' || e.key === '/')) { e.preventDefault(); focusCapture(); }
  });

  api.onState((s) => {
    ui.state = s;
    if (ui.editingId && !findTask(ui.editingId)) ui.editingId = null;
    render();
  });
  api.onAlert((items) => {
    FX.sound.alert(volume());
    if (items.some((a) => a.test)) showTestAlert();
  });
  api.onFocusInput(() => focusCapture());
  api.onHighlight((id) => highlight(id));
  api.onNotice((text) => {
    if (Array.from(document.querySelectorAll('.notice p')).some((p) => p.textContent === text)) return;
    const n = h('div', { class: 'notice' }, h('p', { text }), h('button', { class: 'icon-btn', html: icon('close'), 'aria-label': 'Dismiss', onclick: () => n.remove() }));
    $('#notices').append(n);
  });

  // Re-render when a lock (animation) ends with pending updates, and every 30 s for countdowns.
  setInterval(() => { if (!ui.lock && ui.dirty) render(); }, 200);
  setInterval(() => { if (!ui.lock && !ui.editingId) render(); }, 30000);

  api.getState().then((s) => {
    ui.state = s;
    renderCapture();
    render();
  });
})();
