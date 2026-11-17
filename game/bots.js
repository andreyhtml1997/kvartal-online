'use strict';
/* Боты: ищут оружие, ходят по городу (A* по клеткам), угоняют машины, стреляют - нарочно не слишком метко. */
const KV = require('../public/shared.js');
const geom = require('./geom');
const { G, W, WEAPONS, PK, CAR } = KV;

const BOT_SPEED = KV.PLAYER_SPEED * 0.85;

class AStar {
  // passable(k) - можно ли стоять на клетке; extra(k) - добавочная цена шага (например, не любить дороги)
  constructor(map, passable, extra) {
    this.map = map;
    this.passable = passable;
    this.extra = extra || null;
    const n = map.w * map.h;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.done = new Uint32Array(n);
    this.gen = 0;
  }

  // Путь из клетки (sx,sy) в (gx,gy): массив центров клеток. Если цель недостижима - путь к ближайшей найденной клетке.
  find(sx, sy, gx, gy, limit = 4000) {
    const m = this.map, Wd = m.w, Hd = m.h;
    sx = Math.max(0, Math.min(Wd - 1, sx)); sy = Math.max(0, Math.min(Hd - 1, sy));
    gx = Math.max(0, Math.min(Wd - 1, gx)); gy = Math.max(0, Math.min(Hd - 1, gy));
    const s = sy * Wd + sx, goal = gy * Wd + gx;
    this.gen++;
    if (this.gen > 4e9) { this.seen.fill(0); this.done.fill(0); this.gen = 1; }
    const gen = this.gen;
    const hk = [], hf = [];
    const swap = (a, b) => { let t = hk[a]; hk[a] = hk[b]; hk[b] = t; t = hf[a]; hf[a] = hf[b]; hf[b] = t; };
    const push = (k, f) => {
      hk.push(k); hf.push(f);
      let i = hk.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= hf[i]) break; swap(p, i); i = p; }
    };
    const pop = () => {
      const top = hk[0];
      const lk = hk.pop(), lf = hf.pop();
      if (hk.length) {
        hk[0] = lk; hf[0] = lf;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let mi = i;
          if (l < hk.length && hf[l] < hf[mi]) mi = l;
          if (r < hk.length && hf[r] < hf[mi]) mi = r;
          if (mi === i) break;
          swap(i, mi); i = mi;
        }
      }
      return top;
    };
    const h = k => {
      const x = k % Wd, y = (k / Wd) | 0;
      const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
    };
    this.g[s] = 0; this.seen[s] = gen; this.parent[s] = -1;
    push(s, h(s));
    let best = s, bestH = h(s), expanded = 0;
    while (hk.length && expanded < limit) {
      const k = pop();
      if (this.done[k] === gen) continue;
      this.done[k] = gen;
      expanded++;
      if (k === goal) { best = k; break; }
      const hh = h(k);
      if (hh < bestH) { bestH = hh; best = k; }
      const x = k % Wd, y = (k / Wd) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= Wd || ny >= Hd) continue;
          const nk = ny * Wd + nx;
          if (this.done[nk] === gen || !this.passable(nk)) continue;
          if (dx && dy && (!this.passable(y * Wd + nx) || !this.passable(ny * Wd + x))) continue; // не срезать углы
          const ng = this.g[k] + (dx && dy ? 1.414 : 1) + (this.extra ? this.extra(nk) : 0);
          if (this.seen[nk] === gen && ng >= this.g[nk]) continue;
          this.seen[nk] = gen; this.g[nk] = ng; this.parent[nk] = k;
          push(nk, ng + h(nk));
        }
      }
    }
    const path = [];
    let k = best, guard = 0;
    while (k !== -1 && k !== s && guard++ < 8000) {
      path.push([(k % Wd) + 0.5, ((k / Wd) | 0) + 0.5]);
      k = this.parent[k];
    }
    path.reverse();
    return path;
  }
}

class Bots {
  constructor(room) {
    this.room = room;
    const m = room.map;
    this.astar = new AStar(m, k => m.block[k] === 0 && m.ground[k] !== G.WATER, k => (m.ground[k] === G.ROAD ? 0.8 : 0));
    this.driveMask = null;
    this.driveMaskAt = -100;
    this.vastar = new AStar(m, k => !!(this.driveMask && this.driveMask[k]));
  }

