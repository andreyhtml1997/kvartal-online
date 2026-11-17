'use strict';
/*
 * Комната = отдельная карта и партия «все против всех» с возрождением.
 * Сервер главный во всём, кроме шагов игрока и руля его машины: их присылает браузер,
 * а сервер проверяет скорость и стены и при обмане возвращает назад. Пули, взрывы, урон,
 * разрушение клеток, оружие и ящики на карте, машины с водителями и боты считаются только на сервере.
 */
const KV = require('../public/shared.js');
const { generateMap } = require('./mapgen');
const geom = require('./geom');
const { Bots } = require('./bots');
const { Vehicles } = require('./vehicles');
const { G, B, BLOCKS, W, WEAPONS, WEAPON_WEIGHTS, PK, CAR, STAMINA } = KV;

const DT = 1 / KV.TICK_RATE;
const MAX_HUMANS = 16;
const MIN_PLAYERS = 4;          // боты добирают до этого числа
const MAX_PICKUPS = 24;
const PICKUP_LIFE = 120;        // с
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45',
  '#fabed4', '#469990', '#dcbeff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#ffd8b1', '#a9a9a9', '#ffe119'];
const BOT_NAMES = ['Шустрый', 'Бородач', 'Кепка', 'Гвоздь', 'Сова', 'Тихий', 'Мотор', 'Лапша', 'Пиксель', 'Сухарь'];

const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;

