'use strict';
/*
 * Комната = отдельная карта и партия «все против всех» с возрождением.
 * Сервер главный во всём, кроме шагов игрока: позицию присылает клиент, сервер её проверяет
 * (скорость, стены) и при обмане возвращает игрока назад. Пули, взрывы, урон, разрушение
 * клеток, оружие на карте и боты считаются только на сервере.
 */
const KV = require('../public/shared.js');
const { generateMap } = require('./mapgen');
const geom = require('./geom');
const { Bots } = require('./bots');
const { G, B, BLOCKS, W, WEAPONS, WEAPON_WEIGHTS, PK } = KV;

const DT = 1 / KV.TICK_RATE;
const MAX_HUMANS = 16;
const MIN_PLAYERS = 4;          // боты добирают до этого числа
const MAX_PICKUPS = 18;
const PICKUP_LIFE = 120;        // с
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45',
  '#fabed4', '#469990', '#dcbeff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#ffd8b1', '#a9a9a9', '#ffe119'];
const BOT_NAMES = ['Шустрый', 'Бородач', 'Кепка', 'Гвоздь', 'Сова', 'Тихий', 'Мотор', 'Лапша', 'Пиксель', 'Сухарь'];

const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;

function emptyEvents() {
  // b - пули, be - конец пули, x - взрывы, tl - клетки, rf - обрушение крыш, od - взорванные машины,
  // k - убийства, hu - попадания, pa/pr/pu - оружие на карте (появилось/исчезло/подобрано),
  // pj/pl - вход/выход игроков, sp - возрождения, m - удары кулаком
  return { b: [], be: [], x: [], tl: [], rf: [], od: [], k: [], hu: [], pa: [], pr: [], pu: [], pj: [], pl: [], sp: [], m: [] };
}

class Room {
  constructor(id) {
    this.id = id;
    this.seed = (Math.random() * 4294967296) >>> 0;
    this.map = generateMap(this.seed);
    this.players = new Map();
    this.nextId = 1;
    this.bullets = [];
    this.nextBullet = 1;
    this.pickups = new Map();
    this.nextPickup = 1;
    this.pending = [];            // отложенные взрывы (цепные реакции)
    this.recentShots = [];        // куда идут боты на звук
    this.time = 0;
    this.tickNo = 0;
    this.nextWeaponAt = 3;
    this.nextSupplyAt = 15;
    this.ev = emptyEvents();
    this.emptySince = Date.now();
    this.sbDirty = true;
    this.bots = new Bots(this);
    this.fillBots();
  }

  // ---------- игроки ----------
  humanCount() { let n = 0; for (const p of this.players.values()) if (!p.isBot) n++; return n; }

  pickColor() {
    const used = new Set([...this.players.values()].map(p => p.color));
    return COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
  }

  createPlayer(name, isBot) {
    const p = {
      id: this.nextId++, name, isBot, ws: null, color: this.pickColor(),
      x: 0, y: 0, a: 0, hp: 0, ar: 0, alive: false, respawnAt: 0,
      ammo: [0, -1, -1, -1, -1, -1], cur: 0, fire: false, fireLatch: false, nextShot: 0,
      kills: 0, deaths: 0, prot: 0, tp: 0, budget: 0, lastMoveTime: 0, shotAt: -10,
      view: [24, 16], ai: null
    };
    this.players.set(p.id, p);
    return p;
  }

  publicInfo(p) { return [p.id, p.name, p.color, p.isBot ? 1 : 0, p.kills, p.deaths]; }

  addHuman(ws, name) {
    if (this.humanCount() >= MAX_HUMANS) return null;
    const p = this.createPlayer(name, false);
    p.ws = ws;
    this.emptySince = null;
    this.fillBots();
    this.send(p, this.welcome(p));
    this.ev.pj.push(this.publicInfo(p));
    this.spawn(p);
    this.sbDirty = true;
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.ev.pl.push(id);
    if (!p.isBot && this.humanCount() === 0) this.emptySince = Date.now();
    this.fillBots();
    this.sbDirty = true;
  }