  initAi(p) {
    return (p.ai = {
      think: Math.random() * 0.3, path: null, pi: 0, target: null, fireAt: 0,
      strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 1, stuck: 0, repath: 0,
      aimJ: 0, tvx: 0, tvy: 0, tpx: 0, tpy: 0, tseen: 0, burstEnd: 0, burstPause: 0,
      likesCars: Math.random() < 0.5, carGoal: 0, carCooldown: 0, driveT: 0, stuckCount: 0
    });
  }

  // Прицел с ошибкой: плавающая погрешность + разброс на каждый выстрел, упреждение лишь частичное
  aimAt(p, ai, t, d) {
    const w = WEAPONS[p.cur];
    const lead = w.speed ? (d / w.speed) * 0.3 : 0;
    const ax = t.x + ai.tvx * lead, ay = t.y + ai.tvy * lead;
    // разброс вдвое больше прежнего: боты заметно мажут
    ai.aimJ = (ai.aimJ + (Math.random() - 0.5) * 0.32) * 0.92;
    const err = 0.12 + Math.min(0.28, d * 0.012) + (p.tripUntil > this.room.time ? 0.25 : 0); // после гриба мажет сильнее
    p.a = Math.atan2(ay - p.y, ax - p.x) + ai.aimJ + (Math.random() - 0.5) * err * 2;
  }

  // Стреляет очередями: 0.5-1.1 с огня, потом пауза 0.9-1.8 с
  canShoot(ai, now) {
    if (now < ai.fireAt) return false;
    if (now > ai.burstEnd + ai.burstPause) {
      ai.burstEnd = now + 0.5 + Math.random() * 0.6;
      ai.burstPause = 0.9 + Math.random() * 0.9;
    }
    return now <= ai.burstEnd;
  }