function emptyEvents() {
  // b - пули, be - конец пули, x - взрывы, tl - клетки, rf - обрушение крыш, k - убийства, hu - попадания,
  // pa/pr/pu - вещи на карте (появилась/исчезла/подобрана), pj/pl - вход/выход игроков, sp - возрождения,
  // m - удары кулаком; машины: en/ex - сел/вышел, hn - гудок, ck - сбила человека, cr - удар, vf - загорелась,
  // vx - взорвалась, fl - водитель убегает
  return {
    b: [], be: [], x: [], tl: [], rf: [], k: [], hu: [], pa: [], pr: [], pu: [], pj: [], pl: [], sp: [], m: [],
    en: [], ex: [], hn: [], ck: [], cr: [], vf: [], vx: [], fl: [], bo: []
  };
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
    this.nextCrateAt = 10;
    this.crates = this.map.crates;
    this.ev = emptyEvents();
    this.emptySince = Date.now();
    this.sbDirty = true;
    this.botsOn = true;           // переключатель «Боты» под шестерёнкой, на всю комнату
    this.bots = new Bots(this);
    this.vehicles = new Vehicles(this);
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
      view: [24, 16], ai: null, vehicle: 0, stamina: STAMINA.MAX, staminaT: 0, sprint: false, hornAt: -10
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

  removePlayer(id, fromFill) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.vehicle) {
      const v = this.vehicles.list.get(p.vehicle);
      if (v) { v.state = 'parked'; v.driver = 0; v.tp++; }
      p.vehicle = 0;
    }
    this.players.delete(id);
    this.ev.pl.push(id);
    if (!p.isBot && this.humanCount() === 0) this.emptySince = Date.now();
    if (!fromFill) this.fillBots();
    this.sbDirty = true;
  }

  fillBots() {
    const humans = this.humanCount();
    const bots = [...this.players.values()].filter(p => p.isBot);
    const want = !this.botsOn || (humans === 0 && this.tickNo > 0) ? 0 : Math.max(0, MIN_PLAYERS - humans);
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
      this.removePlayer(b.id, true);
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
      if (!KV.circleFree(m, x, y, KV.PLAYER_R) || this.vehicles && this.vehicles.personBlocked(x, y, null)) continue;
      let dmin = 60;
      for (const o of this.players.values()) if (o !== p && o.alive) dmin = Math.min(dmin, Math.hypot(o.x - x, o.y - y));
      if (dmin > bestScore) { bestScore = dmin; best = k; }
    }
    p.x = (best % m.w) + 0.5;
    p.y = Math.floor(best / m.w) + 0.5;
    p.hp = KV.MAX_HP; p.ar = 0; p.alive = true; p.vehicle = 0;
    p.ammo = [0, -1, -1, -1, -1, -1]; p.cur = W.FISTS;
    p.fire = false; p.fireLatch = false; p.sprint = false; p.stamina = STAMINA.MAX;
    p.prot = this.time + KV.SPAWN_PROTECT;
    p.budget = 0; p.lastMoveTime = this.time;
    p.tp++;
    if (p.ai) { p.ai.path = null; p.ai.target = null; p.ai.carGoal = 0; }
    this.ev.sp.push([p.id, r2(p.x), r2(p.y)]);
    this.send(p, { t: 'tp', x: p.x, y: p.y, tp: p.tp, sp: 1, veh: 0 });
  }

  teleport(p, x, y) {
    p.x = x; p.y = y; p.tp++; p.budget = 0; p.lastMoveTime = this.time;
    this.send(p, { t: 'tp', x: r2(x), y: r2(y), tp: p.tp, veh: p.vehicle || 0 });
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
        roads: m.roads
      },
      players: [...this.players.values()].map(o => this.publicInfo(o)),
      pickups: [...this.pickups.values()].map(pk => [pk.id, pk.kind, pk.w, r2(pk.x), r2(pk.y)]),
      bots: this.botsOn
    };
  }

  // ---------- сообщения клиента ----------
  onMessage(p, msg) {
    switch (msg.t) {
      case 'i': this.onInput(p, msg); break;
      case 'w': {
        const i = msg.i | 0;
        if (i >= 0 && i < WEAPONS.length && (i === W.FISTS || p.ammo[i] > 0)) p.cur = i;
        break;
      }
      case 'enter': if (p.alive && !p.vehicle) this.vehicles.enter(p, msg.id | 0); break;
      case 'exit': if (p.vehicle) this.vehicles.exit(p, false); break;
      case 'horn':
        if (p.vehicle && this.time - p.hornAt > 0.5) { p.hornAt = this.time; this.ev.hn.push(p.vehicle); }
        break;
      case 'ram': if (p.vehicle) this.vehicles.onRam(p, msg); break;
      case 'push': if (p.vehicle) this.vehicles.onPush(p, msg.l); break;
      case 'bots': {
        const on = !!msg.on;
        if (on === this.botsOn || this.time - (this.botsAt || -10) < 1) break;
        this.botsOn = on;
        this.botsAt = this.time;
        this.fillBots();
        this.ev.bo.push([on ? 1 : 0, p.name]);
        break;
      }
      case 'crash': if (p.vehicle) this.vehicles.onCrash(p, msg); break;
      case 'dbg':
        // только для автотестов на своём компьютере: на хостинге переменная KV_DEBUG не задана
        if (process.env.KV_DEBUG !== '1') break;
        if (msg.give) { for (const w of WEAPONS) if (w.max) p.ammo[w.id] = w.max; }
        if (msg.god) p.prot = this.time + 600;
        if (msg.carAhead && p.vehicle) {
          // стоящая машина прямо перед своей - для проверки толкания
          const v = this.vehicles.list.get(p.vehicle);
          if (v) {
            const x = v.x + Math.cos(v.a) * 4.6, y = v.y + Math.sin(v.a) * 4.6;
            if (!KV.carHitsHard(this.map, x, y, v.a, 0.05)) this.vehicles.create(x, y, v.a, 5, 'parked', null);
          }
        }
        if (msg.nearCar) {
          let best = null, bd = 1e9;
          for (const v of this.vehicles.list.values()) {
            if (v.dead || v.state !== 'parked') continue;
            const d = Math.hypot(v.x - p.x, v.y - p.y);
            if (d < bd) { bd = d; best = v; }
          }
          if (best) {
            const c = Math.cos(best.a), s = Math.sin(best.a);
            for (const side of [1, -1]) {
              const x = best.x + s * side * (CAR.HW + 0.7), y = best.y - c * side * (CAR.HW + 0.7);
              if (KV.circleFree(this.map, x, y, KV.PLAYER_R)) { this.teleport(p, x, y); break; }
            }
          }
        }
        if (Array.isArray(msg.tp)) {
          const x = Number(msg.tp[0]), y = Number(msg.tp[1]);
          if (Number.isFinite(x) && Number.isFinite(y) && KV.circleFree(this.map, x, y, KV.PLAYER_R)) this.teleport(p, x, y);
        }
        break;
    }
  }

  onInput(p, m) {
    const a = Number(m.a);
    if (Number.isFinite(a)) p.a = a;
    p.fire = !!m.f;
    if (m.f) p.fireLatch = true;
    p.sprint = !!m.s && !p.vehicle;
    const d = Number(m.d);
    p.aimD = Number.isFinite(d) && d > 0 ? Math.min(100, d) : 0; // до какой точки целится (граната взрывается там)
    if (Array.isArray(m.v)) {
      const vw = Number(m.v[0]), vh = Number(m.v[1]);
      if (Number.isFinite(vw) && Number.isFinite(vh)) p.view = [Math.max(8, Math.min(70, vw)), Math.max(8, Math.min(70, vh))];
    }
    if (!p.alive) return;
    if (p.vehicle) { this.vehicles.onDrive(p, m.c); return; }
    if (m.tp !== p.tp) return;
    const x = Number(m.x), y = Number(m.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const dist = Math.hypot(x - p.x, y - p.y);
    if (dist < 1e-4) return;
    const speed = p.sprint && p.stamina > 0 ? KV.SPRINT_SPEED : KV.PLAYER_SPEED;
    p.budget = Math.min(p.budget + (this.time - p.lastMoveTime) * speed * 1.3, KV.SPRINT_SPEED * 1.0);
    p.lastMoveTime = this.time;
    if (dist <= p.budget + 0.08 &&
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
    for (const p of this.players.values()) if (p.isBot && !p.vehicle) this.bots.update(p, DT);
    this.vehicles.update(DT);
    this.updateStamina();
    for (const p of this.players.values()) this.updateFiring(p);
    this.updateBullets();
    this.updatePending();
    this.updatePickups();
    this.updateCrates();
    for (const p of this.players.values()) if (!p.alive && this.time >= p.respawnAt) this.spawn(p);
    if (this.recentShots.length && this.time - this.recentShots[0].t > 5) this.recentShots = this.recentShots.filter(s => this.time - s.t <= 5);
    this.flushEvents();
    if (this.tickNo % 2 === 0) this.sendSnapshots();
    if (this.tickNo % 15 === 0) this.sendPings();
    if (this.tickNo % 30 === 0 && this.sbDirty) this.sendScoreboard();
  }

  updateStamina() {
    for (const p of this.players.values()) {
      if (!p.alive || p.vehicle) continue;
      const moving = this.time - p.lastMoveTime < 0.25;
      if (p.sprint && moving && p.stamina > 0) {
        p.stamina = Math.max(0, p.stamina - STAMINA.DRAIN * DT);
        p.staminaT = this.time;
      } else if (this.time - p.staminaT > STAMINA.DELAY) {
        p.stamina = Math.min(STAMINA.MAX, p.stamina + STAMINA.REGEN * DT);
      }
    }
  }

  // ---------- стрельба ----------
  bestWeapon(p) {
    for (const w of [W.RIFLE, W.SHOTGUN, W.SNIPER, W.PISTOL, W.LAUNCHER]) if (p.ammo[w] > 0) return w;
    return W.FISTS;
  }

  updateFiring(p) {
    if (!p.alive || !(p.fire || p.fireLatch)) return;
    if (this.time < p.nextShot) return;
    // на рывке не стреляют
    if (p.sprint && !p.vehicle && this.time - p.lastMoveTime < 0.25 && p.stamina > 0) { p.fireLatch = false; return; }
    if (p.cur !== W.FISTS && !(p.ammo[p.cur] > 0)) { p.cur = this.bestWeapon(p); p.fireLatch = false; return; }
    const w = WEAPONS[p.cur];
    if (w.melee && p.vehicle) { p.fireLatch = false; return; } // из машины кулаками не бьют
    p.fireLatch = false;
    p.nextShot = this.time + 1 / w.rate;
    p.prot = 0; // стрельба снимает защиту после появления
    p.shotAt = this.time;
    if (!p.isBot && w.id !== W.FISTS) this.recentShots.push({ x: p.x, y: p.y, t: this.time });
    if (w.melee) { this.melee(p, w); return; }
    p.ammo[p.cur]--;
    const n = w.pellets || 1;
    // из машины пуля вылетает из окна, а не из центра машины
    const ox = p.vehicle ? Math.cos(p.a) * 0.6 : 0, oy = p.vehicle ? Math.sin(p.a) * 0.6 : 0;
    for (let i = 0; i < n; i++) {
      const ang = n > 1
        ? p.a + (i / (n - 1) - 0.5) * w.spread + (Math.random() - 0.5) * 0.05
        : p.a + (Math.random() - 0.5) * 2 * w.spread;
      // граната летит до прицела (не ближе 2.5 м), пули - на всю дальность
      const reach = w.grenade && p.aimD > 1 ? Math.max(2.5, Math.min(w.range, p.aimD)) : w.range;
      const b = {
        id: this.nextBullet++, owner: p.id, veh: p.vehicle || 0, w: w.id, x: p.x + ox, y: p.y + oy,
        dx: Math.cos(ang), dy: Math.sin(ang), speed: w.speed, left: reach, range: reach, dead: false
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
      if (o === p || !o.alive || o.vehicle) continue;
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
      let tBest = hitT ? hitT.t : Infinity, target = null, car = null;
      for (const p of this.players.values()) {
        if (!p.alive || p.id === b.owner || p.vehicle) continue;
        const t = geom.rayCircle(b.x, b.y, b.dx, b.dy, p.x, p.y, 0.5);
        if (t >= 0 && t <= step && t < tBest) { tBest = t; target = p; }
      }
      for (const v of this.vehicles.list.values()) {
        if (v.dead || v.id === b.veh) continue;
        if (Math.abs(v.x - b.x) > step + 3 || Math.abs(v.y - b.y) > step + 3) continue;
        const t = geom.rayOBB(b.x, b.y, b.dx, b.dy, v.x, v.y, v.a, CAR.HL, CAR.HW);
        if (t >= 0 && t <= step && t < tBest) { tBest = t; car = v; target = null; }
      }
      const w = WEAPONS[b.w];
      if (target || car || (hitT && hitT.t <= step)) {
        const back = w.grenade ? 0.08 : 0;
        const hx = b.x + b.dx * Math.max(0, tBest - back), hy = b.y + b.dy * Math.max(0, tBest - back);
        b.dead = true;
        if (w.grenade) { this.ev.be.push([b.id, r2(hx), r2(hy), 3]); this.explode(hx, hy, w.blast, b.owner, w.id); continue; }
        const travelled = b.range - b.left + tBest;
        const fall = b.w === W.SHOTGUN ? 1 - 0.5 * Math.min(1, travelled / b.range) : 1;
        if (target) {
          this.ev.be.push([b.id, r2(hx), r2(hy), 2]);
          this.damage(target, w.dmg * fall, b.owner, w.id, hx, hy);
        } else if (car) {
          this.ev.be.push([b.id, r2(hx), r2(hy), 4]);
          this.vehicles.damage(car, w.dmg * fall * 0.6, b.owner);
          const drv = car.driver ? this.players.get(car.driver) : null;
          if (drv && drv.vehicle === car.id) this.damage(drv, w.dmg * fall * 0.35, b.owner, w.id, drv.x, drv.y);
        } else {
          this.ev.be.push([b.id, r2(hx), r2(hy), 1]);
          if (hitT.k >= 0) this.damageTile(hitT.k, w.dmg * fall, b.owner, BLOCKS[m.block[hitT.k]] ? BLOCKS[m.block[hitT.k]].bullet : 1);
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
    if (t.vehicle) this.vehicles.exit(t, true);
    t.alive = false; t.hp = 0; t.deaths++;
    t.fire = false; t.fireLatch = false; t.sprint = false;
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
      if (!p.alive || p.vehicle) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d >= blast.r + 0.4) continue;
      let dmg = blast.dmg * (1 - Math.max(0, d - 0.4) / blast.r);
      if (!geom.losClear(m, x, y, p.x, p.y, false)) dmg *= 0.4;
      this.damage(p, dmg, ownerId, weaponId, p.x, p.y);
    }
    // машины: урон, водителю - половина, пустые отбрасывает
    for (const v of [...this.vehicles.list.values()]) {
      if (v.dead) continue;
      const d = KV.distToOBB(x, y, v.x, v.y, v.a, CAR.HL, CAR.HW);
      if (d >= blast.r) continue;
      const k = 1 - d / blast.r;
      this.vehicles.damage(v, blast.dmg * k * 1.6, ownerId);
      const drv = v.driver ? this.players.get(v.driver) : null;
      if (drv && drv.vehicle === v.id) this.damage(drv, blast.dmg * k * 0.45, ownerId, weaponId, drv.x, drv.y);
      if (v.state === 'parked' || v.state === 'bot') {
        const nx = v.x - x, ny = v.y - y, l = Math.hypot(nx, ny) || 1;
        v.sx += (nx / l) * 7 * k; v.sy += (ny / l) * 7 * k;
      }
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
        this.damageTile(k, blast.tile * (1 - d / r), ownerId, BLOCKS[bt].blast);
      }
    }
    // взрыв внутри дома обрушивает крышу
    const fx = Math.floor(x), fy = Math.floor(y);
    if (fx >= 0 && fy >= 0 && fx < m.w && fy < m.h) {
      const bid = m.owner[fy * m.w + fx];
      if (bid >= 0) this.collapseRoof(m.buildings[bid]);
    }
  }

  // mult - доля урона, которая доходит до клетки (у кирпича от пули - половина и т.п.)
  damageTile(k, amount, ownerId, mult = 1) {
    const m = this.map;
    const t = m.block[k];
    if (t === B.NONE || t === B.BORDER) return;
    const dmg = amount * mult;
    if (!(dmg > 0)) return;
    const info = BLOCKS[t];
    const before = m.hp[k];
    m.hp[k] -= dmg;
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
    const info = BLOCKS[t];
    m.block[k] = B.NONE; m.hp[k] = 0; m.dmg[k] = 0;
    if (info.rubble !== undefined) m.ground[k] = info.rubble;
    this.ev.tl.push([k, 0, 0, m.ground[k], t]);
    const x = k % m.w, y = Math.floor(k / m.w);
    if (info.explode) this.pending.push({ at: this.time + 0.12, x: x + 0.5, y: y + 0.5, blast: info.explode, owner: ownerId, w: -1 });
    if (t === B.CRATE) { this.crates--; this.crateLoot(x + 0.5, y + 0.5, ownerId); }
    // соседние кирпичи трескаются: стена рушится кусками
    if (info.crumble) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx <= 0 || ny <= 0 || nx >= m.w - 1 || ny >= m.h - 1) continue;
        const nk = ny * m.w + nx;
        if (m.block[nk] === t) this.damageTile(nk, info.hp * info.crumble * (0.6 + Math.random() * 0.8), ownerId);
      }
    }
    const bid = m.owner[k];
    if (t === B.BRICK && bid >= 0) {
      const b = m.buildings[bid];
      b.destroyed++;
      if (b.roof && b.destroyed >= Math.max(3, Math.ceil(b.walls * 0.18))) this.collapseRoof(b);
    }
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

  // ---------- ящики: внутри что-то лежит, со временем появляются новые ----------
  randomWeapon() {
    let total = 0;
    for (const [, wgt] of WEAPON_WEIGHTS) total += wgt;
    let r = Math.random() * total;
    for (const [w, wgt] of WEAPON_WEIGHTS) { r -= wgt; if (r <= 0) return w; }
    return W.PISTOL;
  }

  crateLoot(x, y, ownerId) {
    if (Math.random() > 0.75) return;
    const p = this.players.get(ownerId);
    const r = Math.random();
    if (r < 0.32) { const w = this.randomWeapon(); this.addPickup(PK.WEAPON, w, x, y, WEAPONS[w].pick); return; }
    if (r < 0.56) {
      // патроны - к тому оружию, которое у разбившего уже есть
      const owned = p ? [1, 2, 3, 4, 5].filter(w => p.ammo[w] >= 0) : [];
      if (owned.length) { const w = owned[Math.floor(Math.random() * owned.length)]; this.addPickup(PK.AMMO, w, x, y, WEAPONS[w].box); }
      else { const w = this.randomWeapon(); this.addPickup(PK.WEAPON, w, x, y, WEAPONS[w].pick); }
      return;
    }
    this.addPickup(r < 0.8 ? PK.HEALTH : PK.ARMOR, 0, x, y, r < 0.8 ? 40 : 50);
  }

  updateCrates() {
    if (this.time < this.nextCrateAt) return;
    this.nextCrateAt = this.time + 7 + Math.random() * 5;
    if (this.crates >= this.map.crates) return;
    const m = this.map;
    const tiles = m.pickupTiles;
    for (let tries = 0; tries < 40; tries++) {
      const k = tiles[Math.floor(Math.random() * tiles.length)];
      if (m.block[k] !== B.NONE || m.keep[k] || m.ground[k] === G.ROAD) continue;
      const x = k % m.w, y = Math.floor(k / m.w);
      let open = true;
      for (let j = -1; j <= 1 && open; j++) {
        for (let i = -1; i <= 1; i++) {
          const nk = (y + j) * m.w + x + i;
          if (m.block[nk] !== B.NONE || m.ground[nk] === G.WATER) { open = false; break; }
        }
      }
      if (!open) continue;
      let ok = true;
      for (const p of this.players.values()) if (p.alive && Math.hypot(p.x - x - 0.5, p.y - y - 0.5) < 12) { ok = false; break; }
      if (ok) for (const pk of this.pickups.values()) if (Math.hypot(pk.x - x - 0.5, pk.y - y - 0.5) < 1.5) { ok = false; break; }
      if (ok && this.vehicles.personBlocked(x + 0.5, y + 0.5, null)) ok = false;
      if (!ok) continue;
      m.block[k] = B.CRATE; m.hp[k] = BLOCKS[B.CRATE].hp; m.dmg[k] = 0;
      this.crates++;
      this.ev.tl.push([k, B.CRATE, 0, m.ground[k]]);
      return;
    }
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
    const wid = this.randomWeapon();
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
        const r = p.vehicle ? 1.7 : 0.85;
        const dx = p.x - pk.x, dy = p.y - pk.y;
        if (dx * dx + dy * dy > r * r) continue;
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
    const cars = [...this.vehicles.list.values()];
    for (const p of all) {
      if (p.isBot) continue;
      const vw = p.view[0] + 6, vh = p.view[1] + 6;
      const list = [];
      for (const o of all) {
        if (o !== p && (Math.abs(o.x - p.x) > vw || Math.abs(o.y - p.y) > vh)) continue;
        const flags = (o.alive ? 1 : 0) | (this.time < o.prot ? 2 : 0) | (this.time - o.shotAt < 0.15 ? 4 : 0) | (o.vehicle ? 8 : 0);
        list.push([o.id, r2(o.x), r2(o.y), r3(o.a), flags, o.cur, Math.max(0, Math.ceil(o.hp))]);
      }
      const c = [];
      for (const v of cars) {
        if (v.dead || Math.abs(v.x - p.x) > vw + 10 || Math.abs(v.y - p.y) > vh + 10) continue;
        c.push(this.vehicles.snap(v));
      }
      const me = [Math.max(0, Math.ceil(p.hp)), Math.ceil(p.ar), p.cur, p.ammo, p.alive ? 0 : r2(Math.max(0, p.respawnAt - this.time)),
        p.alive ? 1 : 0, Math.round(p.stamina), p.vehicle || 0];
      this.send(p, { t: 's', ts, p: list, c, me });
    }
  }

  sendPings() {
    // кто стрелял последние 2.5 с - красная точка на миникарте у всех (кулаки не считаются)
    const l = [];
    for (const p of this.players.values()) if (p.alive && this.time - p.shotAt < 2.5 && p.cur !== W.FISTS) l.push([p.id, Math.round(p.x), Math.round(p.y)]);
    // настоящие игроки видят друг друга на карте всегда
    const h = [];
    for (const p of this.players.values()) if (!p.isBot && p.alive) h.push([p.id, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
    const json = JSON.stringify({ t: 'mm', l, h });
    for (const p of this.players.values()) if (!p.isBot) this.send(p, json);
  }

  sendScoreboard() {
    this.sbDirty = false;
    const json = JSON.stringify({ t: 'sb', l: [...this.players.values()].map(p => [p.id, p.kills, p.deaths]) });
    for (const p of this.players.values()) if (!p.isBot) this.send(p, json);
  }
}

module.exports = { Room, MAX_HUMANS };