  fillBots() {
    const humans = this.humanCount();
    const bots = [...this.players.values()].filter(p => p.isBot);
    const want = humans === 0 && this.tickNo > 0 ? 0 : Math.max(0, MIN_PLAYERS - humans);
    let n = bots.length;
    while (n < want) {
      const used = new Set(bots.map(b => b.name));
      const name = (BOT_NAMES.find(nm => !used.has(nm + ' (бот)')) || 'Бот') + ' (бот)';
      const b = this.createPlayer(name, true);
      bots.push(b);
      this.ev.pj.push(this.publicInfo(b));
      this.spawn(b);
      n++;
    }
    while (n > want) {
      const b = bots.sort((a, c) => (a.alive - c.alive) || (a.kills - c.kills)).shift();
      this.players.delete(b.id);
      this.ev.pl.push(b.id);
      n--;
    }
  }

  spawn(p) {
    const m = this.map;
    const tiles = m.spawnTiles;
    let best = tiles[Math.floor(Math.random() * tiles.length)], bestScore = -1;
    for (let i = 0; i < 28; i++) {
      const k = tiles[Math.floor(Math.random() * tiles.length)];
      const x = (k % m.w) + 0.5, y = Math.floor(k / m.w) + 0.5;
      if (!KV.circleFree(m, x, y, KV.PLAYER_R)) continue;
      let dmin = 60;
      for (const o of this.players.values()) if (o !== p && o.alive) dmin = Math.min(dmin, Math.hypot(o.x - x, o.y - y));
      if (dmin > bestScore) { bestScore = dmin; best = k; }
    }
    p.x = (best % m.w) + 0.5;
    p.y = Math.floor(best / m.w) + 0.5;
    p.hp = KV.MAX_HP; p.ar = 0; p.alive = true;
    p.ammo = [0, -1, -1, -1, -1, -1]; p.cur = W.FISTS;
    p.fire = false; p.fireLatch = false;
    p.prot = this.time + KV.SPAWN_PROTECT;
    p.budget = 0; p.lastMoveTime = this.time;
    p.tp++;
    if (p.ai) { p.ai.path = null; p.ai.target = null; }
    this.ev.sp.push([p.id, r2(p.x), r2(p.y)]);
    this.send(p, { t: 'tp', x: p.x, y: p.y, tp: p.tp, sp: 1 });
  }

  teleport(p, x, y) {
    p.x = x; p.y = y; p.tp++; p.budget = 0; p.lastMoveTime = this.time;
    this.send(p, { t: 'tp', x: r2(x), y: r2(y), tp: p.tp });
  }

