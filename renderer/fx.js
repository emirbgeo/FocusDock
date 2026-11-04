/* FocusDock effects: isoline ripples, confetti with real gravity, synthesized sounds. */
(function () {
  'use strict';

  const COLORS = ['#3D7BFF', '#1FC2B0', '#9BDB4D', '#FFB020', '#FF4F6E'];
  const canvas = document.getElementById('fx');
  const ctx = canvas.getContext('2d');
  let parts = [];
  let rings = [];
  let running = false;
  let dpr = 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
  }
  addEventListener('resize', resize);
  resize();

  function loop(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    // Isoline ripple: concentric contours spreading from the source, like an anomaly.
    rings = rings.filter((r) => t - r.t0 < r.life);
    for (const r of rings) {
      const k = (t - r.t0) / r.life;
      const radius = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 3));
      ctx.beginPath();
      ctx.lineWidth = 1.6 * (1 - k) + 0.4;
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = (1 - k) * 0.9;
      // Slightly wobbly contour, not a perfect circle.
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const wob = 1 + 0.06 * Math.sin(a * 3 + r.seed) + 0.04 * Math.sin(a * 5 + r.seed * 2);
        const x = r.x + Math.cos(a) * radius * wob;
        const y = r.y + Math.sin(a) * radius * wob * 0.92;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Confetti, falling at a scaled 9.81 m/s².
    const g = 0.32;
    parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 30);
    for (const p of parts) {
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 + g;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= 1;
      ctx.globalAlpha = Math.min(1, p.life / 30);
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if (p.shape === 0) ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      else { ctx.beginPath(); ctx.arc(0, 0, p.s / 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (parts.length || rings.length) requestAnimationFrame(loop);
    else { running = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  function kick() {
    if (!running) { running = true; requestAnimationFrame(loop); }
  }

  function burst(x, y, opts) {
    opts = opts || {};
    const n = opts.count || 24;
    const spread = opts.spread || 1;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4 * spread;
      const v = (3 + Math.random() * 5) * (opts.power || 1);
      parts.push({
        x, y,
        vx: Math.cos(a) * v + (Math.random() - 0.5) * 2,
        vy: Math.sin(a) * v,
        rot: Math.random() * 6,
        vr: (Math.random() - 0.5) * 0.4,
        s: 5 + Math.random() * 6,
        shape: Math.random() < 0.7 ? 0 : 1,
        color: (opts.colors || COLORS)[Math.floor(Math.random() * (opts.colors || COLORS).length)],
        life: 70 + Math.random() * 50,
      });
    }
    kick();
  }

  function ripple(x, y, color, count) {
    const t0 = performance.now();
    const seed = Math.random() * 10;
    for (let i = 0; i < (count || 3); i++) {
      rings.push({ x, y, color, t0: t0 + i * 110, life: 900, r0: 10, r1: 70 + i * 26, seed: seed + i });
    }
    kick();
  }

  function rain(colors) {
    for (let i = 0; i < 90; i++) {
      parts.push({
        x: Math.random() * innerWidth,
        y: -20 - Math.random() * innerHeight * 0.4,
        vx: (Math.random() - 0.5) * 2,
        vy: Math.random() * 2,
        rot: Math.random() * 6,
        vr: (Math.random() - 0.5) * 0.3,
        s: 6 + Math.random() * 6,
        shape: Math.random() < 0.7 ? 0 : 1,
        color: (colors || COLORS)[Math.floor(Math.random() * (colors || COLORS).length)],
        life: 160 + Math.random() * 60,
      });
    }
    kick();
  }

  function floatText(x, y, text) {
    const el = document.createElement('div');
    el.className = 'float-xp';
    el.textContent = text;
    el.style.left = Math.max(50, Math.min(innerWidth - 50, x)) + 'px';
    el.style.top = y - 12 + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }

  /* ---------------- sound: synthesized, no audio files ---------------- */

  let ac = null;
  function audio() {
    if (!ac) {
      try { ac = new AudioContext(); } catch (_) { return null; }
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  function tone(c, freq, at, dur, vol, type) {
    const o = c.createOscillator();
    const gn = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, at);
    gn.gain.setValueAtTime(0.0001, at);
    gn.gain.exponentialRampToValueAtTime(vol, at + 0.012);
    gn.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(gn).connect(c.destination);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  // Note frequencies (Hz)
  const N = { C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5, G6: 1568, B4: 493.88, G4: 392 };

  const sound = {
    complete(priority, vol) {
      const c = audio(); if (!c || !vol) return;
      const t = c.currentTime + 0.01;
      const v = 0.18 * vol;
      const seqs = {
        1: [N.C5, N.E5, N.G5, N.C6, N.E6],
        2: [N.D5, N.G5, N.C6, N.E6],
        3: [N.E5, N.A5, N.E6],
        4: [N.G5, N.C6],
      };
      (seqs[priority] || seqs[3]).forEach((f, i) => {
        tone(c, f, t + i * 0.055, 0.28, v, 'triangle');
        tone(c, f * 2, t + i * 0.055, 0.12, v * 0.25, 'sine');
      });
    },
    alert(vol) {
      const c = audio(); if (!c || !vol) return;
      const t = c.currentTime + 0.01;
      const v = 0.16 * vol;
      [[N.E5, 0], [N.B4, 0.16], [N.E5, 0.32], [N.G5, 0.48]].forEach(([f, d]) => tone(c, f, t + d, 0.5, v, 'sine'));
    },
    goal(vol) {
      const c = audio(); if (!c || !vol) return;
      const t = c.currentTime + 0.05;
      const v = 0.12 * vol;
      [N.C5, N.E5, N.G5, N.C6].forEach((f) => tone(c, f, t, 1.1, v, 'triangle'));
      [N.E6, N.G6].forEach((f, i) => tone(c, f, t + 0.25 + i * 0.12, 0.6, v * 0.7, 'sine'));
    },
    levelUp(vol) {
      const c = audio(); if (!c || !vol) return;
      const t = c.currentTime + 0.05;
      const v = 0.14 * vol;
      [N.G4, N.C5, N.E5, N.G5, N.C6, N.E6, N.G6].forEach((f, i) => tone(c, f, t + i * 0.07, 0.45, v, 'triangle'));
    },
  };

  window.FX = { burst, ripple, rain, floatText, sound, COLORS };
})();
