/* «Квартал» - клиент: меню, сеть, управление (пешком и за рулём), камера, отрисовка, радар, звук. */
(() => {
  'use strict';
  const KV = window.KV;
  const { G, B, W, WEAPONS, PK, CAR, STAMINA } = KV;
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const a11y = k => root.classList.contains('xx-a11y-' + k);
  const isTouch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
  if (isTouch) root.classList.add('touch');

  const CHUNK = 16;
  const INTERP_MS = 110;
  const SEND_MS = 50;
  const TP_MAX = 50;          // предел пикселей на метр (память под кэш карты)
  const STICK_R = 56;         // радиус экранного джойстика, css px
  const RADAR_SPAN = 64;      // сколько метров видно на радаре по стороне
  const RB = 4;               // пикселей на клетку в подложке радара

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const r2 = v => Math.round(v * 100) / 100;
  const r3 = v => Math.round(v * 1000) / 1000;
  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  function hash(x, y) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ======================================================================
  // Состояние
  // ======================================================================
  const S = {
    ws: null, inGame: false, leaving: false, room: '', name: '', myId: 0, map: null, retries: 0,
    players: new Map(), pickups: new Map(), bullets: new Map(), vehicles: new Map(),
    particles: [], effects: [], decals: [], hitMarks: [], pings: [], npcs: [], blasts: [], rammed: new Map(),
    me: {
      x: 0, y: 0, a: 0, tp: -1, hp: 100, ar: 0, cur: 0, ammo: [0, -1, -1, -1, -1, -1], alive: false, respawnIn: 0,
      switchAt: 0, nextShot: 0, punch: 0, vehicle: 0, stamina: STAMINA.MAX, staminaT: 0, sprinting: false,
      kvx: 0, kvy: 0, walk: 0, stepAcc: 0, moveAng: 0, moving: false
    },
    car: null, cam: { x: 0, y: 0 }, clockOff: null, lastSend: 0, emptyAt: 0, crashAt: 0, ramAt: new Map(),
    view: { tp: 24, ox: 0, oy: 0, hw: 20, hh: 12 }, tp: 0, zoomR: KV.VIEW_RADIUS, shake: 0, hurtFlash: 0, frame: 0, inGameSince: 0,
    rbase: null, rctx: null, mmNext: 0, hudNext: 0, gearOpen: false, bigOpen: false, srv: null
  };

  function makePlayer(id) {
    return { id, name: 'Игрок', color: '#cccccc', bot: false, kills: 0, deaths: 0, snaps: [], flags: 0, w: 0, hp: 100,
      rx: 0, ry: 0, ra: 0, seen: 0, punch: 0, hidden: true, walk: 0, lx: null, ly: null, mvx: 0, mvy: 0, stepAcc: 0 };
  }
  function upsertPlayer(info) {
    const [id, name, color, bot, kills, deaths] = info;
    let p = S.players.get(id);
    const isNew = !p;
    if (!p) { p = makePlayer(id); S.players.set(id, p); }
    p.name = name; p.color = color; p.bot = !!bot; p.kills = kills; p.deaths = deaths;
    return isNew;
  }
  const nameOf = id => (S.players.get(id) || {}).name || '???';

  // ======================================================================
  // Холст
  // ======================================================================
  const canvas = $('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const mini = $('minimap');
  const mctx = mini.getContext('2d');
  const big = $('bigmapCanvas');
  const bctx = big.getContext('2d');
  let cw = 0, ch = 0, dpr = 1, mdpr = 1;

  function resize() {
    const vv = window.visualViewport;
    cw = Math.max(1, Math.round(vv ? vv.width : innerWidth));
    ch = Math.max(1, Math.round(vv ? vv.height : innerHeight));
    // на больших экранах ограничиваем разрешение, чтобы кэш карты не съел память
    dpr = Math.min(window.devicePixelRatio || 1, 2, (TP_MAX * 2 * KV.VIEW_RADIUS) / Math.min(cw, ch));
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    mdpr = Math.min(window.devicePixelRatio || 1, 2);
    const rs = Math.round(clamp(Math.min(cw, ch) * 0.44, 140, 240));
    mini.width = Math.round(rs * mdpr);
    mini.height = Math.round(rs * mdpr);
    mini.style.width = mini.style.height = rs + 'px';
    const bs = Math.round(Math.min(cw, ch) * 0.86);
    big.width = Math.round(bs * mdpr);
    big.height = Math.round(bs * mdpr);
    big.style.width = big.style.height = bs + 'px';
    S.tp = 0;
    updateRotateHint();
  }
  window.addEventListener('resize', resize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

  // ======================================================================
  // Звук (синтез WebAudio, без файлов)
  // ======================================================================
  const Sound = (() => {
    let ac = null, master = null, noise = null;
    let on = true;
    try { on = localStorage.getItem('kv_sound') !== '0'; } catch (_) {}
    const engines = []; // [свой мотор, два чужих]
    function init() {
      if (!ac) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return;
        try { ac = new C(); } catch (_) { return; }
        master = ac.createGain();
        master.gain.value = on ? 0.55 : 0;
        master.connect(ac.destination);
        const len = ac.sampleRate;
        noise = ac.createBuffer(1, len, ac.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        for (let i = 0; i < 3; i++) {
          const osc = ac.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = 50;
          const f = ac.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.value = 420;
          const g = ac.createGain();
          g.gain.value = 0;
          osc.connect(f); f.connect(g); g.connect(master);
          osc.start();
          engines.push({ osc, g });
        }
      }
      if (ac.state === 'suspended') ac.resume().catch(() => {});
    }
    function vol(x, y) {
      if (x === undefined) return 1;
      const d = Math.hypot(x - S.me.x, y - S.me.y);
      return d > 42 ? 0 : Math.pow(1 - d / 42, 1.6);
    }
    function burst(o) {
      if (!ac || !on) return;
      const v = o.gain * vol(o.x, o.y);
      if (v < 0.01) return;
      const t = ac.currentTime + (o.delay || 0);
      const src = ac.createBufferSource();
      src.buffer = noise;
      src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const f = ac.createBiquadFilter();
      f.type = o.type || 'bandpass';
      f.frequency.setValueAtTime(o.freq, t);
      if (o.sweep) f.frequency.exponentialRampToValueAtTime(o.sweep, t + o.dur);
      f.Q.value = o.q || 1;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + (o.attack || 0.002));
      g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t, Math.random() * 0.4);
      src.stop(t + o.dur + 0.05);
    }
    function tone(o) {
      if (!ac || !on) return;
      const v = o.gain * vol(o.x, o.y);
      if (v < 0.01) return;
      const t = ac.currentTime + (o.delay || 0);
      const osc = ac.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.freq, t);
      if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t + o.dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
      osc.connect(g); g.connect(master);
      osc.start(t);
      osc.stop(t + o.dur + 0.05);
    }
    let stepAlt = 0;
    return {
      init,
      get on() { return on; },
      toggle() {
        on = !on;
        try { localStorage.setItem('kv_sound', on ? '1' : '0'); } catch (_) {}
        if (master) master.gain.value = on ? 0.55 : 0;
        return on;
      },
      shot(w, x, y) {
        if (w === W.PISTOL) { burst({ dur: 0.12, freq: 1800, q: 0.8, gain: 0.45, x, y, sweep: 600 }); tone({ freq: 170, dur: 0.06, gain: 0.2, type: 'triangle', slide: 60, x, y }); }
        else if (w === W.RIFLE) burst({ dur: 0.08, freq: 2200, q: 0.9, gain: 0.35, x, y, sweep: 700 });
        else if (w === W.SHOTGUN) { burst({ dur: 0.3, freq: 1100, q: 0.6, gain: 0.75, x, y, sweep: 180, type: 'lowpass' }); tone({ freq: 120, dur: 0.12, gain: 0.35, slide: 40, x, y }); }
        else if (w === W.SNIPER) { burst({ dur: 0.38, freq: 2600, q: 0.7, gain: 0.7, x, y, sweep: 300 }); tone({ freq: 90, dur: 0.2, gain: 0.35, slide: 40, x, y }); }
        else if (w === W.LAUNCHER) burst({ dur: 0.25, freq: 600, q: 0.7, gain: 0.5, x, y, type: 'lowpass', sweep: 150 });
      },
      boom(x, y) { burst({ dur: 1.1, freq: 900, q: 0.5, gain: 1, type: 'lowpass', sweep: 60, x, y, attack: 0.005 }); tone({ freq: 70, dur: 0.6, gain: 0.6, slide: 30, x, y }); },
      glass(x, y) { burst({ dur: 0.25, freq: 5000, q: 2, gain: 0.3, type: 'highpass', x, y }); tone({ freq: 2400, dur: 0.15, gain: 0.06, type: 'triangle', x, y }); },
      wood(x, y) { burst({ dur: 0.18, freq: 700, q: 1.5, gain: 0.35, x, y }); },
      brick(x, y) { burst({ dur: 0.45, freq: 420, q: 0.6, gain: 0.45, type: 'lowpass', x, y, sweep: 120 }); },
      hit() { tone({ freq: 1400, dur: 0.05, gain: 0.15, type: 'square' }); },
      hurt() { tone({ freq: 220, dur: 0.15, gain: 0.22, type: 'sawtooth', slide: 110 }); },
      pickup() { tone({ freq: 660, dur: 0.08, gain: 0.18, type: 'triangle' }); tone({ freq: 990, dur: 0.12, gain: 0.18, type: 'triangle', delay: 0.07 }); },
      empty() { tone({ freq: 1200, dur: 0.03, gain: 0.1, type: 'square' }); },
      punch(x, y) { burst({ dur: 0.08, freq: 300, q: 1, gain: 0.3, type: 'lowpass', x, y }); },
      click() { tone({ freq: 800, dur: 0.03, gain: 0.07, type: 'square' }); },
      death() { tone({ freq: 300, dur: 0.6, gain: 0.22, type: 'sawtooth', slide: 60 }); },
      metal(x, y) { burst({ dur: 0.06, freq: 3000, q: 5, gain: 0.18, x, y }); },
      // шаги: звук зависит от того, по чему идём
      step(ground, x, y, mul = 1) {
        stepAlt = 1 - stepAlt;
        const p = 1 + (stepAlt ? 0.06 : -0.06);
        if (ground === G.GRASS) burst({ dur: 0.07, freq: 520 * p, q: 0.7, gain: 0.1 * mul, type: 'lowpass', x, y });
        else if (ground === G.FLOOR) { burst({ dur: 0.06, freq: 650 * p, q: 2, gain: 0.12 * mul, x, y }); tone({ freq: 140 * p, dur: 0.05, gain: 0.05 * mul, x, y }); }
        else if (ground === G.DIRT) burst({ dur: 0.08, freq: 380 * p, q: 0.8, gain: 0.12 * mul, type: 'lowpass', x, y });
        else if (ground === G.RUBBLE || ground === G.BURNT) burst({ dur: 0.09, freq: 1900 * p, q: 0.8, gain: 0.09 * mul, type: 'highpass', x, y });
        else burst({ dur: 0.05, freq: 950 * p, q: 1.3, gain: 0.13 * mul, x, y });
      },
      horn(x, y) { tone({ freq: 410, dur: 0.38, gain: 0.16, type: 'square', x, y }); tone({ freq: 518, dur: 0.38, gain: 0.12, type: 'square', x, y }); },
      crash(x, y, s) { const g = Math.min(1, 0.3 + s / 20); burst({ dur: 0.35, freq: 700, q: 0.6, gain: 0.6 * g, type: 'lowpass', x, y, sweep: 150 }); burst({ dur: 0.12, freq: 2600, q: 6, gain: 0.25 * g, x, y }); },
      thud(x, y) { tone({ freq: 85, dur: 0.18, gain: 0.45, x, y, slide: 50 }); burst({ dur: 0.12, freq: 400, q: 0.8, gain: 0.35, type: 'lowpass', x, y }); },
      fire(x, y) { burst({ dur: 0.6, freq: 300, q: 0.6, gain: 0.4, type: 'lowpass', sweep: 1600, x, y, attack: 0.1 }); },
      doorOpen() { burst({ dur: 0.12, freq: 900, q: 3, gain: 0.15 }); },
      // моторы: свой и двух ближайших машин
      engines(list) {
        if (!ac) return;
        const t = ac.currentTime;
        for (let i = 0; i < engines.length; i++) {
          const e = engines[i], o = list[i];
          if (!o || !on) { e.g.gain.setTargetAtTime(0, t, 0.08); continue; }
          e.osc.frequency.setTargetAtTime(o.freq, t, 0.08);
          e.g.gain.setTargetAtTime(o.gain, t, 0.08);
        }
      }
    };
  })();

  // ======================================================================
  // Карта: приём, палитра, кэш кусков, подложка радара
  // ======================================================================
  const GC = [];
  GC[G.GRASS] = [76, 118, 56]; GC[G.ROAD] = [56, 59, 64]; GC[G.WALK] = [136, 134, 128]; GC[G.FLOOR] = [146, 108, 74];
  GC[G.RUBBLE] = [108, 98, 90]; GC[G.DIRT] = [132, 106, 74]; GC[G.WATER] = [44, 106, 138]; GC[G.LOT] = [82, 85, 90]; GC[G.BURNT] = [40, 36, 34];
  const c255 = v => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  const rgb = (c, d = 0) => `rgb(${c255(c[0] + d)},${c255(c[1] + d)},${c255(c[2] + d)})`;
  const CAR_COLORS = ['#c0392b', '#2471a3', '#229954', '#d68910', '#7d3c98', '#d0d3d4', '#2c3e50', '#17a589'];
  const ROOFS = [['#5d6d7e', '#4d5b69'], ['#8e5b3a', '#7a4d30'], ['#6b6b5e', '#5a5a4f'], ['#3f5e5a', '#34504c'], ['#7b3f3f', '#683535'], ['#5b4f6e', '#4c425d']];
  const DEBRIS = {};
  DEBRIS[B.BRICK] = '#9c4a3a'; DEBRIS[B.CONCRETE] = '#a3a3a3'; DEBRIS[B.GLASS] = '#c6ecf8'; DEBRIS[B.FENCE] = '#7a5530';
  DEBRIS[B.CRATE] = '#a87b45'; DEBRIS[B.TREE] = '#3e6e2c'; DEBRIS[B.BARREL] = '#b8322a'; DEBRIS[B.CAR] = '#555555'; DEBRIS[B.BENCH] = '#7a5532';

  function setupMap(m) {
    const n = m.w * m.h;
    const map = {
      w: m.w, h: m.h, ground: KV.rleDecode(m.g, n), block: KV.rleDecode(m.b, n), dmg: new Uint8Array(n),
      owner: new Int16Array(n).fill(-1), buildings: [], roads: m.roads,
      vBand: new Int16Array(m.w).fill(-1), hBand: new Int16Array(m.h).fill(-1)
    };
    for (let i = 0; i + 1 < m.d.length; i += 2) map.dmg[m.d[i]] = m.d[i + 1];
    m.bld.forEach(([x, y, w, h, roof], id) => {
      map.buildings.push({ id, x, y, w, h, roof: !!roof, alpha: roof ? 1 : 0, pal: ROOFS[Math.floor(hash(x * 7, y * 13) * ROOFS.length)] });
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) map.owner[j * m.w + i] = id;
    });
    m.roads.x.forEach(([s, w], i) => { for (let x = s; x < s + w; x++) map.vBand[x] = i; });
    m.roads.y.forEach(([s, h], i) => { for (let y = s; y < s + h; y++) map.hBand[y] = i; });
    return map;
  }

  const tileAt = (x, y) => (x < 0 || y < 0 || x >= S.map.w || y >= S.map.h ? -1 : y * S.map.w + x);
  const blockAt = (x, y) => { const k = tileAt(x, y); return k < 0 ? B.BORDER : S.map.block[k]; };

  function shade(r, g, b, h, st) {
    const d = (h - 0.5) * 14 - st * 14;
    return `rgb(${c255(r + d)},${c255(g + d)},${c255(b + d)})`;
  }

  function drawGround(g, x, y, t) {
    const h = hash(x, y);
    const c = GC[t] || GC[G.GRASS];
    g.fillStyle = rgb(c, (h - 0.5) * (t === G.GRASS ? 16 : 8));
    g.fillRect(x, y, 1, 1);
    const h2 = hash(y + 101, x + 37), h3 = hash(x + 59, y + 211);
    switch (t) {
      case G.GRASS:
        g.fillStyle = 'rgba(28,58,20,0.28)';
        if (h > 0.3) g.fillRect(x + h2 * 0.8, y + h3 * 0.75, 0.06, 0.18);
        if (h > 0.6) g.fillRect(x + h3 * 0.8, y + h2 * 0.75, 0.06, 0.16);
        if (h > 0.93) { g.fillStyle = h2 > 0.5 ? '#e8d34a' : '#e86a8c'; g.fillRect(x + h2 * 0.7 + 0.1, y + h3 * 0.7 + 0.1, 0.1, 0.1); }
        break;
      case G.WALK:
        g.fillStyle = 'rgba(0,0,0,0.13)';
        g.fillRect(x, y, 1, 0.035); g.fillRect(x, y, 0.035, 1);
        break;
      case G.FLOOR:
        g.fillStyle = 'rgba(70,40,18,0.25)';
        for (let i = 1; i < 4; i++) g.fillRect(x, y + i * 0.25 - 0.012, 1, 0.024);
        for (let i = 0; i < 4; i++) g.fillRect(x + ((h * 4 + i * 0.37) % 1), y + i * 0.25, 0.024, 0.25);
        break;
      case G.ROAD: case G.LOT:
        g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(x + h2 * 0.85, y + h3 * 0.85, 0.08, 0.08);
        g.fillStyle = 'rgba(0,0,0,0.14)'; g.fillRect(x + h3 * 0.85, y + h * 0.85, 0.09, 0.09);
        break;
      case G.RUBBLE:
        g.fillStyle = 'rgba(70,58,50,0.9)';
        g.fillRect(x + h2 * 0.7, y + h3 * 0.7, 0.22, 0.16);
        g.fillRect(x + h3 * 0.75, y + h * 0.7, 0.16, 0.2);
        g.fillStyle = 'rgba(160,80,60,0.75)';
        g.fillRect(x + h * 0.7, y + h2 * 0.7, 0.2, 0.12);
        break;
      case G.DIRT:
        g.fillStyle = 'rgba(80,60,40,0.35)';
        g.fillRect(x + h2 * 0.85, y + h3 * 0.85, 0.1, 0.08);
        g.fillRect(x + h3 * 0.8, y + h * 0.8, 0.07, 0.07);
        break;
      case G.WATER:
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fillRect(x + 0.1 + h2 * 0.4, y + 0.25 + h3 * 0.5, 0.35, 0.04);
        break;
      case G.BURNT:
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x + h2 * 0.6, y + h3 * 0.6, 0.4, 0.3);
        break;
    }
  }

  function drawRoadMarks(g, map, x, y) {
    const vb = map.vBand[x], hb = map.hBand[y];
    if (vb >= 0 && hb >= 0) return; // перекрёсток
    if (vb >= 0) {
      const s = map.roads.x[vb][0];
      const nearCross = [-2, -1, 1, 2].some(d => y + d >= 0 && y + d < map.h && map.hBand[y + d] >= 0);
      g.fillStyle = 'rgba(235,235,225,0.7)';
      if (nearCross) { g.fillRect(x + 0.1, y + 0.08, 0.32, 0.84); g.fillRect(x + 0.58, y + 0.08, 0.32, 0.84); }
      else if (x === s + 1 && y % 3 !== 0) { g.fillStyle = 'rgba(240,210,90,0.8)'; g.fillRect(x + 0.95, y + 0.1, 0.1, 0.8); }
    } else if (hb >= 0) {
      const s = map.roads.y[hb][0];
      const nearCross = [-2, -1, 1, 2].some(d => x + d >= 0 && x + d < map.w && map.vBand[x + d] >= 0);
      g.fillStyle = 'rgba(235,235,225,0.7)';
      if (nearCross) { g.fillRect(x + 0.08, y + 0.1, 0.84, 0.32); g.fillRect(x + 0.08, y + 0.58, 0.84, 0.32); }
      else if (y === s + 1 && x % 3 !== 0) { g.fillStyle = 'rgba(240,210,90,0.8)'; g.fillRect(x + 0.1, y + 0.95, 0.8, 0.1); }
    }
  }

  function drawCracks(g, x, y, st, h) {
    let s = Math.floor(h * 233280);
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    g.strokeStyle = 'rgba(25,12,6,0.8)';
    g.lineWidth = 0.05;
    g.beginPath();
    for (let i = 0; i < st * 2; i++) {
      const cx = x + 0.15 + rnd() * 0.7, cy = y + 0.15 + rnd() * 0.7;
      g.moveTo(cx, cy);
      const mx = cx + (rnd() - 0.5) * 0.45, my = cy + (rnd() - 0.5) * 0.45;
      g.lineTo(mx, my);
      g.lineTo(mx + (rnd() - 0.5) * 0.35, my + (rnd() - 0.5) * 0.35);
    }
    g.stroke();
  }

  const isFence = (x, y) => blockAt(x, y) === B.FENCE;
  const CASTS_SHADOW = new Set([B.BORDER, B.BRICK, B.CONCRETE, B.GLASS, B.CRATE]);

  function drawBlock(g, x, y, t, st) {
    const h = hash(x, y);
    switch (t) {
      case B.BORDER:
        g.fillStyle = '#1d1f24'; g.fillRect(x, y, 1, 1);
        g.fillStyle = (x + y) % 2 ? '#b8931f' : '#2a2c31'; g.fillRect(x + 0.18, y + 0.18, 0.64, 0.64);
        break;
      case B.BRICK: {
        g.fillStyle = shade(156, 74, 58, h, st); g.fillRect(x, y, 1, 1);
        g.fillStyle = 'rgba(70,30,20,0.55)';
        for (let i = 1; i < 4; i++) g.fillRect(x, y + i * 0.25 - 0.02, 1, 0.04);
        for (let r = 0; r < 4; r++) {
          const off = (r % 2) * 0.25;
          g.fillRect(x + off + 0.23, y + r * 0.25, 0.04, 0.25);
          g.fillRect(x + off + 0.73, y + r * 0.25, 0.04, 0.25);
        }
        g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, y, 1, 0.06);
        break;
      }
      case B.CONCRETE:
        g.fillStyle = shade(158, 160, 162, h, st); g.fillRect(x + 0.04, y + 0.04, 0.92, 0.92);
        g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 0.05; g.strokeRect(x + 0.12, y + 0.12, 0.76, 0.76);
        break;
      case B.GLASS:
        g.fillStyle = '#4b3d30'; g.fillRect(x, y, 1, 1);
        g.fillStyle = st ? 'rgba(170,210,226,0.9)' : 'rgba(150,212,238,0.92)'; g.fillRect(x + 0.1, y + 0.1, 0.8, 0.8);
        g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(x + 0.2, y + 0.18, 0.07, 0.5);
        break;
      case B.FENCE: {
        const horiz = isFence(x - 1, y) || isFence(x + 1, y) || !(isFence(x, y - 1) || isFence(x, y + 1));
        g.fillStyle = 'rgba(0,0,0,0.22)';
        if (horiz) g.fillRect(x, y + 0.5, 1, 0.22); else g.fillRect(x + 0.5, y, 0.22, 1);
        g.fillStyle = shade(122, 85, 48, h, st);
        if (horiz) g.fillRect(x, y + 0.38, 1, 0.24); else g.fillRect(x + 0.38, y, 0.24, 1);
        g.fillStyle = '#4e331b';
        if (horiz) g.fillRect(x + 0.42, y + 0.3, 0.16, 0.4); else g.fillRect(x + 0.3, y + 0.42, 0.4, 0.16);
        break;
      }
      case B.CRATE:
        g.fillStyle = shade(168, 123, 69, h, st); g.fillRect(x + 0.06, y + 0.06, 0.88, 0.88);
        g.strokeStyle = '#6b4a22'; g.lineWidth = 0.07;
        g.strokeRect(x + 0.12, y + 0.12, 0.76, 0.76);
        g.beginPath(); g.moveTo(x + 0.14, y + 0.14); g.lineTo(x + 0.86, y + 0.86); g.moveTo(x + 0.86, y + 0.14); g.lineTo(x + 0.14, y + 0.86); g.stroke();
        break;
      case B.TREE:
        g.fillStyle = '#5a3d22'; g.beginPath(); g.arc(x + 0.5, y + 0.5, 0.2, 0, Math.PI * 2); g.fill();
        break;
      case B.BARREL:
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.arc(x + 0.58, y + 0.58, 0.38, 0, Math.PI * 2); g.fill();
        g.fillStyle = st ? '#8f2a22' : '#b8322a'; g.beginPath(); g.arc(x + 0.5, y + 0.5, 0.38, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#6d1a15'; g.lineWidth = 0.06; g.beginPath(); g.arc(x + 0.5, y + 0.5, 0.27, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#f1c40f'; g.beginPath(); g.moveTo(x + 0.5, y + 0.36); g.lineTo(x + 0.62, y + 0.58); g.lineTo(x + 0.38, y + 0.58); g.closePath(); g.fill();
        break;
      case B.BENCH:
        g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(x + 0.14, y + 0.24, 0.84, 0.62);
        g.fillStyle = shade(122, 85, 50, h, st);
        g.fillRect(x + 0.08, y + 0.16, 0.84, 0.16); g.fillRect(x + 0.08, y + 0.4, 0.84, 0.16); g.fillRect(x + 0.08, y + 0.64, 0.84, 0.16);
        break;
    }
    if (st > 0 && (t === B.BRICK || t === B.CONCRETE || t === B.GLASS || t === B.CRATE || t === B.BENCH)) drawCracks(g, x, y, st, h);
  }

  // --- кэш кусков 16x16 м ---
  const chunks = new Map();
  function dirtyAround(x, y) {
    const seen = new Set();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = ((y + dy) >> 4) * 64 + ((x + dx) >> 4);
        if (seen.has(key)) continue;
        seen.add(key);
        const c = chunks.get(key);
        if (c) c.dirty = true;
      }
    }
  }

  function renderChunk(c, cx, cy, tp) {
    const map = S.map;
    const size = CHUNK * tp;
    if (c.cv.width !== size) { c.cv.width = size; c.cv.height = size; }
    const g = c.cv.getContext('2d');
    g.setTransform(tp, 0, 0, tp, -cx * CHUNK * tp, -cy * CHUNK * tp);
    const x0 = cx * CHUNK, y0 = cy * CHUNK;
    const x1 = Math.min(map.w, x0 + CHUNK), y1 = Math.min(map.h, y0 + CHUNK);
    g.fillStyle = '#0b0c0f'; g.fillRect(x0, y0, CHUNK, CHUNK);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) drawGround(g, x, y, map.ground[y * map.w + x]);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (map.ground[y * map.w + x] === G.ROAD) drawRoadMarks(g, map, x, y);
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.beginPath();
    for (let y = Math.max(0, y0 - 1); y < y1; y++) {
      for (let x = Math.max(0, x0 - 1); x < x1; x++) {
        if (CASTS_SHADOW.has(map.block[y * map.w + x])) g.rect(x + 0.2, y + 0.2, 1, 1);
      }
    }
    g.fill();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const k = y * map.w + x;
        const t = map.block[k];
        if (t !== B.NONE && t !== B.CAR) drawBlock(g, x, y, t, map.dmg[k]);
      }
    }
    c.tp = tp;
    c.dirty = false;
  }

  function getChunk(cx, cy) {
    const key = cy * 64 + cx;
    let c = chunks.get(key);
    if (!c) { c = { cv: document.createElement('canvas'), tp: 0, dirty: true, used: 0 }; chunks.set(key, c); }
    return c;
  }

  function drawChunks(x0, y0, x1, y1, tp) {
    const map = S.map;
    const nx = Math.ceil(map.w / CHUNK), ny = Math.ceil(map.h / CHUNK);
    const cx0 = Math.max(0, Math.floor(x0 / CHUNK)), cy0 = Math.max(0, Math.floor(y0 / CHUNK));
    const cx1 = Math.min(nx - 1, Math.floor(x1 / CHUNK)), cy1 = Math.min(ny - 1, Math.floor(y1 / CHUNK));
    let budget = 3;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = getChunk(cx, cy);
        if (c.tp === 0 || ((c.dirty || c.tp !== tp) && budget-- > 0)) renderChunk(c, cx, cy, tp);
        c.used = S.frame;
        ctx.drawImage(c.cv, cx * CHUNK, cy * CHUNK, CHUNK, CHUNK);
      }
    }
    // заранее готовим куски вокруг экрана, чтобы на бегу не было подтормаживаний
    let pre = Math.max(0, Math.min(2, budget));
    for (let cy = cy0 - 1; cy <= cy1 + 1 && pre > 0; cy++) {
      for (let cx = cx0 - 1; cx <= cx1 + 1 && pre > 0; cx++) {
        if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) continue;
        if (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1) continue;
        const c = getChunk(cx, cy);
        c.used = S.frame;
        if (c.tp !== tp || c.dirty) { renderChunk(c, cx, cy, tp); pre--; }
      }
    }
    if (chunks.size > 48) {
      const old = [...chunks.entries()].filter(([, c]) => c.used !== S.frame).sort((a, b) => a[1].used - b[1].used);
      for (let i = 0; i < old.length && chunks.size > 40; i++) chunks.delete(old[i][0]);
    }
  }

  // --- подложка радара: 4 пикселя на клетку, подробно ---
  function radarTile(k) {
    const map = S.map, g = S.rctx;
    const x = (k % map.w) * RB, y = Math.floor(k / map.w) * RB;
    const t = map.block[k], gr = map.ground[k];
    let c = GC[gr] || GC[G.GRASS];
    if (gr === G.ROAD) c = [62, 65, 71];
    else if (gr === G.WALK) c = [128, 126, 120];
    else if (gr === G.GRASS) c = [70, 120, 52];
    g.fillStyle = rgb(c);
    g.fillRect(x, y, RB, RB);
    if (gr === G.ROAD) {
      const vb = map.vBand[k % map.w], hb = map.hBand[Math.floor(k / map.w)];
      if (vb >= 0 && hb < 0 && (k % map.w) === map.roads.x[vb][0] + 1) { g.fillStyle = '#c9a93a'; g.fillRect(x + RB - 1, y + 1, 1, RB - 2); }
      if (hb >= 0 && vb < 0 && Math.floor(k / map.w) === map.roads.y[hb][0] + 1) { g.fillStyle = '#c9a93a'; g.fillRect(x + 1, y + RB - 1, RB - 2, 1); }
    }
    switch (t) {
      case B.BORDER: g.fillStyle = '#0d0d0f'; g.fillRect(x, y, RB, RB); break;
      case B.BRICK: g.fillStyle = '#8a3b2c'; g.fillRect(x, y, RB, RB); break;
      case B.CONCRETE: g.fillStyle = '#a6a6a6'; g.fillRect(x + 0.5, y + 0.5, RB - 1, RB - 1); break;
      case B.GLASS: g.fillStyle = '#9fd6ee'; g.fillRect(x, y, RB, RB); break;
      case B.FENCE: g.fillStyle = '#6e4b2a'; g.fillRect(x + 1, y + 1, RB - 2, RB - 2); break;
      case B.CRATE: g.fillStyle = '#b48448'; g.fillRect(x + 0.5, y + 0.5, RB - 1, RB - 1); g.fillStyle = '#6b4a22'; g.fillRect(x + 1.5, y + 1.5, 1, 1); break;
      case B.TREE: g.fillStyle = '#2c5e22'; g.beginPath(); g.arc(x + RB / 2, y + RB / 2, RB * 0.62, 0, Math.PI * 2); g.fill(); break;
      case B.BARREL: g.fillStyle = '#d0392f'; g.beginPath(); g.arc(x + RB / 2, y + RB / 2, RB * 0.4, 0, Math.PI * 2); g.fill(); break;
      case B.BENCH: g.fillStyle = '#7a5532'; g.fillRect(x + 0.5, y + 1, RB - 1, RB - 2); break;
    }
  }
  function buildRadarBase() {
    const map = S.map;
    S.rbase = document.createElement('canvas');
    S.rbase.width = map.w * RB;
    S.rbase.height = map.h * RB;
    S.rctx = S.rbase.getContext('2d');
    for (let k = 0; k < map.w * map.h; k++) radarTile(k);
  }

  // ======================================================================
  // Частицы, вспышки, следы
  // ======================================================================
  function maxParticles() { return a11y('motion') ? 140 : 450; }
  function spawn(kind, x, y, n, color, speed = 4, life = 0.6, size = 0.12, ang = null, spread = Math.PI * 2) {
    if (a11y('motion')) n = Math.ceil(n * 0.4);
    for (let i = 0; i < n && S.particles.length < maxParticles(); i++) {
      const a = ang === null ? Math.random() * Math.PI * 2 : ang + (Math.random() - 0.5) * spread;
      const v = speed * (0.35 + Math.random() * 0.65);
      const l = life * (0.6 + Math.random() * 0.6);
      S.particles.push({ kind, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: l, max: l, size: size * (0.6 + Math.random() * 0.8), color });
    }
  }
  function addDecal(kind, x, y, r) {
    S.decals.push({ kind, x, y, r, t0: performance.now(), rot: Math.random() * 6 });
    if (S.decals.length > 90) S.decals.shift();
  }

  function updateParticles(dt) {
    const ps = S.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        if (p.kind === 'blood' && Math.random() < 0.25) addDecal('blood', p.x, p.y, 0.12 + Math.random() * 0.1);
        ps[i] = ps[ps.length - 1]; ps.pop();
        continue;
      }
      const drag = p.kind === 'smoke' || p.kind === 'dust' || p.kind === 'fire' ? 1.5 : 5;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const f = Math.exp(-drag * dt);
      p.vx *= f; p.vy *= f;
      if (p.kind === 'smoke' || p.kind === 'dust') p.size += dt * 0.8;
      if (p.kind === 'fire') p.size *= 1 - dt * 0.8;
    }
    const now = performance.now();
    for (let i = S.effects.length - 1; i >= 0; i--) if (now - S.effects[i].t0 > 700) S.effects.splice(i, 1);
    for (let i = S.npcs.length - 1; i >= 0; i--) {
      const n = S.npcs[i];
      const age = (now - n.t0) / 1000;
      if (age > 2.8) { S.npcs.splice(i, 1); continue; }
      const [nx, ny] = KV.moveCircle(S.map, n.x, n.y, Math.cos(n.a) * 6.5 * dt, Math.sin(n.a) * 6.5 * dt, KV.PLAYER_R);
      n.walk += Math.hypot(nx - n.x, ny - n.y) * 4.8;
      n.x = nx; n.y = ny;
    }
  }

  function drawParticles(high) {
    for (const p of S.particles) {
      const isHigh = p.kind === 'smoke' || p.kind === 'fire';
      if (isHigh !== high) continue;
      const a = p.life / p.max;
      if (p.kind === 'spark') {
        ctx.strokeStyle = `rgba(255,214,120,${a})`;
        ctx.lineWidth = 0.05;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
      } else if (p.kind === 'smoke' || p.kind === 'dust') {
        ctx.globalAlpha = a * (p.kind === 'smoke' ? 0.45 : 0.35);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.kind === 'flash' || p.kind === 'fire') {
        ctx.globalAlpha = Math.min(1, a * 1.3);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.02, p.size), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = Math.min(1, a * 1.5);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawDecals(now, inView) {
    for (const d of S.decals) {
      if (!inView(d.x - 2, d.y - 2, 4, 4)) continue;
      const age = (now - d.t0) / 1000;
      const a = age > 40 ? Math.max(0, 1 - (age - 40) / 10) : 1;
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      if (d.kind === 'scorch') {
        const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r);
        g.addColorStop(0, 'rgba(10,8,6,0.75)'); g.addColorStop(0.6, 'rgba(20,16,12,0.45)'); g.addColorStop(1, 'rgba(20,16,12,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(110,8,8,0.8)';
        ctx.beginPath(); ctx.ellipse(d.x, d.y, d.r, d.r * 0.7, d.rot, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    if (S.decals.length && (now - S.decals[0].t0) / 1000 > 50) S.decals.shift();
  }

  function explosionEffect(x, y, r) {
    S.effects.push({ x, y, r, t0: performance.now() });
    S.blasts.push({ x, y, t0: performance.now() });
    spawn('smoke', x, y, 14, '#6b6b6b', 2.5, 2.2, 0.5);
    spawn('spark', x, y, 18, '#ffd27a', 12, 0.4, 0.05);
    spawn('debris', x, y, 12, '#3a3530', 7, 0.8, 0.14);
    spawn('flash', x, y, 6, '#ffb347', 3, 0.35, 0.6);
    addDecal('scorch', x, y, r * 0.75);
    Sound.boom(x, y);
    const d = Math.hypot(x - S.me.x, y - S.me.y);
    if (!a11y('motion')) S.shake = Math.max(S.shake, clamp(1.6 - d / 14, 0, 1.4));
  }

  function drawEffects(now) {
    for (const e of S.effects) {
      const k = (now - e.t0) / 700;
      if (k >= 1) continue;
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r * (0.4 + k));
      g.addColorStop(0, `rgba(255,255,220,${(1 - k) * 0.95})`);
      g.addColorStop(0.35, `rgba(255,170,60,${(1 - k) * 0.8})`);
      g.addColorStop(1, 'rgba(255,90,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.4 + k), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${(1 - k) * 0.4})`;
      ctx.lineWidth = 0.12;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 1.5 * k, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // ======================================================================
  // Объекты мира: деревья, машины, крыши, оружие, люди, пули
  // ======================================================================
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r);
    else { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  }

  function drawCanopies(x0, y0, x1, y1) {
    const map = S.map;
    const ax = Math.max(0, Math.floor(x0) - 1), ay = Math.max(0, Math.floor(y0) - 1);
    const bx = Math.min(map.w - 1, Math.ceil(x1) + 1), by = Math.min(map.h - 1, Math.ceil(y1) + 1);
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const k = y * map.w + x;
        if (map.block[k] !== B.TREE) continue;
        const h = hash(x, y), st = map.dmg[k];
        const r = 0.82 + h * 0.18 - st * 0.13;
        // свой персонаж под кроной всегда виден: крона над ним становится полупрозрачной
        ctx.globalAlpha = S.me.alive && Math.hypot(S.me.x - x - 0.5, S.me.y - y - 0.5) < r + 0.6 ? 0.4 : 1;
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath(); ctx.arc(x + 0.68, y + 0.68, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgb(${46 + h * 18 | 0},${92 + h * 26 - st * 10 | 0},${36 + h * 10 | 0})`;
        ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.beginPath(); ctx.arc(x + 0.36, y + 0.34, r * 0.55, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.beginPath(); ctx.arc(x + 0.68, y + 0.62, r * 0.38, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Машина: a - курс (0 - на восток). Модель рисуется носом вверх, поэтому поворот a + 90°.
  function drawVehicle(x, y, a, colorIdx, st, fl, speed, mine) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + Math.PI / 2);
    if (Math.abs(speed) > 1 && !(fl & 2)) {
      // свет фар
      const g = ctx.createLinearGradient(0, -2, 0, -6.5);
      g.addColorStop(0, 'rgba(255,245,190,0.16)'); g.addColorStop(1, 'rgba(255,245,190,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(-0.8, -1.95); ctx.lineTo(0.8, -1.95); ctx.lineTo(1.7, -6.5); ctx.lineTo(-1.7, -6.5); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    roundRect(ctx, -0.72, -1.72, 1.7, 3.8, 0.4); ctx.fill();
    ctx.fillStyle = CAR_COLORS[colorIdx] || '#888';
    roundRect(ctx, -0.95, -2.0, 1.9, 4.0, 0.45); ctx.fill();
    if (st) { ctx.fillStyle = `rgba(0,0,0,${0.14 * st})`; roundRect(ctx, -0.95, -2.0, 1.9, 4.0, 0.45); ctx.fill(); }
    if (mine) { ctx.strokeStyle = 'rgba(255,210,63,0.9)'; ctx.lineWidth = 0.08; roundRect(ctx, -0.95, -2.0, 1.9, 4.0, 0.45); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    roundRect(ctx, -0.72, -0.58, 1.44, 1.56, 0.18); ctx.fill();
    ctx.fillStyle = '#1b2631';
    roundRect(ctx, -0.76, -1.24, 1.52, 0.6, 0.14); ctx.fill();
    roundRect(ctx, -0.7, 1.02, 1.4, 0.44, 0.1); ctx.fill();
    ctx.fillStyle = '#fff6c2';
    ctx.fillRect(-0.8, -2.02, 0.36, 0.12); ctx.fillRect(0.44, -2.02, 0.36, 0.12);
    const brake = fl & 1;
    ctx.fillStyle = brake ? '#ff2a2a' : '#a8241c';
    ctx.fillRect(-0.8, 1.9, 0.32, brake ? 0.16 : 0.1); ctx.fillRect(0.48, 1.9, 0.32, brake ? 0.16 : 0.1);
    if (brake) {
      ctx.fillStyle = 'rgba(255,40,40,0.25)';
      ctx.beginPath(); ctx.arc(-0.64, 2.05, 0.35, 0, Math.PI * 2); ctx.arc(0.64, 2.05, 0.35, 0, Math.PI * 2); ctx.fill();
    }
    if (st >= 2) { ctx.strokeStyle = 'rgba(20,10,5,0.7)'; ctx.lineWidth = 0.06; ctx.beginPath(); ctx.moveTo(-0.5, -1.5); ctx.lineTo(0.1, -1); ctx.lineTo(0.4, -1.6); ctx.stroke(); }
    ctx.restore();
    const hx = x + Math.cos(a) * 1.4, hy = y + Math.sin(a) * 1.4;
    if (fl & 2) {
      if (Math.random() < 0.7) spawn('fire', hx + (Math.random() - 0.5) * 1.2, hy + (Math.random() - 0.5) * 1.2, 1, Math.random() < 0.5 ? '#ff7a1a' : '#ffc23a', 0.8, 0.45, 0.42);
      if (Math.random() < 0.3) spawn('smoke', hx, hy, 1, '#333', 0.8, 1.8, 0.4);
    } else if (st >= 2 && Math.random() < (st === 3 ? 0.25 : 0.08)) spawn('smoke', hx, hy, 1, st === 3 ? '#3a3a3a' : '#666', 0.6, 1.6, 0.3);
  }

  function myBuilding() {
    if (!S.map) return -1;
    const k = tileAt(Math.floor(S.cam.x), Math.floor(S.cam.y));
    return k < 0 ? -1 : S.map.owner[k];
  }

  function drawRoofs(dt, inView, myB) {
    for (const b of S.map.buildings) {
      const target = b.roof ? (b.id === myB ? 0.1 : 1) : 0;
      b.alpha += (target - b.alpha) * Math.min(1, dt * 7);
      if (b.alpha < 0.02 || !inView(b.x, b.y, b.w, b.h)) continue;
      const x = b.x + 0.75, y = b.y + 0.75, w = b.w - 1.5, h = b.h - 1.5;
      ctx.globalAlpha = b.alpha;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x + 0.25, y + 0.25, w, h);
      ctx.fillStyle = b.pal[0];
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = b.pal[1];
      if (w >= h) ctx.fillRect(x, y + h / 2, w, h / 2); else ctx.fillRect(x + w / 2, y, w / 2, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      if (w >= h) { ctx.moveTo(x + 0.3, y + h / 2); ctx.lineTo(x + w - 0.3, y + h / 2); }
      else { ctx.moveTo(x + w / 2, y + 0.3); ctx.lineTo(x + w / 2, y + h - 0.3); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 0.1;
      ctx.strokeRect(x, y, w, h);
      const hv = hash(b.x, b.y);
      ctx.fillStyle = 'rgba(200,200,200,0.55)';
      ctx.fillRect(x + w * (0.15 + hv * 0.3), y + h * (0.2 + hv * 0.15), 0.8, 0.8);
      ctx.fillStyle = 'rgba(40,40,40,0.5)';
      ctx.fillRect(x + w * (0.6 + hv * 0.2), y + h * 0.65, 0.6, 0.6);
      ctx.globalAlpha = 1;
    }
  }

  const GUN = [null,
    { len: 0.36, wid: 0.11, col: '#262626' },
    { len: 0.78, wid: 0.13, col: '#34362c' },
    { len: 0.72, wid: 0.12, col: '#5a3b22' },
    { len: 1.0, wid: 0.1, col: '#2c3a2c' },
    { len: 0.84, wid: 0.2, col: '#4a5a3a' }];
  function drawGunShape(g, w) {
    const s = GUN[w];
    if (!s) return;
    g.fillStyle = s.col;
    g.fillRect(0, -s.wid / 2, s.len, s.wid);
    g.fillStyle = 'rgba(0,0,0,0.45)';
    if (w === W.RIFLE) g.fillRect(0.3, s.wid / 2, 0.1, 0.14);
    if (w === W.SNIPER) g.fillRect(0.25, -0.13, 0.32, 0.08);
    if (w === W.SHOTGUN) g.fillRect(0.38, -s.wid / 2 - 0.03, 0.18, s.wid + 0.06);
    if (w === W.LAUNCHER) { g.fillStyle = '#1b1b1b'; g.fillRect(s.len - 0.08, -s.wid / 2, 0.08, s.wid); }
  }

  // Вещь на земле: заметно светится, от неё расходятся круги
  function drawPickup(pk, t) {
    const bob = Math.sin(t * 3 + pk.id) * 0.06;
    const col = pk.kind === PK.WEAPON ? '255,210,63' : pk.kind === PK.AMMO ? '230,180,50' : pk.kind === PK.HEALTH ? '255,80,80' : '110,180,255';
    ctx.save();
    ctx.translate(pk.x, pk.y);
    if (pk.kind !== PK.AMMO) {
      for (let i = 0; i < 2; i++) {
        const k = ((t * 0.8 + i * 0.5 + pk.id * 0.13) % 1);
        ctx.strokeStyle = `rgba(${col},${(1 - k) * 0.7})`;
        ctx.lineWidth = 0.07;
        ctx.beginPath(); ctx.arc(0, 0, 0.5 + k * 0.9, 0, Math.PI * 2); ctx.stroke();
      }
    }
    const glow = ctx.createRadialGradient(0, 0, 0.05, 0, 0, 0.75);
    glow.addColorStop(0, `rgba(${col},0.55)`); glow.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, 0.75, 0, Math.PI * 2); ctx.fill();
    ctx.translate(0, bob);
    ctx.scale(1.25, 1.25);
    if (pk.kind === PK.WEAPON) {
      ctx.rotate(-0.5);
      ctx.translate(-GUN[pk.w].len / 2, 0);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 0.05;
      ctx.strokeRect(-0.02, -GUN[pk.w].wid / 2 - 0.02, GUN[pk.w].len + 0.04, GUN[pk.w].wid + 0.04);
      drawGunShape(ctx, pk.w);
    } else if (pk.kind === PK.AMMO) {
      ctx.fillStyle = '#4b5a2a'; ctx.fillRect(-0.28, -0.2, 0.56, 0.4);
      ctx.fillStyle = '#e8c35a';
      for (let i = 0; i < 3; i++) ctx.fillRect(-0.2 + i * 0.15, -0.12, 0.08, 0.24);
    } else if (pk.kind === PK.HEALTH) {
      ctx.fillStyle = '#f5f5f5'; roundRect(ctx, -0.3, -0.26, 0.6, 0.52, 0.07); ctx.fill();
      ctx.fillStyle = '#e53935'; ctx.fillRect(-0.07, -0.19, 0.14, 0.38); ctx.fillRect(-0.19, -0.07, 0.38, 0.14);
    } else {
      ctx.fillStyle = '#2f5d8a'; roundRect(ctx, -0.26, -0.3, 0.52, 0.6, 0.1); ctx.fill();
      ctx.fillStyle = '#1d3d5c'; ctx.fillRect(-0.06, -0.3, 0.12, 0.6);
    }
    ctx.restore();
  }

  // Человек сверху: ноги шагают по направлению движения, корпус и руки - по прицелу
  function drawPlayer(x, y, a, color, w, flags, punch, outline, walk, moveAng, moving) {
    const blink = (flags & 2) && Math.floor(performance.now() / 110) % 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1.2, 1.2);
    if (blink) ctx.globalAlpha = 0.45;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(0.08, 0.1, 0.42, 0.42, 0, 0, Math.PI * 2); ctx.fill();
    // ноги: шагают по направлению движения, на бегу видно, как переставляются ступни
    ctx.save();
    ctx.rotate(moving ? moveAng : a);
    const sw = moving ? Math.sin(walk) * 0.36 : 0;
    ctx.strokeStyle = '#3a4256';
    ctx.lineWidth = 0.15;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -0.12); ctx.lineTo(sw, -0.14);
    ctx.moveTo(0, 0.12); ctx.lineTo(-sw, 0.14);
    ctx.stroke();
    ctx.fillStyle = '#3b2a1e';
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 0.03;
    ctx.beginPath(); ctx.ellipse(sw + 0.07, -0.14, 0.14, 0.085, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(-sw + 0.07, 0.14, 0.14, 0.085, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    // корпус, руки, оружие
    ctx.rotate(a);
    const skin = '#d9a77c';
    if (w === W.FISTS) {
      const ext = punch > 0 ? Math.sin(punch * Math.PI) * 0.3 : 0;
      const arm = moving ? Math.sin(walk) * 0.08 : 0;
      ctx.fillStyle = skin;
      ctx.beginPath(); ctx.arc(0.3 + ext - arm, 0.2, 0.11, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0.28 + arm, -0.2, 0.11, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.save(); ctx.translate(0.16, 0.06); drawGunShape(ctx, w); ctx.restore();
      ctx.fillStyle = skin;
      ctx.beginPath(); ctx.arc(0.22, 0.16, 0.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0.42, 0.04, 0.09, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(0, 0, 0.22, 0.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = outline ? 0.09 : 0.05;
    ctx.strokeStyle = outline ? '#ffffff' : 'rgba(0,0,0,0.55)';
    ctx.stroke();
    ctx.fillStyle = '#2b1d14';
    ctx.beginPath(); ctx.arc(0.02, 0, 0.19, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function laserLength(x, y, a, max) {
    const dx = Math.cos(a), dy = Math.sin(a);
    for (let d = 0.6; d < max; d += 0.25) {
      const t = blockAt(Math.floor(x + dx * d), Math.floor(y + dy * d));
      if (t !== B.NONE) return d;
    }
    return max;
  }

  function drawBullets(now) {
    for (const [id, b] of S.bullets) {
      const d = ((now - b.t0) / 1000) * b.speed;
      const end = b.end !== null ? b.end : b.range;
      if (d >= end) {
        if (b.end !== null) impactEffect(b.ex, b.ey, b.endKind, b.w);
        S.bullets.delete(id);
        continue;
      }
      const x = b.x0 + b.dx * d, y = b.y0 + b.dy * d;
      if (b.w === W.LAUNCHER) {
        ctx.fillStyle = '#2b2b2b';
        ctx.beginPath(); ctx.arc(x, y, 0.15, 0, Math.PI * 2); ctx.fill();
        if (Math.random() < 0.6) spawn('smoke', x, y, 1, '#888', 0.3, 0.7, 0.12);
      } else {
        const tail = Math.min(d, b.w === W.SNIPER ? 3 : 1);
        ctx.strokeStyle = b.w === W.SNIPER ? 'rgba(255,255,255,0.9)' : 'rgba(255,233,160,0.95)';
        ctx.lineWidth = b.w === W.SNIPER ? 0.06 : 0.07;
        ctx.beginPath(); ctx.moveTo(x - b.dx * tail, y - b.dy * tail); ctx.lineTo(x, y); ctx.stroke();
      }
    }
  }

  function impactEffect(x, y, kind, w) {
    if (kind === 1) {
      const k = tileAt(Math.floor(x), Math.floor(y));
      spawn('spark', x, y, 4, '#ffd27a', 5, 0.25, 0.05);
      spawn('debris', x, y, 3, DEBRIS[k >= 0 ? S.map.block[k] : 0] || '#777', 3, 0.5, 0.08);
    } else if (kind === 2) {
      spawn('blood', x, y, 6, '#9b0f0f', 3, 0.45, 0.1);
    } else if (kind === 4) {
      spawn('spark', x, y, 6, '#ffe6a0', 6, 0.25, 0.05);
      Sound.metal(x, y);
    } else if (kind === 0 && w !== W.LAUNCHER) {
      spawn('dust', x, y, 1, '#888', 0.3, 0.4, 0.08);
    }
  }

  // ======================================================================
  // Ввод
  // ======================================================================
  const input = {
    keys: new Set(), mx: 0, my: 0, mouseX: 0, mouseY: 0, mouseDown: false, fire: false, fireTap: false,
    mode: isTouch ? 'touch' : 'mouse', move: null, aim: null, wheelAt: 0, sprintBtn: false
  };

  function typing() { const el = document.activeElement; return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'); }

  window.addEventListener('keydown', e => {
    if (typing() || !S.inGame) return;
    if (e.repeat && (e.code === 'KeyF' || e.code === 'KeyM' || e.code === 'KeyH')) return;
    input.keys.add(e.code);
    if (e.code.startsWith('Digit')) { const n = Number(e.code.slice(5)); if (n >= 1 && n <= 6) selectWeapon(n - 1); }
    else if (e.code === 'KeyQ') cycleWeapon(-1);
    else if (e.code === 'KeyE') cycleWeapon(1);
    else if (e.code === 'KeyF') carAction();
    else if (e.code === 'KeyH') horn();
    else if (e.code === 'KeyM') showBig(!S.bigOpen);
    else if (e.code === 'Tab') { e.preventDefault(); showBoard(true); }
    else if (e.code === 'Escape') { showBoard(false); showBig(false); showGear(false); }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', e => {
    input.keys.delete(e.code);
    if (e.code === 'Tab' && S.inGame) showBoard(false);
  });
  window.addEventListener('blur', () => { input.keys.clear(); input.mouseDown = false; input.sprintBtn = false; });
  window.addEventListener('mousemove', e => { input.mouseX = e.clientX; input.mouseY = e.clientY; input.mode = 'mouse'; });
  canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    Sound.init();
    if (S.gearOpen) showGear(false);
    input.mode = 'mouse';
    input.mouseDown = true;
    input.fireTap = true;
  });
  window.addEventListener('mouseup', e => { if (e.button === 0) input.mouseDown = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const now = performance.now();
    if (now - input.wheelAt < 120) return;
    input.wheelAt = now;
    cycleWeapon(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  function stickOrigin(x, y) {
    const m = STICK_R + 10;
    return [clamp(x, m, cw - m), clamp(y, m, ch - m)];
  }
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    Sound.init();
    if (S.gearOpen) showGear(false);
    input.mode = 'touch';
    for (const t of e.changedTouches) {
      const left = t.clientX < cw * 0.45;
      if (left && !input.move) {
        const [ox, oy] = stickOrigin(t.clientX, t.clientY);
        input.move = { id: t.identifier, ox, oy, x: t.clientX, y: t.clientY };
      } else if (!left && !input.aim) {
        // правая половина - атака: держишь - стреляет без остановки, короткое касание - один выстрел
        input.aim = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY, t0: performance.now(), moved: false };
        input.fireTap = true;
      }
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (input.move && t.identifier === input.move.id) { input.move.x = t.clientX; input.move.y = t.clientY; }
      if (input.aim && t.identifier === input.aim.id) {
        input.aim.x = t.clientX; input.aim.y = t.clientY;
        if (Math.hypot(t.clientX - input.aim.ox, t.clientY - input.aim.oy) > 12) input.aim.moved = true;
      }
    }
  }, { passive: false });
  function touchEnd(e) {
    for (const t of e.changedTouches) {
      if (input.move && t.identifier === input.move.id) input.move = null;
      if (input.aim && t.identifier === input.aim.id) input.aim = null;
    }
  }
  canvas.addEventListener('touchend', touchEnd);
  canvas.addEventListener('touchcancel', touchEnd);

  // Кнопка рывка: держишь - бежишь быстрее
  const btnSprint = $('btnSprint');
  const sprintOn = e => { e.preventDefault(); Sound.init(); input.sprintBtn = true; btnSprint.classList.add('on'); };
  const sprintOff = () => { input.sprintBtn = false; btnSprint.classList.remove('on'); };
  btnSprint.addEventListener('pointerdown', sprintOn);
  btnSprint.addEventListener('pointerup', sprintOff);
  btnSprint.addEventListener('pointercancel', sprintOff);
  btnSprint.addEventListener('pointerleave', sprintOff);
  // Кнопки справа срабатывают сразу по касанию (даже когда второй палец держит джойстик);
  // click оставлен для клавиатуры и мыши, без двойного срабатывания
  function onPress(el, fn) {
    let at = 0;
    el.addEventListener('pointerdown', e => { e.preventDefault(); at = performance.now(); Sound.init(); fn(); });
    el.addEventListener('click', () => { if (performance.now() - at > 600) { Sound.init(); fn(); } });
  }
  onPress($('btnCar'), () => carAction());
  onPress($('btnLeave'), () => carAction());
  onPress($('btnHorn'), () => horn());
  onPress($('btnWeapon'), () => cycleWeapon(1));

  // видимый противник в секторе прицела (для подсказки прицела на телефоне)
  function losClient(x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(d / 0.3);
    for (let i = 1; i < n; i++) {
      const t = blockAt(Math.floor(x0 + (x1 - x0) * i / n), Math.floor(y0 + (y1 - y0) * i / n));
      if (t !== B.NONE && t !== B.GLASS && t !== B.FENCE && t !== B.BENCH && t !== B.BARREL) return false;
    }
    return true;
  }
  function targetsInRange(range) {
    const out = [];
    for (const p of S.players.values()) {
      if (p.id === S.myId || !(p.flags & 1) || p.hidden || (p.flags & 8)) continue;
      const dx = p.rx - S.me.x, dy = p.ry - S.me.y, d = Math.hypot(dx, dy);
      if (d > range || d < 0.3) continue;
      out.push({ ang: Math.atan2(dy, dx), d, p });
    }
    return out;
  }
  function aimAssist(a) {
    const w = WEAPONS[S.me.cur];
    let best = null, bestDiff = 0.22;
    for (const t of targetsInRange(Math.min(w.melee ? 2 : w.range, 24))) {
      const diff = Math.abs(angDiff(t.ang, a));
      if (diff < bestDiff) { bestDiff = diff; best = t.ang; }
    }
    return best === null ? a : a + angDiff(best, a) * 0.6;
  }
  function autoAim() {
    const w = WEAPONS[S.me.cur];
    let best = null;
    for (const t of targetsInRange(w.melee ? 2.5 : Math.min(w.range, 18))) {
      if (!losClient(S.me.x, S.me.y, t.p.rx, t.p.ry)) continue;
      if (!best || t.d < best.d) best = t;
    }
    return best ? best.ang : null;
  }

  function updateInput(dt) {
    let mx = 0, my = 0;
    const k = input.keys;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) my -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my += 1;
    input.keyDrive = !!(mx || my);
    if (input.move) {
      const m = input.move;
      let dx = m.x - m.ox, dy = m.y - m.oy;
      const l = Math.hypot(dx, dy);
      if (l > STICK_R) { m.ox += dx * (1 - STICK_R / l); m.oy += dy * (1 - STICK_R / l); dx = m.x - m.ox; dy = m.y - m.oy; }
      // любой наклон дальше мёртвой зоны - полная скорость (без замедлений)
      if (Math.hypot(dx, dy) / STICK_R > 0.15) { mx = dx; my = dy; }
    }
    const len = Math.hypot(mx, my);
    if (len > 0) { mx /= len; my /= len; }
    input.mx = mx; input.my = my;

    if (input.mode === 'mouse') {
      const sx = (S.me.x * S.view.tp + S.view.ox) / dpr, sy = (S.me.y * S.view.tp + S.view.oy) / dpr;
      S.me.a = Math.atan2(input.mouseY - sy, input.mouseX - sx);
      input.fire = input.mouseDown;
    } else if (input.aim) {
      const dx = input.aim.x - input.aim.ox, dy = input.aim.y - input.aim.oy;
      if (input.aim.moved && Math.hypot(dx, dy) > 10) S.me.a = aimAssist(Math.atan2(dy, dx));
      else { const auto = autoAim(); if (auto !== null) S.me.a = auto; }
      input.fire = true;
    } else {
      input.fire = false;
      if (!S.me.vehicle && (mx || my)) S.me.a += angDiff(Math.atan2(my, mx), S.me.a) * Math.min(1, dt * 10);
      else if (S.me.vehicle && S.car) S.me.a += angDiff(S.car.a, S.me.a) * Math.min(1, dt * 6);
    }
    const wantSprint = k.has('ShiftLeft') || k.has('ShiftRight') || input.sprintBtn;
    if (!wantSprint || S.me.vehicle || !(mx || my)) S.me.sprinting = false;
    else if (S.me.sprinting ? S.me.stamina > 0 : S.me.stamina >= STAMINA.START) S.me.sprinting = true;
    else S.me.sprinting = false;
  }

  function selectWeapon(i) {
    if (!S.me.alive || i < 0 || i >= WEAPONS.length) return;
    if (i !== W.FISTS && !(S.me.ammo[i] > 0)) return;
    if (S.me.cur === i) return;
    S.me.cur = i;
    S.me.switchAt = performance.now();
    S.me.nextShot = Math.max(S.me.nextShot, performance.now() + 150);
    send({ t: 'w', i });
    Sound.click();
    updateHud(true);
  }
  function cycleWeapon(dir) {
    const owned = [0, 1, 2, 3, 4, 5].filter(i => i === W.FISTS || S.me.ammo[i] > 0);
    const idx = owned.indexOf(S.me.cur);
    selectWeapon(owned[(idx + dir + owned.length) % owned.length]);
  }

  // ближайшая машина, в которую можно сесть
  function nearCar() {
    if (!S.me.alive || S.me.vehicle) return null;
    let best = null, bd = CAR.ENTER;
    for (const v of S.vehicles.values()) {
      if (v.fl & 2) continue;
      if (v.driver && v.driver !== S.myId) { const d = S.players.get(v.driver); if (d && !d.bot) continue; }
      const dist = KV.distToOBB(S.me.x, S.me.y, v.rx, v.ry, v.ra, CAR.HL, CAR.HW);
      if (dist <= bd) { bd = dist; best = v; }
    }
    return best;
  }
  function carAction() {
    if (!S.me.alive) return;
    if (S.me.vehicle) { send({ t: 'exit' }); return; }
    const v = nearCar();
    if (v) { send({ t: 'enter', id: v.id }); Sound.doorOpen(); }
  }
  function horn() {
    if (!S.me.vehicle) return;
    send({ t: 'horn' });
  }

  // ======================================================================
  // Сеть
  // ======================================================================
  function send(msg) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg)); }

  function connect() {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    let ws;
    try { ws = new WebSocket(url); } catch (_) { setStatus('Не удалось подключиться'); return; }
    S.ws = ws;
    let welcomed = false;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room: S.room, name: S.name }));
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.t === 'welcome') welcomed = true;
      handle(m);
    };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      S.ws = null;
      if (S.leaving) return;
      if (S.inGame) { $('lost').hidden = false; return; }
      if (!welcomed && S.retries < 20) {
        S.retries++;
        setStatus(`Сервер просыпается, пробуем ещё раз (${S.retries})...`);
        setTimeout(() => { if (!S.leaving && !S.inGame) connect(); }, 2500);
      } else setStatus('Не удалось подключиться. Проверьте интернет и попробуйте ещё раз.');
    };
    ws.onerror = () => {};
  }

  function handle(m) {
    switch (m.t) {
      case 'welcome': onWelcome(m); break;
      case 'err': S.leaving = true; setStatus(m.text); if (S.ws) S.ws.close(); break;
      case 'tp': onTeleport(m); break;
      case 'car':
        S.me.vehicle = m.id;
        S.car = { id: m.id, x: m.x, y: m.y, a: m.a, v: m.v || 0, sx: 0, sy: 0, tp: m.tp, thr: 0 };
        S.me.sprinting = false;
        toast(isTouch ? 'Вы за рулём. Чтобы выйти - кнопка «Выйти»' : 'Вы за рулём: W/S - газ и тормоз, A/D - руль, F - выйти');
        updateHud(true);
        break;
      case 'ctp':
        if (S.car) { S.car.x = m.x; S.car.y = m.y; S.car.a = m.a; S.car.v = 0; S.car.sx = 0; S.car.sy = 0; S.car.tp = m.tp; }
        break;
      case 'vk':
        if (S.car) { S.car.sx += m.x; S.car.sy += m.y; if (!a11y('motion')) S.shake = Math.max(S.shake, 0.5); }
        break;
      case 'kb':
        S.me.kvx += m.x; S.me.kvy += m.y;
        if (!a11y('motion')) S.shake = Math.max(S.shake, 0.8);
        break;
      case 's': onSnapshot(m); break;
      case 'e': onEvents(m); break;
      case 'sb':
        for (const [id, k, d] of m.l) { const p = S.players.get(id); if (p) { p.kills = k; p.deaths = d; } }
        if (!$('board').hidden) renderBoard();
        break;
      case 'mm': S.pings = m.l; break;
    }
  }

  function resetMe() {
    Object.assign(S.me, { tp: -1, alive: false, vehicle: 0, kvx: 0, kvy: 0, sprinting: false, stamina: STAMINA.MAX });
    S.car = null;
  }

  function onWelcome(m) {
    S.myId = m.id;
    S.room = m.room;
    S.map = setupMap(m.map);
    chunks.clear();
    buildRadarBase();
    S.players.clear();
    for (const p of m.players) upsertPlayer(p);
    S.pickups.clear();
    for (const [id, kind, w, x, y] of m.pickups) S.pickups.set(id, { id, kind, w, x, y });
    S.bullets.clear(); S.vehicles.clear(); S.rammed.clear();
    S.particles.length = 0; S.effects.length = 0; S.decals.length = 0; S.hitMarks.length = 0; S.npcs.length = 0; S.blasts.length = 0; S.pings = [];
    resetMe();
    S.clockOff = null;
    S.inGame = true;
    S.inGameSince = performance.now();
    S.retries = 0;
    $('menu').hidden = true;
    $('hud').hidden = false;
    $('lost').hidden = true;
    $('deathScreen').hidden = true;
    $('a11yPanel').hidden = true;
    document.body.classList.add('playing');
    $('boardRoom').textContent = 'Комната ' + S.room;
    try { history.replaceState(null, '', '?room=' + encodeURIComponent(S.room)); } catch (_) {}
    syncA11y();
    updateRotateHint();
    updateHud(true);
    toast('Комната ' + S.room + ' - пригласите друзей через шестерёнку', 3500);
  }

  function onTeleport(m) {
    S.me.x = m.x; S.me.y = m.y; S.me.tp = m.tp;
    S.me.kvx = 0; S.me.kvy = 0;
    if (!m.veh && S.me.vehicle) { S.me.vehicle = 0; S.car = null; Sound.doorOpen(); }
    if (m.sp) {
      S.me.alive = true; S.me.hp = 100; S.me.ar = 0; S.me.cur = 0; S.me.ammo = [0, -1, -1, -1, -1, -1];
      S.me.stamina = STAMINA.MAX; S.me.vehicle = 0; S.car = null;
      S.cam.x = m.x; S.cam.y = m.y;
      $('deathScreen').hidden = true;
    }
    updateHud(true);
  }

  function onSnapshot(m) {
    const now = Date.now();
    const off = m.ts - now;
    if (S.clockOff === null) S.clockOff = off;
    else S.clockOff += (off - S.clockOff) * (off > S.clockOff ? 0.3 : 0.02);
    for (const [id, x, y, a, fl, w, hp] of m.p) {
      let p = S.players.get(id);
      if (!p) { p = makePlayer(id); S.players.set(id, p); }
      p.flags = fl; p.w = w; p.hp = hp; p.seen = now;
      if (id === S.myId) { S.srv = [x, y]; continue; }
      const last = p.snaps[p.snaps.length - 1];
      if (!last || Math.hypot(last[1] - x, last[2] - y) > 6 || !(fl & 1)) p.snaps.length = 0;
      p.snaps.push([m.ts, x, y, a]);
      if (p.snaps.length > 12) p.snaps.shift();
    }
    if (m.c) {
      for (const [id, x, y, a, v, st, color, fl, driver, hp] of m.c) {
        let c = S.vehicles.get(id);
        if (!c) { c = { id, snaps: [], rx: x, ry: y, ra: a }; S.vehicles.set(id, c); }
        c.v = v; c.st = st; c.color = color; c.fl = fl; c.driver = driver; c.hp = hp; c.seen = now;
        const last = c.snaps[c.snaps.length - 1];
        if (last && Math.hypot(last[1] - x, last[2] - y) > 12) c.snaps.length = 0;
        c.snaps.push([m.ts, x, y, a]);
        if (c.snaps.length > 12) c.snaps.shift();
      }
    }
    const [hp, ar, cur, ammo, respawnIn, alive, stamina, veh] = m.me;
    S.me.hp = hp; S.me.ar = ar; S.me.ammo = ammo; S.me.respawnIn = respawnIn;
    if (performance.now() - S.me.switchAt > 500) S.me.cur = cur;
    if (Math.abs(S.me.stamina - stamina) > 12) S.me.stamina = stamina;
    if (S.me.alive && !alive) S.me.alive = false;
    if (!veh && S.me.vehicle && S.car) { S.me.vehicle = 0; S.car = null; }
  }

  function interpolate(o, rt) {
    const s = o.snaps;
    if (!s.length) return false;
    if (rt <= s[0][0]) { o.rx = s[0][1]; o.ry = s[0][2]; o.ra = s[0][3]; return true; }
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i][0] <= rt) {
        const a = s[i], b = s[i + 1];
        if (!b) { o.rx = a[1]; o.ry = a[2]; o.ra = a[3]; return true; }
        const k = clamp((rt - a[0]) / Math.max(1, b[0] - a[0]), 0, 1);
        o.rx = a[1] + (b[1] - a[1]) * k;
        o.ry = a[2] + (b[2] - a[2]) * k;
        o.ra = a[3] + angDiff(b[3], a[3]) * k;
        return true;
      }
    }
    return false;
  }

  function onEvents(m) {
    const now = performance.now();
    const map = S.map;
    if (m.pj) for (const info of m.pj) {
      const isNew = upsertPlayer(info);
      if (isNew && info[0] !== S.myId && now - S.inGameSince > 1500 && !info[3]) feed(`${info[1]} в игре`);
    }
    if (m.pl) for (const id of m.pl) {
      const p = S.players.get(id);
      if (p && !p.bot) feed(`${p.name} вышел`);
      S.players.delete(id);
    }
    if (m.sp) for (const [id, x, y] of m.sp) {
      const p = S.players.get(id);
      if (p && id !== S.myId) { p.snaps.length = 0; p.rx = x; p.ry = y; p.lx = null; }
    }
    if (m.b) for (const [id, w, x, y, ang, owner] of m.b) {
      const wp = WEAPONS[w];
      const dx = Math.cos(ang), dy = Math.sin(ang);
      S.bullets.set(id, { x0: x, y0: y, dx, dy, speed: wp.speed, range: wp.range, w, t0: now, end: null, endKind: 0, ex: 0, ey: 0 });
      if (owner !== S.myId) {
        Sound.shot(w, x, y);
        spawn('flash', x + dx * 0.9, y + dy * 0.9, 1, '#ffcf70', 0.2, 0.06, 0.28);
      }
    }
    if (m.be) for (const [id, x, y, kind] of m.be) {
      const b = S.bullets.get(id);
      if (b) { b.end = Math.hypot(x - b.x0, y - b.y0); b.endKind = kind; b.ex = x; b.ey = y; }
      else impactEffect(x, y, kind, -1);
    }
    if (m.hu) for (const [id, x, y, att] of m.hu) {
      if (id === S.myId) { S.hurtFlash = 1; Sound.hurt(); if (!a11y('motion')) S.shake = Math.max(S.shake, 0.25); }
      else if (att === S.myId) { S.hitMarks.push({ x, y, t0: now }); Sound.hit(); }
      spawn('blood', x, y, 3, '#9b0f0f', 2.5, 0.4, 0.1);
    }
    if (m.x) for (const [x, y, r] of m.x) explosionEffect(x, y, r);
    if (m.tl) for (const [k, block, st, ground, destroyed] of m.tl) {
      const x = k % map.w, y = Math.floor(k / map.w);
      map.block[k] = block; map.dmg[k] = st; map.ground[k] = ground;
      S.rammed.delete(k);
      dirtyAround(x, y);
      radarTile(k);
      if (destroyed !== undefined) {
        const col = DEBRIS[destroyed] || '#777';
        spawn('debris', x + 0.5, y + 0.5, destroyed === B.GLASS ? 7 : 9, col, 4, 0.9, destroyed === B.GLASS ? 0.07 : 0.14);
        spawn('dust', x + 0.5, y + 0.5, 2, '#9a8f84', 0.8, 1.2, 0.25);
        if (destroyed === B.GLASS) Sound.glass(x, y);
        else if (destroyed === B.BRICK || destroyed === B.CONCRETE) Sound.brick(x, y);
        else if (destroyed !== B.CAR && destroyed !== B.BARREL) Sound.wood(x, y);
      } else {
        spawn('dust', x + 0.5, y + 0.5, 1, '#9a8f84', 0.5, 0.8, 0.18);
      }
    }
    if (m.rf) for (const id of m.rf) {
      const b = map.buildings[id];
      if (!b) continue;
      b.roof = false;
      for (let i = 0; i < 10; i++) spawn('dust', b.x + 1 + Math.random() * (b.w - 2), b.y + 1 + Math.random() * (b.h - 2), 1, '#8a8076', 1, 2, 0.6);
      Sound.brick(b.x + b.w / 2, b.y + b.h / 2);
    }
    if (m.k) for (const [killer, victim, w] of m.k) onKill(killer, victim, w);
    if (m.pa) for (const [id, kind, w, x, y] of m.pa) { S.pickups.set(id, { id, kind, w, x, y }); S.paCount = (S.paCount || 0) + 1; }
    if (m.pr) for (const id of m.pr) S.pickups.delete(id);
    if (m.pu) for (const [pid, kind, w] of m.pu) {
      if (pid !== S.myId) continue;
      Sound.pickup();
      toast(kind === PK.WEAPON ? `Подобрано: ${WEAPONS[w].name}` : kind === PK.AMMO ? `Патроны: ${WEAPONS[w].name}` : kind === PK.HEALTH ? 'Аптечка' : 'Бронежилет');
    }
    if (m.m) for (const id of m.m) {
      const p = S.players.get(id);
      if (p && id !== S.myId) { p.punch = 1; Sound.punch(p.rx, p.ry); }
    }
    // машины
    if (m.hn) for (const id of m.hn) { const v = S.vehicles.get(id); if (v) Sound.horn(v.rx, v.ry); else if (id === S.me.vehicle) Sound.horn(); }
    if (m.cr) for (const [x, y, s] of m.cr) { Sound.crash(x, y, s); spawn('spark', x, y, Math.min(12, 3 + s), '#ffe6a0', 5, 0.3, 0.05); spawn('debris', x, y, 3, '#666', 3, 0.5, 0.08); }
    if (m.ck) for (const [vid, pid, x, y] of m.ck) { Sound.thud(x, y); spawn('blood', x, y, 8, '#9b0f0f', 4, 0.5, 0.12); }
    if (m.vf) for (const id of m.vf) { const v = S.vehicles.get(id); if (v) Sound.fire(v.rx, v.ry); if (id === S.me.vehicle) toast('Машина горит - выходите!', 2500); }
    if (m.vx) for (const id of m.vx) S.vehicles.delete(id);
    if (m.fl) for (const [x, y, a] of m.fl) S.npcs.push({ x, y, a, t0: now, walk: 0, color: ['#8e44ad', '#16a085', '#d35400', '#7f8c8d'][Math.floor(Math.random() * 4)] });
    if (m.en) for (const [vid, pid] of m.en) { if (pid !== S.myId) { const v = S.vehicles.get(vid); if (v) Sound.doorOpen(); } }
  }

  function onKill(killer, victim, w) {
    const vp = S.players.get(victim);
    const vx = victim === S.myId ? S.me.x : vp ? vp.rx : 0, vy = victim === S.myId ? S.me.y : vp ? vp.ry : 0;
    spawn('blood', vx, vy, 12, '#9b0f0f', 3.5, 0.6, 0.12);
    addDecal('blood', vx, vy, 0.55);
    const wn = w >= 0 ? WEAPONS[w].name : w === -2 ? 'машина' : 'взрыв';
    const self = !killer || killer === victim;
    const mine = killer === S.myId || victim === S.myId;
    if (self) feed(`${esc(nameOf(victim))} погиб: <span class="w">${esc(wn)}</span>`, mine, true);
    else feed(`${esc(nameOf(killer))} <span class="w">[${esc(wn)}]</span> ${esc(nameOf(victim))}`, mine, true);
    if (victim === S.myId) {
      S.me.alive = false;
      S.me.vehicle = 0; S.car = null;
      $('deathBy').textContent = self ? (w === -2 ? 'Вас сбила машина' : 'Вы погибли') : `Вас убил ${nameOf(killer)}`;
      $('deathScreen').hidden = false;
      Sound.death();
    } else if (killer === S.myId) {
      toast(`Вы убили: ${nameOf(victim)}`);
    }
  }

  // ======================================================================
  // HUD
  // ======================================================================
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function setStatus(t) { $('menuStatus').textContent = t; }
  let toastTimer = 0;
  function toast(t, ms = 2000) {
    const el = $('toast');
    el.textContent = t;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function feed(htmlText, mine = false, isHtml = false) {
    const ul = $('feed');
    const li = document.createElement('li');
    if (isHtml) li.innerHTML = htmlText; else li.textContent = htmlText;
    if (mine) li.classList.add('me');
    ul.appendChild(li);
    while (ul.children.length > 5) ul.removeChild(ul.firstChild);
    setTimeout(() => { li.style.opacity = '0'; setTimeout(() => li.remove(), 450); }, 6000);
  }

  const ICONS = [
    '<svg viewBox="0 0 32 16" aria-hidden="true"><path fill="currentColor" d="M9 4h13a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3z"/><path stroke="#000" stroke-opacity=".4" stroke-width="1.2" d="M14 4.5v4M18 4.5v4M22 4.5v4"/></svg>',
    '<svg viewBox="0 0 32 16" aria-hidden="true"><path fill="currentColor" d="M5 3h21v5H15l-1.6 7H9l1.6-7H5z"/></svg>',
    '<svg viewBox="0 0 32 16" aria-hidden="true"><path fill="currentColor" d="M1 5h29v3h-9l-.5 6h-3.5l.5-6h-6l-3 5H4l2.5-5H1z"/></svg>',
    '<svg viewBox="0 0 32 16" aria-hidden="true"><path fill="currentColor" d="M1 5h30v3H12l-3 6H5l2.4-6H1zm16 3h7v3h-7z"/></svg>',
    '<svg viewBox="0 0 32 16" aria-hidden="true"><path fill="currentColor" d="M1 7h30v2H11l-3 5H4l2.4-5H1zm11-5h9v3h-9z"/></svg>',
    '<svg viewBox="0 0 32 16" aria-hidden="true"><path fill="currentColor" d="M2 4h27v7H2zm7 7h4v4H9zm20-6h2v5h-2z"/></svg>'
  ];
  const slotEls = [];
  (function buildWeaponBar() {
    const bar = $('weaponBar');
    WEAPONS.forEach((w, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot';
      b.title = `${i + 1}. ${w.name}`;
      b.setAttribute('aria-label', w.name);
      b.innerHTML = `${ICONS[i]}<span class="c"></span>`;
      // срабатывает сразу по касанию, даже когда другой палец держит джойстик
      onPress(b, () => selectWeapon(i));
      bar.appendChild(b);
      slotEls.push(b);
    });
  })();

  let hudSig = '';
  function updateHud(force) {
    const me = S.me;
    $('hpFill').style.width = clamp(me.hp, 0, 100) + '%';
    $('hpText').textContent = 'Здоровье ' + Math.max(0, Math.round(me.hp));
    $('arFill').style.width = clamp(me.ar, 0, 100) + '%';
    $('arText').textContent = 'Броня ' + Math.round(me.ar);
    $('stFill').style.width = clamp(me.stamina, 0, 100) + '%';
    $('stText').textContent = me.sprinting ? 'Рывок!' : 'Выносливость';
    const v = me.vehicle ? S.vehicles.get(me.vehicle) : null;
    $('carBar').hidden = !v;
    if (v) { $('carFill').style.width = clamp((v.hp / CAR.HP) * 100, 0, 100) + '%'; $('carText').textContent = v.fl & 2 ? 'Машина горит!' : 'Машина ' + Math.round((v.hp / CAR.HP) * 100) + '%'; }
    const mp = S.players.get(S.myId);
    if (mp) $('scoreText').textContent = `Убийств ${mp.kills} · Смертей ${mp.deaths}`;
    const sig = me.cur + '|' + me.ammo.join(',') + '|' + me.alive;
    if (force || sig !== hudSig) {
      hudSig = sig;
      slotEls.forEach((el, i) => {
        const owned = i === W.FISTS || me.ammo[i] >= 0;
        el.hidden = !owned;
        el.classList.toggle('active', i === me.cur);
        el.classList.toggle('empty', i !== W.FISTS && me.ammo[i] === 0);
        el.querySelector('.c').textContent = i === W.FISTS ? '∞' : String(Math.max(0, me.ammo[i]));
        el.setAttribute('aria-pressed', i === me.cur ? 'true' : 'false');
      });
      // на кнопке смены оружия - значок текущего оружия и патроны
      $('btnWeaponIcon').innerHTML = ICONS[me.cur] || ICONS[0];
      $('btnWeaponText').textContent = me.cur === W.FISTS ? '∞' : String(Math.max(0, me.ammo[me.cur]));
      $('btnWeapon').setAttribute('aria-label', `Сменить оружие (сейчас: ${WEAPONS[me.cur].name})`);
    }
    // кнопки справа
    const car = nearCar();
    // сверху - оружие; в середине - «Сесть» или «Гудок»; внизу - «Рывок» или «Выйти»
    $('btnWeapon').hidden = !(isTouch && me.alive);
    $('btnCar').hidden = !(me.alive && !me.vehicle && car);
    $('btnHorn').hidden = !(isTouch && me.alive && me.vehicle);
    btnSprint.hidden = !(isTouch && me.alive && !me.vehicle && (input.move || input.sprintBtn));
    $('btnLeave').hidden = !(me.alive && me.vehicle);
    const hint = $('keyHint');
    if (input.mode === 'mouse' && me.alive && (me.vehicle || car)) {
      hint.hidden = false;
      hint.innerHTML = me.vehicle ? '<b>F</b> - выйти · <b>H</b> - гудок' : '<b>F</b> - сесть в машину';
    } else hint.hidden = true;
    if (!me.alive && S.inGame) $('respawnIn').textContent = me.respawnIn > 0 ? `Возрождение через ${me.respawnIn.toFixed(1)} с` : 'Возрождение...';
  }

  function renderBoard() {
    const rows = [...S.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    $('boardBody').innerHTML = rows.map(p =>
      `<tr class="${p.id === S.myId ? 'me' : ''}"><td><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`).join('');
  }
  function showBoard(on) {
    if (!S.inGame) return;
    $('board').hidden = !on;
    if (on) { showGear(false); renderBoard(); }
  }
  function showGear(on) {
    S.gearOpen = !!on;
    $('gearMenu').hidden = !on;
    $('btnMenu').setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) syncA11y();
  }
  function showBig(on) {
    if (!S.inGame) return;
    S.bigOpen = !!on;
    $('bigmap').hidden = !on;
    if (on) { showGear(false); drawBigMap(performance.now()); }
  }
  $('btnMenu').addEventListener('click', e => { e.stopPropagation(); Sound.init(); showGear(!S.gearOpen); });
  $('btnBoard').addEventListener('click', () => showBoard(true));
  $('btnMap').addEventListener('click', () => showBig(true));
  $('btnBoardClose').addEventListener('click', () => showBoard(false));
  $('board').addEventListener('click', e => { if (e.target.id === 'board') showBoard(false); });
  $('bigmap').addEventListener('click', () => showBig(false));
  mini.addEventListener('click', () => { Sound.init(); showBig(true); });
  mini.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showBig(true); } });
  function syncSoundBtn() {
    $('btnSound').setAttribute('aria-pressed', Sound.on ? 'true' : 'false');
    $('btnSound').textContent = Sound.on ? 'Звук: включён' : 'Звук: выключен';
  }
  $('btnSound').addEventListener('click', () => { Sound.init(); Sound.toggle(); syncSoundBtn(); });
  syncSoundBtn();
  $('btnInvite').addEventListener('click', async () => {
    showGear(false);
    const url = location.origin + '/?room=' + encodeURIComponent(S.room);
    const text = 'Заходи ко мне в Квартал - перестрелка в городе:';
    if (navigator.share && isTouch) {
      try { await navigator.share({ title: 'Квартал', text, url }); return; } catch (_) {}
    }
    try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована - отправьте её друзьям'); }
    catch (_) { prompt('Скопируйте ссылку и отправьте друзьям:', url); }
  });
  $('btnExit').addEventListener('click', leave);
  $('btnLostMenu').addEventListener('click', leave);
  $('btnReconnect').addEventListener('click', () => { const room = S.room; leave(); join(room); });

  function updateRotateHint() {
    $('rotateHint').hidden = !(isTouch && S.inGame && ch > cw * 1.15);
  }

  // ======================================================================
  // Радар и карта города
  // ======================================================================
  function drawPistolIcon(g, x, y, s, color) {
    g.save();
    g.translate(x, y);
    g.scale(s, s);
    g.fillStyle = color;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.lineWidth = 0.18;
    g.beginPath();
    g.moveTo(-1, -0.55); g.lineTo(1, -0.55); g.lineTo(1, 0); g.lineTo(-0.05, 0); g.lineTo(-0.3, 0.75); g.lineTo(-0.85, 0.75); g.lineTo(-0.6, 0); g.lineTo(-1, 0);
    g.closePath(); g.fill(); g.stroke();
    g.restore();
  }
  function drawMedIcon(g, x, y, s) {
    g.fillStyle = '#ffffff';
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = Math.max(1, s * 0.12);
    roundRect(g, x - s, y - s, s * 2, s * 2, s * 0.35); g.fill(); g.stroke();
    g.fillStyle = '#e53935';
    g.fillRect(x - s * 0.24, y - s * 0.7, s * 0.48, s * 1.4);
    g.fillRect(x - s * 0.7, y - s * 0.24, s * 1.4, s * 0.48);
  }
  function drawArmorIcon(g, x, y, s) {
    g.fillStyle = '#4da3ff';
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = Math.max(1, s * 0.12);
    g.beginPath();
    g.moveTo(x, y - s); g.lineTo(x + s * 0.9, y - s * 0.55); g.lineTo(x + s * 0.7, y + s * 0.5); g.lineTo(x, y + s); g.lineTo(x - s * 0.7, y + s * 0.5); g.lineTo(x - s * 0.9, y - s * 0.55);
    g.closePath(); g.fill(); g.stroke();
  }
  function drawRings(g, x, y, r, rgbStr, t, seed) {
    for (let i = 0; i < 2; i++) {
      const k = (t * 0.9 + i * 0.5 + seed * 0.13) % 1;
      g.strokeStyle = `rgba(${rgbStr},${(1 - k) * 0.85})`;
      g.lineWidth = Math.max(1, r * 0.15);
      g.beginPath(); g.arc(x, y, r * (0.9 + k * 1.6), 0, Math.PI * 2); g.stroke();
    }
  }
  function drawPickupIcon(g, pk, x, y, s, t) {
    if (pk.kind === PK.WEAPON) {
      drawRings(g, x, y, s, '255,210,63', t, pk.id);
      const blink = 0.55 + 0.45 * Math.sin(t * 7 + pk.id);
      g.globalAlpha = blink;
      drawPistolIcon(g, x, y, s, '#ffd23f');
      g.globalAlpha = 1;
    } else if (pk.kind === PK.HEALTH) {
      drawRings(g, x, y, s, '255,80,80', t, pk.id);
      drawMedIcon(g, x, y, s * 0.85);
    } else if (pk.kind === PK.ARMOR) {
      drawRings(g, x, y, s, '110,180,255', t, pk.id);
      drawArmorIcon(g, x, y, s * 0.9);
    } else {
      g.fillStyle = '#e0b030'; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 1;
      g.fillRect(x - s * 0.45, y - s * 0.35, s * 0.9, s * 0.7); g.strokeRect(x - s * 0.45, y - s * 0.35, s * 0.9, s * 0.7);
    }
  }

  // Общая отрисовка карты в прямоугольник: (cx, cy) - центр в метрах, span - сколько метров по стороне
  function drawMapView(g, size, cx, cy, span, now, full) {
    const map = S.map;
    const k = size / span;
    const x0 = cx - span / 2, y0 = cy - span / 2;
    const toX = x => (x - x0) * k, toY = y => (y - y0) * k;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#07080a';
    g.fillRect(0, 0, size, size);
    g.imageSmoothingEnabled = k < RB;
    const sx0 = Math.max(0, x0), sy0 = Math.max(0, y0), sx1 = Math.min(map.w, x0 + span), sy1 = Math.min(map.h, y0 + span);
    if (sx1 > sx0 && sy1 > sy0) g.drawImage(S.rbase, sx0 * RB, sy0 * RB, (sx1 - sx0) * RB, (sy1 - sy0) * RB, toX(sx0), toY(sy0), (sx1 - sx0) * k, (sy1 - sy0) * k);
    // крыши
    for (const b of map.buildings) {
      if (!b.roof || b.x + b.w < x0 || b.y + b.h < y0 || b.x > x0 + span || b.y > y0 + span) continue;
      g.fillStyle = b.pal[0];
      g.fillRect(toX(b.x + 1), toY(b.y + 1), (b.w - 2) * k, (b.h - 2) * k);
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = Math.max(1, k * 0.2);
      g.strokeRect(toX(b.x + 1), toY(b.y + 1), (b.w - 2) * k, (b.h - 2) * k);
    }
    const u = Math.max(1, size / 170); // размер значков
    // машины
    for (const v of S.vehicles.values()) {
      const vx = v.id === S.me.vehicle && S.car ? S.car.x : v.rx, vy = v.id === S.me.vehicle && S.car ? S.car.y : v.ry;
      const va = v.id === S.me.vehicle && S.car ? S.car.a : v.ra;
      if (vx < x0 - 3 || vy < y0 - 3 || vx > x0 + span + 3 || vy > y0 + span + 3) continue;
      g.save();
      g.translate(toX(vx), toY(vy));
      g.rotate(va);
      g.fillStyle = v.fl & 2 ? '#ff7a1a' : CAR_COLORS[v.color] || '#888';
      const L = Math.max(4 * u, CAR.HL * 2 * k), Wd = Math.max(2 * u, CAR.HW * 2 * k);
      g.fillRect(-L / 2, -Wd / 2, L, Wd);
      g.strokeStyle = v.driver && !(v.fl & 4) ? '#ffffff' : 'rgba(0,0,0,0.7)';
      g.lineWidth = Math.max(1, u * 0.8);
      g.strokeRect(-L / 2, -Wd / 2, L, Wd);
      g.restore();
    }
    // недавние взрывы
    for (let i = S.blasts.length - 1; i >= 0; i--) {
      const b = S.blasts[i];
      const t = (now - b.t0) / 1400;
      if (t >= 1) { S.blasts.splice(i, 1); continue; }
      g.strokeStyle = `rgba(255,140,40,${1 - t})`;
      g.lineWidth = 2 * u;
      g.beginPath(); g.arc(toX(b.x), toY(b.y), (3 + 10 * t) * u, 0, Math.PI * 2); g.stroke();
    }
    // вещи: мигающий пистолет с кругами, аптечка, бронежилет; за краем радара - стрелка
    const tsec = now / 1000;
    for (const pk of S.pickups.values()) {
      const px = toX(pk.x), py = toY(pk.y);
      const inside = px >= 0 && py >= 0 && px <= size && py <= size;
      if (inside) drawPickupIcon(g, pk, px, py, (pk.kind === PK.AMMO ? 4 : 6) * u, tsec);
      else if (!full && pk.kind !== PK.AMMO) {
        const dx = pk.x - cx, dy = pk.y - cy, d = Math.hypot(dx, dy);
        if (d > 70) continue;
        const ang = Math.atan2(dy, dx);
        const m = 9 * u;
        const ex = clamp(size / 2 + Math.cos(ang) * size, m, size - m), ey = clamp(size / 2 + Math.sin(ang) * size, m, size - m);
        g.save();
        g.translate(ex, ey);
        g.rotate(ang);
        g.fillStyle = pk.kind === PK.WEAPON ? '#ffd23f' : pk.kind === PK.HEALTH ? '#ff5a5a' : '#6eb4ff';
        g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(5 * u, 0); g.lineTo(-3 * u, 4 * u); g.lineTo(-3 * u, -4 * u); g.closePath(); g.fill(); g.stroke();
        g.restore();
      }
    }
    // кто стреляет
    const pulse = 0.6 + 0.4 * Math.sin(now / 120);
    for (const [id, x, y] of S.pings) {
      if (id === S.myId) continue;
      g.fillStyle = `rgba(255,50,50,${pulse})`;
      g.beginPath(); g.arc(toX(x + 0.5), toY(y + 0.5), 3.5 * u, 0, Math.PI * 2); g.fill();
    }
    // люди рядом (кого видно на экране)
    for (const p of S.players.values()) {
      if (p.id === S.myId || p.hidden || !(p.flags & 1) || (p.flags & 8)) continue;
      g.fillStyle = p.color;
      g.strokeStyle = '#fff';
      g.lineWidth = Math.max(1, u * 0.8);
      g.beginPath(); g.arc(toX(p.rx), toY(p.ry), 3 * u, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    // область экрана
    if (!full) {
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = 1;
      g.strokeRect(toX(S.cam.x - S.view.hw), toY(S.cam.y - S.view.hh), S.view.hw * 2 * k, S.view.hh * 2 * k);
    }
    // я
    if (S.me.alive) {
      g.save();
      g.translate(toX(S.me.x), toY(S.me.y));
      g.rotate(S.me.vehicle && S.car ? S.car.a : S.me.a);
      const z = 7 * u;
      g.fillStyle = '#ffffff'; g.strokeStyle = '#000'; g.lineWidth = Math.max(1, u);
      g.beginPath(); g.moveTo(z, 0); g.lineTo(-z * 0.7, z * 0.65); g.lineTo(-z * 0.35, 0); g.lineTo(-z * 0.7, -z * 0.65); g.closePath(); g.fill(); g.stroke();
      g.restore();
    }
  }

  function drawRadar(now) {
    if (!S.map || !S.rbase) return;
    drawMapView(mctx, mini.width, S.cam.x, S.cam.y, RADAR_SPAN, now, false);
  }
  function drawBigMap(now) {
    if (!S.map || !S.rbase) return;
    drawMapView(bctx, big.width, S.map.w / 2, S.map.h / 2, Math.max(S.map.w, S.map.h), now, true);
  }

  // ======================================================================
  // Меню и вход в комнату
  // ======================================================================
  const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const randomRoom = () => Array.from({ length: 6 }, () => ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]).join('');
  const cleanRoom = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);

  const nameInput = $('nameInput');
  try { nameInput.value = localStorage.getItem('kv_name') || ''; } catch (_) {}
  const inviteRoom = cleanRoom(new URLSearchParams(location.search).get('room'));
  if (inviteRoom.length >= 3) {
    $('inviteBlock').hidden = false;
    $('createBlock').hidden = true;
    $('inviteRoom').textContent = inviteRoom;
  }

  function join(room) {
    room = cleanRoom(room);
    if (room.length < 3) { setStatus('Код комнаты - от 3 латинских букв или цифр'); return; }
    S.name = nameInput.value.trim().slice(0, 16) || 'Игрок';
    try { localStorage.setItem('kv_name', S.name); } catch (_) {}
    Sound.init();
    S.room = room;
    S.leaving = false;
    S.retries = 0;
    setStatus('Подключаемся...');
    if (isTouch) {
      try { const p = root.requestFullscreen && root.requestFullscreen({ navigationUI: 'hide' }); if (p && p.catch) p.catch(() => {}); } catch (_) {}
      try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch (_) {}
    }
    connect();
  }

  function leave() {
    S.leaving = true;
    if (S.ws) { try { S.ws.close(); } catch (_) {} }
    S.ws = null;
    S.inGame = false;
    S.map = null;
    S.players.clear(); S.pickups.clear(); S.bullets.clear(); S.vehicles.clear();
    resetMe();
    chunks.clear();
    Sound.engines([]);
    showGear(false);
    $('hud').hidden = true;
    $('board').hidden = true;
    $('lost').hidden = true;
    $('bigmap').hidden = true;
    S.bigOpen = false;
    $('menu').hidden = false;
    document.body.classList.remove('playing');
    setStatus('');
    if (S.room) { $('inviteBlock').hidden = false; $('createBlock').hidden = true; $('inviteRoom').textContent = S.room; }
    try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (_) {}
  }

  $('btnCreate').addEventListener('click', () => join(randomRoom()));
  $('btnNewRoom').addEventListener('click', () => join(randomRoom()));
  $('btnJoin').addEventListener('click', () => join($('inviteRoom').textContent));
  $('btnCode').addEventListener('click', () => join($('codeInput').value));
  $('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') join($('codeInput').value); });
  nameInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (!$('inviteBlock').hidden) join($('inviteRoom').textContent); else join(randomRoom());
  });

  // --- доступность: панель в меню и те же переключатели под шестерёнкой ---
  const readA11y = () => { try { return JSON.parse(localStorage.getItem('kv_a11y') || '{}'); } catch (_) { return {}; } };
  const writeA11y = s => { try { localStorage.setItem('kv_a11y', JSON.stringify(s)); } catch (_) {} };
  function syncA11y() {
    const s = readA11y();
    document.querySelectorAll('.a11y-opt').forEach(b => b.setAttribute('aria-pressed', s[b.dataset.k] ? 'true' : 'false'));
  }
  (function setupA11y() {
    const btn = $('a11yBtn'), panel = $('a11yPanel');
    btn.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      btn.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
      if (!panel.hidden) syncA11y();
    });
    document.querySelectorAll('.a11y-opt').forEach(b => b.addEventListener('click', () => {
      const s = readA11y();
      s[b.dataset.k] = !s[b.dataset.k];
      writeA11y(s);
      root.classList.toggle('xx-a11y-' + b.dataset.k, !!s[b.dataset.k]);
      syncA11y();
    }));
    $('a11yReset').addEventListener('click', () => {
      writeA11y({});
      ['contrast', 'large', 'motion', 'underline'].forEach(k => root.classList.remove('xx-a11y-' + k));
      syncA11y();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
  })();

  // Бесплатный хостинг засыпает без запросов - пока идёт игра, раз в 4 минуты стучимся на /health
  setInterval(() => { if (S.inGame) fetch('/health', { cache: 'no-store' }).catch(() => {}); }, 240000);

  // ======================================================================
  // Кадр
  // ======================================================================
  function predictFire(now) {
    if (!S.me.alive || !(input.fire || input.fireTap) || S.me.sprinting) return;
    const w = WEAPONS[S.me.cur];
    if (now < S.me.nextShot) return;
    if (w.melee && S.me.vehicle) return;
    if (w.id !== W.FISTS && !(S.me.ammo[w.id] > 0)) {
      if (now > S.emptyAt) { Sound.empty(); S.emptyAt = now + 350; }
      return;
    }
    S.me.nextShot = now + 1000 / w.rate;
    if (w.id === W.FISTS) { S.me.punch = 1; Sound.punch(); return; }
    S.me.ammo[w.id]--;
    Sound.shot(w.id);
    const dx = Math.cos(S.me.a), dy = Math.sin(S.me.a);
    const off = S.me.vehicle ? 0.9 : 0.2 + GUN[w.id].len;
    spawn('flash', S.me.x + dx * off, S.me.y + dy * off, 1, '#ffcf70', 0.2, 0.06, 0.3);
    if (!a11y('motion')) S.shake = Math.max(S.shake, w.id === W.SNIPER || w.id === W.SHOTGUN ? 0.3 : w.id === W.LAUNCHER ? 0.25 : 0.08);
  }

  function sendInput(now) {
    if (!S.inGame || !S.ws || S.ws.readyState !== 1 || now - S.lastSend < SEND_MS) return;
    S.lastSend = now;
    const fire = (input.fire || input.fireTap) && !S.me.sprinting;
    input.fireTap = false;
    const msg = { t: 'i', a: r3(S.me.a), f: fire ? 1 : 0, s: S.me.sprinting ? 1 : 0, v: [Math.round(S.view.hw), Math.round(S.view.hh)] };
    if (S.me.vehicle && S.car) msg.c = [r2(S.car.x), r2(S.car.y), r3(S.car.a), r2(S.car.v), S.car.tp];
    else { msg.x = r2(S.me.x); msg.y = r2(S.me.y); msg.tp = S.me.tp; }
    S.ws.send(JSON.stringify(msg));
  }

  // своя машина: физика как на сервере, столкновения с другими машинами - тараном
  function driveLocal(dt, now) {
    const car = S.car;
    let thr = 0, steer = 0;
    const k = input.keys;
    if (input.keyDrive) {
      thr = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
      steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    } else if (input.move) {
      [thr, steer] = KV.steerToward(car, input.mx, input.my);
    }
    car.thr = thr;
    for (const [kk, t] of S.rammed) if (now - t > 2000) S.rammed.delete(kk);
    const res = KV.stepVehicle(S.map, car, thr, steer, dt, new Set(S.rammed.keys()));
    for (const kk of res.rammed) {
      S.rammed.set(kk, now);
      const x = kk % S.map.w, y = Math.floor(kk / S.map.w), t = S.map.block[kk];
      spawn('debris', x + 0.5, y + 0.5, 8, DEBRIS[t] || '#777', 5, 0.8, 0.14);
      if (t === B.GLASS) Sound.glass(x, y); else Sound.wood(x, y);
    }
    if (res.impact > 3 && now - S.crashAt > 300) {
      S.crashAt = now;
      send({ t: 'crash', s: r2(res.impact) });
      if (!a11y('motion')) S.shake = Math.max(S.shake, Math.min(1.2, res.impact / 10));
    }
    for (const o of S.vehicles.values()) {
      if (o.id === car.id || now - o.seen > 600) continue;
      const mtv = KV.obbObbMTV(car.x, car.y, car.a, o.rx, o.ry, o.ra, CAR.HL, CAR.HW);
      if (!mtv) continue;
      car.x += mtv[0]; car.y += mtv[1];
      KV.resolveCar(S.map, car, new Set(S.rammed.keys()));
      const ml = Math.hypot(mtv[0], mtv[1]) || 1, nx = mtv[0] / ml, ny = mtv[1] / ml;
      const into = -((Math.cos(car.a) * car.v + car.sx) * nx + (Math.sin(car.a) * car.v + car.sy) * ny);
      if (into > 0) {
        car.v *= 0.3;
        if (into > 3 && now - (S.ramAt.get(o.id) || 0) > 400) {
          S.ramAt.set(o.id, now);
          send({ t: 'ram', id: o.id, s: r2(into) });
          if (!a11y('motion')) S.shake = Math.max(S.shake, Math.min(1.2, into / 10));
        }
      }
    }
    S.me.x = car.x; S.me.y = car.y;
  }

  function walkLocal(dt) {
    const me = S.me;
    const sp = me.sprinting ? KV.SPRINT_SPEED : KV.PLAYER_SPEED;
    const dx = input.mx * sp * dt + me.kvx * dt, dy = input.my * sp * dt + me.kvy * dt;
    let [nx, ny] = KV.moveCircle(S.map, me.x, me.y, dx, dy, KV.PLAYER_R);
    // машины - препятствие
    for (const v of S.vehicles.values()) {
      if (Math.abs(v.rx - nx) > 3 || Math.abs(v.ry - ny) > 3) continue;
      const out = KV.pushOutOBB(nx, ny, KV.PLAYER_R, v.rx, v.ry, v.ra, CAR.HL, CAR.HW);
      if (out) [nx, ny] = KV.collideCircle(S.map, out[0], out[1], KV.PLAYER_R);
    }
    const moved = Math.hypot(nx - me.x, ny - me.y);
    me.moving = moved > sp * dt * 0.25 && (input.mx || input.my);
    if (input.mx || input.my) me.moveAng = Math.atan2(input.my, input.mx);
    me.walk += moved * (me.sprinting ? 4.2 : 4.8);
    me.stepAcc += moved;
    const stride = me.sprinting ? 1.7 : 1.3;
    if (me.stepAcc >= stride) {
      me.stepAcc = 0;
      const k = tileAt(Math.floor(nx), Math.floor(ny));
      Sound.step(k >= 0 ? S.map.ground[k] : G.ROAD, undefined, undefined, me.sprinting ? 1.25 : 1);
    }
    me.x = nx; me.y = ny;
    const f = Math.exp(-5 * dt);
    me.kvx *= f; me.kvy *= f;
    // выносливость
    if (me.sprinting && me.moving) {
      me.stamina = Math.max(0, me.stamina - STAMINA.DRAIN * dt);
      me.staminaT = performance.now();
      if (me.stamina <= 0) me.sprinting = false;
    } else if (performance.now() - me.staminaT > STAMINA.DELAY * 1000) me.stamina = Math.min(STAMINA.MAX, me.stamina + STAMINA.REGEN * dt);
  }

  let lastFrame = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    S.frame++;
    if (!S.inGame || !S.map) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#101217';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    updateInput(dt);
    if (S.me.alive) {
      if (S.me.vehicle && S.car) driveLocal(dt, now); else walkLocal(dt);
      S.cam.x = S.me.x; S.cam.y = S.me.y;
    }
    predictFire(now);
    sendInput(now);
    if (S.me.punch > 0) S.me.punch = Math.max(0, S.me.punch - dt * 5);
    for (const p of S.players.values()) if (p.punch > 0) p.punch = Math.max(0, p.punch - dt * 5);
    updateParticles(dt);
    S.shake = Math.max(0, S.shake - dt * 2.5);
    S.hurtFlash = Math.max(0, S.hurtFlash - dt * 2);
    if (!S.me.alive && S.me.respawnIn > 0) S.me.respawnIn = Math.max(0, S.me.respawnIn - dt);
    render(now, dt);
    updateEngines();
    if (now >= S.mmNext) {
      S.mmNext = now + 66;
      drawRadar(now);
      if (S.bigOpen) drawBigMap(now);
    }
    if (now >= S.hudNext) { S.hudNext = now + 100; updateHud(false); }
  }

  function updateEngines() {
    const list = [];
    if (S.me.vehicle && S.car) list.push({ freq: 42 + Math.abs(S.car.v) * 7 + (S.car.thr > 0 ? 12 : 0), gain: 0.05 + Math.min(0.07, Math.abs(S.car.v) * 0.005) + (S.car.thr ? 0.02 : 0) });
    else list.push(null);
    const near = [];
    for (const v of S.vehicles.values()) {
      if (v.id === S.me.vehicle || Math.abs(v.v) < 1) continue;
      const d = Math.hypot(v.rx - S.me.x, v.ry - S.me.y);
      if (d < 24) near.push({ d, v });
    }
    near.sort((a, b) => a.d - b.d);
    for (let i = 0; i < 2; i++) {
      const n = near[i];
      list.push(n ? { freq: 38 + Math.abs(n.v.v) * 6, gain: 0.045 * Math.pow(1 - n.d / 24, 1.5) } : null);
    }
    Sound.engines(list);
  }

  function render(now, dt) {
    const map = S.map;
    // камера всегда держит игрока по центру; за рулём на скорости немного отъезжает
    let zoom = 1;
    if (S.me.alive && S.me.vehicle && S.car) zoom = 1 + 0.45 * Math.min(1, Math.abs(S.car.v) / CAR.MAX);
    else if (S.me.alive) zoom = WEAPONS[S.me.cur].zoom || 1;
    S.zoomR += (KV.VIEW_RADIUS * zoom - S.zoomR) * Math.min(1, dt * 3);
    const want = Math.max(6, Math.round(Math.min(canvas.width, canvas.height) / (2 * S.zoomR)));
    if (!S.tp || Math.abs(want - S.tp) / S.tp > 0.07) S.tp = want;
    const tp = S.tp;
    const hw = canvas.width / 2 / tp, hh = canvas.height / 2 / tp;
    let camX = S.cam.x, camY = S.cam.y;
    if (S.shake > 0) { camX += (Math.random() - 0.5) * S.shake * 0.5; camY += (Math.random() - 0.5) * S.shake * 0.5; }
    const ox = Math.round(canvas.width / 2 - camX * tp), oy = Math.round(canvas.height / 2 - camY * tp);
    S.view.tp = tp; S.view.ox = ox; S.view.oy = oy; S.view.hw = hw; S.view.hh = hh;
    const x0 = -ox / tp, y0 = -oy / tp, x1 = (canvas.width - ox) / tp, y1 = (canvas.height - oy) / tp;
    const inView = (x, y, w, h) => x + w > x0 - 1 && y + h > y0 - 1 && x < x1 + 1 && y < y1 + 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0c0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(tp, 0, 0, tp, ox, oy);
    ctx.imageSmoothingEnabled = true;
    drawChunks(x0, y0, x1, y1, tp);
    drawDecals(now, inView);
    const tsec = now / 1000;
    for (const pk of S.pickups.values()) if (inView(pk.x - 2, pk.y - 2, 4, 4)) drawPickup(pk, tsec);

    const rt = Date.now() + (S.clockOff || 0) - INTERP_MS;
    const tags = [];
    // машины
    for (const [id, v] of S.vehicles) {
      if (Date.now() - v.seen > 1000) { S.vehicles.delete(id); continue; }
      if (id === S.me.vehicle && S.car) { v.rx = S.car.x; v.ry = S.car.y; v.ra = S.car.a; }
      else if (!interpolate(v, rt)) continue;
      if (!inView(v.rx - 3, v.ry - 3, 6, 6)) continue;
      const speed = id === S.me.vehicle && S.car ? S.car.v : v.v;
      const fl = id === S.me.vehicle && S.car ? (v.fl & ~1) | (S.car.thr < 0 && S.car.v > 0.5 ? 1 : 0) : v.fl;
      drawVehicle(v.rx, v.ry, v.ra, v.color, v.st, fl, speed, id === S.me.vehicle);
      if (v.driver && !(v.fl & 4)) {
        const d = S.players.get(v.driver);
        if (d) tags.push({ name: d.name, bot: d.bot, x: v.rx, y: v.ry - 2.4, hp: 100, me: v.driver === S.myId });
      }
    }

    // люди
    const myB = myBuilding();
    for (const p of S.players.values()) {
      if (p.id === S.myId) continue;
      p.hidden = true;
      if (!(p.flags & 1) || (p.flags & 8) || Date.now() - p.seen > 400 || !interpolate(p, rt)) { p.lx = null; continue; }
      const k = tileAt(Math.floor(p.rx), Math.floor(p.ry));
      const bid = k >= 0 ? map.owner[k] : -1;
      // шаги и походка по тому, как сместился
      if (p.lx !== null) {
        const dx = p.rx - p.lx, dy = p.ry - p.ly, d = Math.hypot(dx, dy);
        p.mvx = p.mvx * 0.7 + (dt > 0 ? dx / dt : 0) * 0.3;
        p.mvy = p.mvy * 0.7 + (dt > 0 ? dy / dt : 0) * 0.3;
        p.walk += d * 4.8;
        p.stepAcc += d;
        if (p.stepAcc > 1.3) {
          p.stepAcc = 0;
          if (Math.hypot(p.rx - S.me.x, p.ry - S.me.y) < 15) Sound.step(k >= 0 ? map.ground[k] : G.ROAD, p.rx, p.ry, 0.7);
        }
      }
      p.lx = p.rx; p.ly = p.ry;
      if (bid >= 0 && bid !== myB && map.buildings[bid].alpha > 0.5) continue; // под крышей - не видно
      p.hidden = false;
      if (!inView(p.rx - 1, p.ry - 1, 2, 2)) continue;
      const moving = Math.hypot(p.mvx, p.mvy) > 1;
      drawPlayer(p.rx, p.ry, p.ra, p.color, p.w, p.flags, p.punch, a11y('contrast'), p.walk, Math.atan2(p.mvy, p.mvx), moving);
      tags.push({ name: p.name, bot: p.bot, x: p.rx, y: p.ry - 0.62, hp: p.hp, me: false });
    }
    for (const n of S.npcs) {
      const age = (now - n.t0) / 1000;
      ctx.globalAlpha = Math.max(0, Math.min(1, 2.8 - age));
      drawPlayer(n.x, n.y, n.a, n.color, 0, 0, 0, false, n.walk, n.a, true);
      ctx.globalAlpha = 1;
    }
    if (S.me.alive && !S.me.vehicle) {
      const w = WEAPONS[S.me.cur];
      if (w.id === W.SNIPER || (input.mode === 'touch' && input.aim)) {
        const len = laserLength(S.me.x, S.me.y, S.me.a, w.id === W.SNIPER ? 40 : Math.min(w.range || 2, 9));
        ctx.strokeStyle = w.id === W.SNIPER ? 'rgba(255,40,40,0.55)' : 'rgba(255,255,255,0.28)';
        ctx.lineWidth = 0.05;
        ctx.setLineDash([0.3, 0.25]);
        ctx.beginPath(); ctx.moveTo(S.me.x + Math.cos(S.me.a) * 0.6, S.me.y + Math.sin(S.me.a) * 0.6); ctx.lineTo(S.me.x + Math.cos(S.me.a) * len, S.me.y + Math.sin(S.me.a) * len); ctx.stroke();
        ctx.setLineDash([]);
      }
      const mp = S.players.get(S.myId);
      ctx.strokeStyle = 'rgba(255,210,63,0.75)';
      ctx.lineWidth = 0.07;
      ctx.beginPath(); ctx.arc(S.me.x, S.me.y, 0.72, 0, Math.PI * 2); ctx.stroke();
      drawPlayer(S.me.x, S.me.y, S.me.a, mp ? mp.color : '#fff', S.me.cur, mp ? mp.flags : 0, S.me.punch, true, S.me.walk, S.me.moveAng, S.me.moving);
      tags.push({ name: S.name || 'Вы', bot: false, x: S.me.x, y: S.me.y - 0.62, hp: 100, me: true });
    } else if (S.me.alive && S.me.vehicle && WEAPONS[S.me.cur].id !== W.FISTS && (input.mode === 'touch' ? input.aim : true)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 0.05;
      ctx.setLineDash([0.3, 0.25]);
      ctx.beginPath(); ctx.moveTo(S.me.x + Math.cos(S.me.a) * 1.2, S.me.y + Math.sin(S.me.a) * 1.2); ctx.lineTo(S.me.x + Math.cos(S.me.a) * 7, S.me.y + Math.sin(S.me.a) * 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    drawBullets(now);
    drawParticles(false);
    drawCanopies(x0, y0, x1, y1);
    drawRoofs(dt, inView, myB);
    drawParticles(true);
    drawEffects(now);

    // --- экранный слой ---
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const hud = a11y('large') ? 1.25 : 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = `700 ${Math.round(13 * dpr * hud)}px system-ui, sans-serif`;
    ctx.lineJoin = 'round';
    for (const t of tags) {
      const sx = t.x * tp + ox, sy = t.y * tp + oy;
      ctx.lineWidth = 3.5 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(t.name, sx, sy);
      ctx.fillStyle = t.me ? '#ffd23f' : t.bot ? '#d6dbe3' : '#ffffff';
      ctx.fillText(t.name, sx, sy);
      if (t.hp < 100) {
        const bw = 34 * dpr, bh = 4 * dpr;
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(sx - bw / 2, sy + 2 * dpr, bw, bh);
        ctx.fillStyle = t.hp > 50 ? '#4cd964' : t.hp > 25 ? '#ffcc00' : '#ff3b30';
        ctx.fillRect(sx - bw / 2, sy + 2 * dpr, (bw * t.hp) / 100, bh);
      }
    }
    for (let i = S.hitMarks.length - 1; i >= 0; i--) {
      const h = S.hitMarks[i];
      const k = (now - h.t0) / 280;
      if (k >= 1) { S.hitMarks.splice(i, 1); continue; }
      const sx = h.x * tp + ox, sy = h.y * tp + oy, r = (6 + 4 * k) * dpr;
      ctx.strokeStyle = `rgba(255,255,255,${1 - k})`;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(sx - r, sy - r); ctx.lineTo(sx - r / 2, sy - r / 2); ctx.moveTo(sx + r, sy - r); ctx.lineTo(sx + r / 2, sy - r / 2);
      ctx.moveTo(sx - r, sy + r); ctx.lineTo(sx - r / 2, sy + r / 2); ctx.moveTo(sx + r, sy + r); ctx.lineTo(sx + r / 2, sy + r / 2);
      ctx.stroke();
    }
    const low = S.me.alive && S.me.hp < 30 ? 0.25 + 0.15 * Math.sin(now / 200) : 0;
    const red = Math.max(S.hurtFlash * 0.45, low);
    if (red > 0.01) {
      const g = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) * 0.3, canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.75);
      g.addColorStop(0, 'rgba(200,0,0,0)');
      g.addColorStop(1, `rgba(200,0,0,${red})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (!S.me.alive) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    if (input.mode === 'touch') {
      drawStick(input.move, cw * 0.16, ch * 0.72, 'rgba(255,255,255,');
      drawStick(input.aim, cw * 0.72, ch * 0.72, 'rgba(255,120,100,');
    }
  }

  function drawStick(st, defX, defY, col) {
    const R = STICK_R * dpr;
    const ox = (st ? st.ox : defX) * dpr, oy = (st ? st.oy : defY) * dpr;
    ctx.fillStyle = col + (st ? '0.10)' : '0.05)');
    ctx.strokeStyle = col + (st ? '0.45)' : '0.18)');
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.arc(ox, oy, R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    let kx = 0, ky = 0;
    if (st) {
      kx = (st.x - st.ox) * dpr; ky = (st.y - st.oy) * dpr;
      const l = Math.hypot(kx, ky);
      if (l > R) { kx *= R / l; ky *= R / l; }
    }
    ctx.fillStyle = col + (st ? '0.55)' : '0.2)');
    ctx.beginPath(); ctx.arc(ox + kx, oy + ky, R * 0.42, 0, Math.PI * 2); ctx.fill();
  }

  // для автотестов
  window.__kv = { S, input, WEAPONS, selectWeapon, send, carAction, nearCar };

  resize();
  requestAnimationFrame(frame);
})();