  send(p, msg) {
    const ws = p.ws;
    if (ws && ws.readyState === 1 && ws.bufferedAmount < 1e6) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  welcome(p) {
    const m = this.map;
    const d = [];
    for (let k = 0; k < m.dmg.length; k++) if (m.dmg[k]) d.push(k, m.dmg[k]);
    return {
      t: 'welcome', id: p.id, room: this.id,
      map: {
        w: m.w, h: m.h, g: KV.rleEncode(m.ground), b: KV.rleEncode(m.block), d,
        bld: m.buildings.map(b => [b.x, b.y, b.w, b.h, b.roof ? 1 : 0]),
        obj: m.objects.map(o => [o.x, o.y, o.w, o.h, o.color, o.v, o.f, o.dead ? 1 : 0]),
        roads: m.roads
      },
      players: [...this.players.values()].map(o => this.publicInfo(o)),
      pickups: [...this.pickups.values()].map(pk => [pk.id, pk.kind, pk.w, r2(pk.x), r2(pk.y)])
    };
  }

  // ---------- сообщения клиента ----------
  onMessage(p, msg) {
    if (msg.t === 'i') this.onInput(p, msg);
    else if (msg.t === 'w') {
      const i = msg.i | 0;
      if (i >= 0 && i < WEAPONS.length && (i === W.FISTS || p.ammo[i] > 0)) p.cur = i;
    } else if (msg.t === 'dbg' && process.env.KV_DEBUG === '1') {
      // только для автотестов на своём компьютере: на хостинге переменная KV_DEBUG не задана
      if (msg.give) { for (const w of WEAPONS) if (w.max) p.ammo[w.id] = w.max; }
      if (msg.god) p.prot = this.time + 600;
      if (Array.isArray(msg.tp)) {
        const x = Number(msg.tp[0]), y = Number(msg.tp[1]);
        if (Number.isFinite(x) && Number.isFinite(y) && KV.circleFree(this.map, x, y, KV.PLAYER_R)) this.teleport(p, x, y);
      }
    }
  }

  onInput(p, m) {
    const a = Number(m.a);
    if (Number.isFinite(a)) p.a = a;
    p.fire = !!m.f;
    if (m.f) p.fireLatch = true;
    if (Array.isArray(m.v)) {
      const vw = Number(m.v[0]), vh = Number(m.v[1]);
      if (Number.isFinite(vw) && Number.isFinite(vh)) p.view = [Math.max(8, Math.min(70, vw)), Math.max(8, Math.min(70, vh))];
    }
    if (!p.alive || m.tp !== p.tp) return;
    const x = Number(m.x), y = Number(m.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const dist = Math.hypot(x - p.x, y - p.y);
    if (dist < 1e-4) return;
    p.budget = Math.min(p.budget + (this.time - p.lastMoveTime) * KV.PLAYER_SPEED * 1.25, KV.PLAYER_SPEED * 1.0);
    p.lastMoveTime = this.time;
    if (dist <= p.budget + 0.06 &&
        KV.circleFree(this.map, x, y, KV.PLAYER_R * 0.85) &&
        KV.segmentClear(this.map, p.x, p.y, x, y, KV.PLAYER_R * 0.7)) {
      p.x = x; p.y = y; p.budget -= dist;
    } else {
      this.teleport(p, p.x, p.y);
    }
  }

  // ---------- такт ----------
  tick() {
    this.time += DT;
    this.tickNo++;
    for (const p of this.players.values()) if (p.isBot) this.bots.update(p, DT);
    for (const p of this.players.values()) this.updateFiring(p);
    this.updateBullets();
    this.updatePending();
    this.updatePickups();
    for (const p of this.players.values()) if (!p.alive && this.time >= p.respawnAt) this.spawn(p);
    if (this.recentShots.length && this.time - this.recentShots[0].t > 5) this.recentShots = this.recentShots.filter(s => this.time - s.t <= 5);
    this.flushEvents();
    if (this.tickNo % 2 === 0) this.sendSnapshots();
    if (this.tickNo % 15 === 0) this.sendPings();
    if (this.tickNo % 30 === 0 && this.sbDirty) this.sendScoreboard();
  }

  // ---------- стрельба ----------
  bestWeapon(p) {
    for (const w of [W.RIFLE, W.SHOTGUN, W.SNIPER, W.PISTOL, W.LAUNCHER]) if (p.ammo[w] > 0) return w;
    return W.FISTS;
  }

  updateFiring(p) {
    if (!p.alive || !(p.fire || p.fireLatch)) return;
    if (this.time < p.nextShot) return;
    if (p.cur !== W.FISTS && !(p.ammo[p.cur] > 0)) { p.cur = this.bestWeapon(p); p.fireLatch = false; return; }
    const w = WEAPONS[p.cur];
    p.fireLatch = false;
    p.nextShot = this.time + 1 / w.rate;
    p.prot = 0; // стрельба снимает защиту после появления
    p.shotAt = this.time;
    if (!p.isBot && w.id !== W.FISTS) this.recentShots.push({ x: p.x, y: p.y, t: this.time });
    if (w.melee) { this.melee(p, w); return; }
    p.ammo[p.cur]--;
    const n = w.pellets || 1;
    for (let i = 0; i < n; i++) {
      const ang = n > 1
        ? p.a + (i / (n - 1) - 0.5) * w.spread + (Math.random() - 0.5) * 0.05
        : p.a + (Math.random() - 0.5) * 2 * w.spread;
      const b = {
        id: this.nextBullet++, owner: p.id, w: w.id, x: p.x, y: p.y,
        dx: Math.cos(ang), dy: Math.sin(ang), speed: w.speed, left: w.range, range: w.range, dead: false
      };
      this.bullets.push(b);
      this.ev.b.push([b.id, w.id, r2(b.x), r2(b.y), r3(ang), p.id]);
    }
    if (p.ammo[p.cur] <= 0) p.cur = this.bestWeapon(p);
  }

  melee(p, w) {
    this.ev.m.push(p.id);
    const ax = Math.cos(p.a), ay = Math.sin(p.a);
    let target = null, bestD = w.range + 0.5;
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      const dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy);
      if (d > w.range + 0.5 || d >= bestD) continue;
      if ((dx * ax + dy * ay) / (d || 1) < 0.45) continue; // примерно ±63° перед собой
      if (!geom.losClear(this.map, p.x, p.y, o.x, o.y, false)) continue;
      target = o; bestD = d;
    }
    if (target) { this.damage(target, w.dmg, p.id, w.id, target.x, target.y); return; }
    const tx = Math.floor(p.x + ax * (KV.PLAYER_R + 0.45)), ty = Math.floor(p.y + ay * (KV.PLAYER_R + 0.45));
    if (tx > 0 && ty > 0 && tx < this.map.w - 1 && ty < this.map.h - 1) this.damageTile(ty * this.map.w + tx, w.tileDmg, p.id);
  }