  update(p, dt) {
    const room = this.room;
    const ai = p.ai || this.initAi(p);
    if (!p.alive) { p.fire = false; ai.path = null; ai.target = null; ai.carGoal = 0; return; }
    // катится после прыжка из машины на ходу
    if (room.time < p.rollUntil) {
      const [rx, ry] = KV.moveCircle(room.map, p.x, p.y, p.rollVx * dt, p.rollVy * dt, KV.PLAYER_R);
      p.x = rx; p.y = ry;
      const f = Math.exp(-2.2 * dt);
      p.rollVx *= f; p.rollVy *= f;
      p.fire = false;
      return;
    }
    ai.think -= dt;
    if (ai.think <= 0) { ai.think = 0.22 + Math.random() * 0.12; this.think(p, ai); }
    if (p.vehicle) return;

    // дошёл до машины - садится
    if (ai.carGoal) {
      const v = room.vehicles.list.get(ai.carGoal);
      if (!v || v.dead || v.state !== 'parked' || v.burn > 0) ai.carGoal = 0;
      else if (KV.distToOBB(p.x, p.y, v.x, v.y, v.a, CAR.HL, CAR.HW) < CAR.ENTER - 0.2) {
        ai.carGoal = 0;
        if (room.vehicles.enter(p, v.id)) { ai.driveT = 0; ai.stuckCount = 0; ai.vpath = null; return; }
      }
    }

    const t = ai.target;
    let mx = 0, my = 0;
    if (t && t.alive) {
      const dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy) || 1;
      const want = WEAPONS[p.cur].melee ? 0.7 : p.cur === W.SHOTGUN || p.cur === W.AUTOSHOT ? 4 : p.cur === W.FLAMER ? 3.5 : p.cur === W.SNIPER ? 14 :
        p.cur === W.LAUNCHER || p.cur === W.GRENADE || p.cur === W.MINIGUN ? 9 : p.cur === W.TRIPLE ? 8 : 7;
      const ux = dx / d, uy = dy / d;
      const fwd = d > want + 1.5 ? 1 : d < want - 1.5 ? -0.7 : 0;
      ai.strafeT -= dt;
      if (ai.strafeT <= 0) { ai.strafe = -ai.strafe; ai.strafeT = 0.8 + Math.random() * 1.4; }
      const sw = WEAPONS[p.cur].melee ? 0.25 : 0.7;
      mx = ux * fwd - uy * ai.strafe * sw;
      my = uy * fwd + ux * ai.strafe * sw;
      this.aimAt(p, ai, t, d);
      const w = WEAPONS[p.cur];
      const range = w.melee ? 1.25 : (w.range || 30) * 0.8;
      // по живому игроку - только когда бот виден у него на экране (не стреляет «из пустоты»)
      p.fire = d <= range && room.onScreenOf(t, p.x, p.y) && this.canShoot(ai, room.time);
    } else {
      p.fire = false;
      if (ai.path && ai.pi < ai.path.length) {
        const [wx, wy] = ai.path[ai.pi];
        const dx = wx - p.x, dy = wy - p.y, d = Math.hypot(dx, dy);
        if (d < 0.35) ai.pi++;
        else { mx = dx / d; my = dy / d; }
      }
      if (mx || my) {
        let diff = Math.atan2(my, mx) - p.a;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        p.a += diff * Math.min(1, dt * 10);
      }
    }

    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    let [nx, ny] = KV.moveCircle(room.map, p.x, p.y, mx * BOT_SPEED * dt, my * BOT_SPEED * dt, KV.PLAYER_R);
    // машины - препятствие
    for (const v of room.vehicles.list.values()) {
      if (v.dead || Math.abs(v.x - nx) > 3 || Math.abs(v.y - ny) > 3) continue;
      const out = KV.pushOutOBB(nx, ny, KV.PLAYER_R, v.x, v.y, v.a, CAR.HL, CAR.HW);
      if (out) [nx, ny] = KV.pushOutSafe(room.map, p.x, p.y, out, 0, 0, KV.PLAYER_R);
    }
    const moved = Math.hypot(nx - p.x, ny - p.y);
    if (len > 0.1 && moved < BOT_SPEED * dt * 0.2) {
      ai.stuck += dt;
      if (ai.stuck > 0.6) { ai.stuck = 0; ai.path = null; ai.strafe = -ai.strafe; ai.think = 0; ai.repath = 0; }
    } else ai.stuck = 0;
    p.x = nx; p.y = ny;
  }

  think(p, ai) {
    const room = this.room, now = room.time;
    let best = null, bestD = p.vehicle ? 30 : 16;
    for (const o of room.players.values()) {
      if (o === p || !o.alive) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d >= bestD) continue;
      if (!geom.losClear(room.map, p.x, p.y, o.x, o.y, true)) continue;
      best = o; bestD = d;
    }
    // житель, который напал на этого бота (прохожий отстреливается, полицейский)
    for (const n of room.npcs.list.values()) {
      if (!n.alive || n.veh || n.state !== 'fight' || n.target !== p.id) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d >= bestD || !geom.losClear(room.map, p.x, p.y, n.x, n.y, true)) continue;
      best = n; bestD = d;
    }
    if (best) {
      if (best !== ai.target) {
        ai.fireAt = now + 0.7 + Math.random() * 0.6; // реакция
        ai.tvx = 0; ai.tvy = 0;
      } else {
        const el = Math.max(0.05, now - ai.tseen);
        ai.tvx = ai.tvx * 0.5 + ((best.x - ai.tpx) / el) * 0.5;
        ai.tvy = ai.tvy * 0.5 + ((best.y - ai.tpy) / el) * 0.5;
      }
      ai.tpx = best.x; ai.tpy = best.y; ai.tseen = now;
    }
    ai.target = best;
    if (p.vehicle) return; // за рулём - своя логика в driveControl
    this.pickWeapon(p, best ? bestD : 99);
    if (best) { ai.path = null; ai.carGoal = 0; return; }

    // иногда угоняет машину
    if (!ai.carGoal && ai.likesCars && now > ai.carCooldown) {
      let car = null, cd = 22;
      for (const v of room.vehicles.list.values()) {
        if (v.dead || v.burn > 0 || v.state !== 'parked' || v.hp < CAR.HP * 0.5) continue;
        const d = Math.hypot(v.x - p.x, v.y - p.y);
        if (d < cd) { cd = d; car = v; }
      }
      if (car) ai.carGoal = car.id;
      else ai.carCooldown = now + 8;
    }
    if (ai.carGoal) {
      const v = room.vehicles.list.get(ai.carGoal);
      if (v && (!ai.path || ai.pi >= ai.path.length || now > ai.repath)) {
        ai.path = this.astar.find(Math.floor(p.x), Math.floor(p.y), Math.floor(v.x), Math.floor(v.y));
        ai.pi = 0;
        ai.repath = now + 2;
      }
      return;
    }

    if (ai.path && ai.pi < ai.path.length && now < ai.repath) return;
    let gx, gy;
    const strong = [W.RIFLE, W.SHOTGUN, W.SNIPER, W.LAUNCHER, W.FLAMER, W.SAW, W.MINIGUN, W.AUTOSHOT, W.TRIPLE, W.UZI, W.GRENADE].some(w => p.ammo[w] > 0);
    const pk = this.nearestUseful(p, !strong);
    let prey = null;
    if (strong) {
      let pd = 1e9;
      for (const o of room.players.values()) {
        if (o === p || !o.alive) continue;
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        if (d < pd) { pd = d; prey = o; }
      }
    }
    if (pk && (!prey || Math.random() < 0.5)) { gx = pk.x; gy = pk.y; }
    else if (prey && Math.random() < 0.8) { gx = prey.x; gy = prey.y; }
    else if (pk) { gx = pk.x; gy = pk.y; }
    else if (room.recentShots.length && Math.random() < 0.6) {
      const s = room.recentShots[Math.floor(Math.random() * room.recentShots.length)];
      gx = s.x; gy = s.y;
    } else {
      const tiles = room.map.spawnTiles;
      const k = tiles[Math.floor(Math.random() * tiles.length)];
      gx = (k % room.map.w) + 0.5; gy = Math.floor(k / room.map.w) + 0.5;
    }
    ai.path = this.astar.find(Math.floor(p.x), Math.floor(p.y), Math.floor(gx), Math.floor(gy));
    ai.pi = 0;
    ai.repath = now + 4;
  }

  // ---------- бот за рулём ----------
  buildDriveMask() {
    const m = this.room.map, Wd = m.w, Hd = m.h;
    const hard = new Uint8Array(Wd * Hd);
    for (let k = 0; k < Wd * Hd; k++) {
      const t = m.block[k];
      hard[k] = (t !== 0 && !KV.RAMMABLE[t]) || m.ground[k] === G.WATER ? 1 : 0;
    }
    const mask = new Uint8Array(Wd * Hd);
    for (let y = 1; y < Hd - 1; y++) {
      for (let x = 1; x < Wd - 1; x++) {
        let ok = 1;
        for (let j = -1; j <= 1 && ok; j++) for (let i = -1; i <= 1; i++) if (hard[(y + j) * Wd + x + i]) { ok = 0; break; }
        mask[y * Wd + x] = ok;
      }
    }
    this.driveMask = mask;
    this.driveMaskAt = this.room.time;
  }

  // Возвращает [газ, руль] для машины v, которой рулит бот p
  driveControl(p, v, dt) {
    const room = this.room, now = room.time;
    const ai = p.ai || this.initAi(p);
    ai.driveT += dt;
    if (!this.driveMask || now - this.driveMaskAt > 10) this.buildDriveMask();
    if (v.hp < CAR.HP * 0.3 || v.burn > 0 || ai.driveT > 75 || ai.stuckCount >= 3) {
      if (room.vehicles.exit(p, false)) {
        ai.driveT = 0; ai.stuckCount = 0; ai.carCooldown = now + 25; ai.path = null; ai.vpath = null;
        return [0, 0];
      }
    }
    // цель: ближайший противник, иначе куда-нибудь по городу
    let target = null, bd = 50;
    for (const o of room.players.values()) {
      if (o === p || !o.alive) continue;
      const d = Math.hypot(o.x - v.x, o.y - v.y);
      if (d < bd) { bd = d; target = o; }
    }
    let gx, gy;
    if (target) { gx = target.x; gy = target.y; }
    else {
      if (!ai.dest || Math.hypot(ai.dest[0] - v.x, ai.dest[1] - v.y) < 8 || now > ai.destT) {
        const tiles = room.map.pickupTiles;
        const k = tiles[Math.floor(Math.random() * tiles.length)];
        ai.dest = [(k % room.map.w) + 0.5, Math.floor(k / room.map.w) + 0.5];
        ai.destT = now + 25;
      }
      [gx, gy] = ai.dest;
    }
    if (!ai.vpath || now > ai.vrepath || ai.vpi >= ai.vpath.length) {
      ai.vpath = this.vastar.find(Math.floor(v.x), Math.floor(v.y), Math.floor(gx), Math.floor(gy), 3000);
      ai.vpi = 0;
      ai.vrepath = now + 1.2;
    }
    let tx = gx, ty = gy;
    if (ai.vpath && ai.vpath.length) {
      while (ai.vpi < ai.vpath.length - 1 && Math.hypot(ai.vpath[ai.vpi][0] - v.x, ai.vpath[ai.vpi][1] - v.y) < 4.5) ai.vpi++;
      [tx, ty] = ai.vpath[Math.min(ai.vpi, ai.vpath.length - 1)];
    }
    const los = target && bd < 16 && geom.losClear(room.map, v.x, v.y, target.x, target.y, true);
    if (los && !target.vehicle) { tx = target.x; ty = target.y; } // видит пешего - давит
    if (ai.revT > 0) { ai.revT -= dt; p.fire = false; return [-1, -ai.revSteer]; }
    const want = Math.atan2(ty - v.y, tx - v.x);
    const diff = Math.atan2(Math.sin(want - v.a), Math.cos(want - v.a));
    const thr = Math.abs(diff) < 1.2 ? 1 : 0.45;
    const steer = Math.max(-1, Math.min(1, diff * 2.2));
    if (Math.abs(v.v) < 0.8) {
      ai.vstuck = (ai.vstuck || 0) + dt;
      if (ai.vstuck > 1.3) { ai.vstuck = 0; ai.revT = 0.9; ai.revSteer = steer >= 0 ? 1 : -1; ai.stuckCount++; ai.vrepath = 0; }
    } else {
      ai.vstuck = 0;
      if (Math.abs(v.v) > 4) ai.stuckCount = 0;
    }
    // стрельба из окна
    if (p.cur === W.FISTS) this.pickWeapon(p, bd);
    p.fire = false;
    if (los && bd < 14 && !WEAPONS[p.cur].melee && p.ammo[p.cur] > 0 && room.onScreenOf(target, v.x, v.y)) {
      this.aimAt(p, ai, target, bd);
      p.fire = this.canShoot(ai, now);
    }
    return [thr, steer];
  }

  pickWeapon(p, d) {
    const has = w => w === W.FISTS || p.ammo[w] > 0;
    let order;
    if (p.vehicle) order = [W.MINIGUN, W.RIFLE, W.UZI, W.AUTOSHOT, W.TRIPLE, W.SHOTGUN, W.PISTOL, W.SNIPER, W.FLAMER, W.FISTS]; // из окна - только стреляющее
    else if (d < 2.2) order = [W.SAW, W.AUTOSHOT, W.SHOTGUN, W.FLAMER, W.MINIGUN, W.UZI, W.RIFLE, W.TRIPLE, W.PISTOL, W.SNIPER, W.FISTS];
    else if (d < 5.5) order = [W.FLAMER, W.AUTOSHOT, W.MINIGUN, W.SHOTGUN, W.TRIPLE, W.UZI, W.RIFLE, W.PISTOL, W.SAW, W.SNIPER, W.FISTS];
    else if (d > 11 && d < 99) order = [W.SNIPER, W.MINIGUN, W.RIFLE, W.LAUNCHER, W.TRIPLE, W.GRENADE, W.PISTOL, W.UZI, W.SHOTGUN, W.FLAMER, W.SAW, W.FISTS];
    else order = [W.LAUNCHER, W.MINIGUN, W.RIFLE, W.TRIPLE, W.GRENADE, W.AUTOSHOT, W.UZI, W.SHOTGUN, W.PISTOL, W.SNIPER, W.FLAMER, W.SAW, W.FISTS];
    for (const w of order) if (has(w)) { p.cur = w; return; }
  }

  nearestUseful(p, weak) {
    let best = null, bd = weak ? 70 : 28;
    for (const pk of this.room.pickups.values()) {
      let useful;
      if (pk.kind === PK.WEAPON) useful = !WEAPONS[pk.w].noAmmo && !(p.ammo[pk.w] >= WEAPONS[pk.w].max); // щит ботам не нужен
      else if (pk.kind === PK.AMMO) useful = p.ammo[pk.w] >= 0 && p.ammo[pk.w] < WEAPONS[pk.w].max;
      else if (pk.kind === PK.HEALTH) useful = p.hp < 70;
      else if (pk.kind === PK.SHROOM) useful = false;
      else useful = p.ar < 50;
      if (!useful) continue;
      const d = Math.hypot(pk.x - p.x, pk.y - p.y);
      if (d < bd) { bd = d; best = pk; }
    }
    return best;
  }
}

module.exports = { Bots, AStar };