  updateBullets() {
    const m = this.map;
    for (const b of this.bullets) {
      const step = Math.min(b.speed * DT, b.left);
      const hitT = geom.raycast(m, b.x, b.y, b.dx, b.dy, step);
      let tBest = hitT ? hitT.t : Infinity, target = null;
      for (const p of this.players.values()) {
        if (!p.alive || p.id === b.owner) continue;
        const t = geom.rayCircle(b.x, b.y, b.dx, b.dy, p.x, p.y, 0.5);
        if (t >= 0 && t <= step && t < tBest) { tBest = t; target = p; }
      }
      const w = WEAPONS[b.w];
      if (target || (hitT && hitT.t <= step)) {
        const back = w.grenade ? 0.08 : 0;
        const hx = b.x + b.dx * Math.max(0, tBest - back), hy = b.y + b.dy * Math.max(0, tBest - back);
        b.dead = true;
        if (w.grenade) { this.ev.be.push([b.id, r2(hx), r2(hy), 3]); this.explode(hx, hy, w.blast, b.owner, w.id); continue; }
        const travelled = b.range - b.left + tBest;
        const fall = b.w === W.SHOTGUN ? 1 - 0.5 * Math.min(1, travelled / b.range) : 1;
        if (target) {
          this.ev.be.push([b.id, r2(hx), r2(hy), 2]);
          this.damage(target, w.dmg * fall, b.owner, w.id, hx, hy);
        } else {
          this.ev.be.push([b.id, r2(hx), r2(hy), 1]);
          if (hitT.k >= 0) this.damageTile(hitT.k, w.dmg * fall, b.owner);
        }
        continue;
      }
      b.x += b.dx * step; b.y += b.dy * step; b.left -= step;
      if (b.left <= 1e-6) {
        b.dead = true;
        if (w.grenade) { this.ev.be.push([b.id, r2(b.x), r2(b.y), 3]); this.explode(b.x, b.y, w.blast, b.owner, w.id); }
        else this.ev.be.push([b.id, r2(b.x), r2(b.y), 0]);
      }
    }
    if (this.bullets.some(b => b.dead)) this.bullets = this.bullets.filter(b => !b.dead);
  }

  // ---------- урон ----------
  damage(t, amount, attackerId, weaponId, hx, hy) {
    if (!t.alive || amount <= 0 || this.time < t.prot) return;
    const absorbed = Math.min(t.ar, amount * 0.6);
    t.ar -= absorbed;
    t.hp -= amount - absorbed;
    this.ev.hu.push([t.id, r2(hx), r2(hy), attackerId || 0]);
    if (t.hp <= 0) this.kill(t, attackerId, weaponId);
  }

  kill(t, attackerId, weaponId) {
    t.alive = false; t.hp = 0; t.deaths++;
    t.fire = false; t.fireLatch = false;
    t.respawnAt = this.time + KV.RESPAWN_DELAY;
    const a = this.players.get(attackerId);
    if (a && a !== t) a.kills++;
    this.ev.k.push([attackerId || 0, t.id, weaponId]);
    if (t.cur !== W.FISTS && t.ammo[t.cur] > 0) this.addPickup(PK.WEAPON, t.cur, t.x, t.y, t.ammo[t.cur]);
    this.sbDirty = true;
  }

  explode(x, y, blast, ownerId, weaponId) {
    const m = this.map;
    this.ev.x.push([r2(x), r2(y), blast.r]);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d >= blast.r + 0.4) continue;
      let dmg = blast.dmg * (1 - Math.max(0, d - 0.4) / blast.r);
      if (!geom.losClear(m, x, y, p.x, p.y, false)) dmg *= 0.4;
      this.damage(p, dmg, ownerId, weaponId, p.x, p.y);
    }
    const r = blast.r;
    for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
      for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
        if (tx <= 0 || ty <= 0 || tx >= m.w - 1 || ty >= m.h - 1) continue;
        const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
        if (d >= r) continue;
        const k = ty * m.w + tx;
        const bt = m.block[k];
        if (bt === B.NONE) continue;
        this.damageTile(k, blast.tile * (1 - d / r) * BLOCKS[bt].blast, ownerId);
      }
    }
    // взрыв внутри дома обрушивает крышу
    const fx = Math.floor(x), fy = Math.floor(y);
    if (fx >= 0 && fy >= 0 && fx < m.w && fy < m.h) {
      const bid = m.owner[fy * m.w + fx];
      if (bid >= 0) this.collapseRoof(m.buildings[bid]);
    }
  }

  damageTile(k, amount, ownerId) {
    const m = this.map;
    const t = m.block[k];
    if (t === B.NONE || t === B.BORDER || !(amount > 0)) return;
    const info = BLOCKS[t];
    const before = m.hp[k];
    m.hp[k] -= amount;
    if (m.hp[k] <= 0) { this.destroyTile(k, ownerId); return; }
    const st = KV.damageStage(m.hp[k], info.hp);
    if (st !== KV.damageStage(before, info.hp)) {
      m.dmg[k] = st;
      this.ev.tl.push([k, t, st, m.ground[k]]);
    }
  }

  destroyTile(k, ownerId) {
    const m = this.map;
    const t = m.block[k];
    if (t === B.NONE || t === B.BORDER) return;
    if (t === B.CAR) { this.destroyCar(m.object[k], ownerId); return; }
    const info = BLOCKS[t];
    m.block[k] = B.NONE; m.hp[k] = 0; m.dmg[k] = 0;
    if (info.rubble !== undefined) m.ground[k] = info.rubble;
    this.ev.tl.push([k, 0, 0, m.ground[k], t]);
    const x = k % m.w, y = Math.floor(k / m.w);
    if (info.explode) this.pending.push({ at: this.time + 0.12, x: x + 0.5, y: y + 0.5, blast: info.explode, owner: ownerId, w: -1 });
    const bid = m.owner[k];
    if (t === B.BRICK && bid >= 0) {
      const b = m.buildings[bid];
      b.destroyed++;
      if (b.roof && b.destroyed >= Math.max(3, Math.ceil(b.walls * 0.18))) this.collapseRoof(b);
    }
  }

  destroyCar(objId, ownerId) {
    const m = this.map;
    const o = m.objects[objId];
    if (!o || o.dead) return;
    o.dead = true;
    for (let j = o.y; j < o.y + o.h; j++) {
      for (let i = o.x; i < o.x + o.w; i++) {
        const k = j * m.w + i;
        if (m.block[k] !== B.CAR) continue;
        m.block[k] = B.NONE; m.hp[k] = 0; m.dmg[k] = 0; m.ground[k] = G.BURNT;
        this.ev.tl.push([k, 0, 0, G.BURNT, B.CAR]);
      }
    }
    this.ev.od.push(objId);
    this.pending.push({ at: this.time + 0.15, x: o.x + o.w / 2, y: o.y + o.h / 2, blast: BLOCKS[B.CAR].explode, owner: ownerId, w: -1 });
  }

  collapseRoof(b) {
    if (!b || !b.roof) return;
    b.roof = false;
    this.ev.rf.push(b.id);
  }

  updatePending() {
    if (!this.pending.length) return;
    const due = this.pending.filter(e => e.at <= this.time);
    if (!due.length) return;
    this.pending = this.pending.filter(e => e.at > this.time);
    for (const e of due) this.explode(e.x, e.y, e.blast, e.owner, e.w);
  }

  // ---------- оружие на карте ----------
  addPickup(kind, w, x, y, amount) {
    if (this.pickups.size >= MAX_PICKUPS) {
      const oldest = this.pickups.values().next().value;
      this.removePickup(oldest.id);
    }
    const pk = { id: this.nextPickup++, kind, w, x, y, amount, born: this.time };
    this.pickups.set(pk.id, pk);
    this.ev.pa.push([pk.id, kind, w, r2(x), r2(y)]);
    return pk;
  }

  removePickup(id) {
    if (this.pickups.delete(id)) this.ev.pr.push(id);
  }

  randomPickupSpot(minPlayerDist) {
    const m = this.map;
    const tiles = m.pickupTiles;
    for (let i = 0; i < 40; i++) {
      const k = tiles[Math.floor(Math.random() * tiles.length)];
      if (m.block[k] !== B.NONE) continue;
      const x = (k % m.w) + 0.5, y = Math.floor(k / m.w) + 0.5;
      let ok = true;
      for (const pk of this.pickups.values()) if (Math.hypot(pk.x - x, pk.y - y) < 4) { ok = false; break; }
      if (ok) for (const p of this.players.values()) if (p.alive && Math.hypot(p.x - x, p.y - y) < minPlayerDist) { ok = false; break; }
      if (ok) return [x, y];
    }
    return null;
  }

  spawnWeaponDrop() {
    let total = 0;
    for (const [, wgt] of WEAPON_WEIGHTS) total += wgt;
    let r = Math.random() * total, wid = W.PISTOL;
    for (const [w, wgt] of WEAPON_WEIGHTS) { r -= wgt; if (r <= 0) { wid = w; break; } }
    const spot = this.randomPickupSpot(5);
    if (!spot) return;
    const [x, y] = spot;
    this.addPickup(PK.WEAPON, wid, x, y, WEAPONS[wid].pick);
    // коробка патронов к нему - рядом
    const m = this.map;
    const around = [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2], [1.1, 1.1], [-1.1, 1.1], [1.1, -1.1], [-1.1, -1.1]];
    for (let i = around.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [around[i], around[j]] = [around[j], around[i]]; }
    for (const [dx, dy] of around) {
      const ax = x + dx, ay = y + dy;
      if (KV.circleFree(m, ax, ay, 0.35) && geom.losClear(m, x, y, ax, ay, false)) {
        this.addPickup(PK.AMMO, wid, ax, ay, WEAPONS[wid].box);
        break;
      }
    }
  }

  updatePickups() {
    if (this.time >= this.nextWeaponAt) {
      this.spawnWeaponDrop();
      this.nextWeaponAt = this.time + 12 + Math.random() * 6; // примерно раз в 15 секунд
    }
    if (this.time >= this.nextSupplyAt) {
      const spot = this.randomPickupSpot(5);
      if (spot) this.addPickup(Math.random() < 0.55 ? PK.HEALTH : PK.ARMOR, 0, spot[0], spot[1], 50);
      this.nextSupplyAt = this.time + 20 + Math.random() * 12;
    }
    for (const pk of [...this.pickups.values()]) {
      if (this.time - pk.born > PICKUP_LIFE) { this.removePickup(pk.id); continue; }
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.x - pk.x, dy = p.y - pk.y;
        if (dx * dx + dy * dy > 0.85 * 0.85) continue;
        if (this.tryPick(p, pk)) { this.removePickup(pk.id); break; }
      }
    }
  }

  tryPick(p, pk) {
    if (pk.kind === PK.WEAPON) {
      const w = WEAPONS[pk.w];
      const had = p.ammo[pk.w] >= 0;
      if (had && p.ammo[pk.w] >= w.max) return false;
      p.ammo[pk.w] = Math.min(w.max, Math.max(0, p.ammo[pk.w]) + (pk.amount || w.pick));
      if (!had || p.cur === W.FISTS) p.cur = pk.w;
    } else if (pk.kind === PK.AMMO) {
      const w = WEAPONS[pk.w];
      if (!(p.ammo[pk.w] >= 0) || p.ammo[pk.w] >= w.max) return false;
      p.ammo[pk.w] = Math.min(w.max, p.ammo[pk.w] + (pk.amount || w.box));
    } else if (pk.kind === PK.HEALTH) {
      if (p.hp >= KV.MAX_HP) return false;
      p.hp = Math.min(KV.MAX_HP, p.hp + (pk.amount || 50));
    } else {
      if (p.ar >= KV.MAX_ARMOR) return false;
      p.ar = Math.min(KV.MAX_ARMOR, p.ar + (pk.amount || 50));
    }
    this.ev.pu.push([p.id, pk.kind, pk.w]);
    return true;
  }

  // ---------- рассылка ----------
  flushEvents() {
    const out = { t: 'e' };
    let any = false;
    for (const key in this.ev) if (this.ev[key].length) { out[key] = this.ev[key]; any = true; }
    this.ev = emptyEvents();
    if (!any) return;
    const json = JSON.stringify(out);
    for (const p of this.players.values()) if (!p.isBot) this.send(p, json);
  }

  sendSnapshots() {
    const ts = Date.now();
    const all = [...this.players.values()];
    for (const p of all) {
      if (p.isBot) continue;
      const list = [];
      for (const o of all) {
        if (o !== p && (Math.abs(o.x - p.x) > p.view[0] + 6 || Math.abs(o.y - p.y) > p.view[1] + 6)) continue;
        const flags = (o.alive ? 1 : 0) | (this.time < o.prot ? 2 : 0) | (this.time - o.shotAt < 0.15 ? 4 : 0);
        list.push([o.id, r2(o.x), r2(o.y), r3(o.a), flags, o.cur, Math.max(0, Math.ceil(o.hp))]);
      }
      const me = [Math.max(0, Math.ceil(p.hp)), Math.ceil(p.ar), p.cur, p.ammo, p.alive ? 0 : r2(Math.max(0, p.respawnAt - this.time)), p.alive ? 1 : 0];
      this.send(p, { t: 's', ts, p: list, me });
    }
  }

  sendPings() {
    // кто стрелял последние 2.5 с - красная точка на миникарте у всех (кулаки не считаются)
    const l = [];
    for (const p of this.players.values()) if (p.alive && this.time - p.shotAt < 2.5 && p.cur !== W.FISTS) l.push([p.id, Math.round(p.x), Math.round(p.y)]);
    const json = JSON.stringify({ t: 'mm', l });
    for (const p of this.players.values()) if (!p.isBot) this.send(p, json);
  }

  sendScoreboard() {
    this.sbDirty = false;
    const json = JSON.stringify({ t: 'sb', l: [...this.players.values()].map(p => [p.id, p.kills, p.deaths]) });
    for (const p of this.players.values()) if (!p.isBot) this.send(p, json);
  }
}

module.exports = { Room, MAX_HUMANS };
