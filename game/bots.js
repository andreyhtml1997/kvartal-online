'use strict';
/* Боты: ищут оружие, ходят по городу (A* по клеткам), замечают противника и стреляют. */
const KV = require('../public/shared.js');
const geom = require('./geom');
const { G, W, WEAPONS, PK } = KV;

const BOT_SPEED = KV.PLAYER_SPEED * 0.85;

class AStar {
  constructor(map) {
    this.map = map;
    const n = map.w * map.h;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.done = new Uint32Array(n);
    this.gen = 0;
  }

  walk(k) { return this.map.block[k] === 0 && this.map.ground[k] !== G.WATER; }

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
          if (this.done[nk] === gen || !this.walk(nk)) continue;
          if (dx && dy && (!this.walk(y * Wd + nx) || !this.walk(ny * Wd + x))) continue; // не срезать углы
          const ng = this.g[k] + (dx && dy ? 1.414 : 1);
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
    this.astar = new AStar(room.map);
  }

  update(p, dt) {
    const room = this.room;
    const ai = p.ai || (p.ai = {
      think: Math.random() * 0.3, path: null, pi: 0, target: null, fireAt: 0,
      strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 1, stuck: 0, repath: 0,
      aimJ: 0, tvx: 0, tvy: 0, tpx: 0, tpy: 0, tseen: 0
    });
    if (!p.alive) { p.fire = false; ai.path = null; ai.target = null; return; }
    ai.think -= dt;
    if (ai.think <= 0) { ai.think = 0.22 + Math.random() * 0.12; this.think(p, ai); }

    const t = ai.target;
    let mx = 0, my = 0;
    if (t && t.alive) {
      const dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy) || 1;
      const want = WEAPONS[p.cur].melee ? 0.7 : p.cur === W.SHOTGUN ? 4 : p.cur === W.SNIPER ? 14 : p.cur === W.LAUNCHER ? 9 : 7;
      const ux = dx / d, uy = dy / d;
      const fwd = d > want + 1.5 ? 1 : d < want - 1.5 ? -0.7 : 0;
      ai.strafeT -= dt;
      if (ai.strafeT <= 0) { ai.strafe = -ai.strafe; ai.strafeT = 0.8 + Math.random() * 1.4; }
      const sw = WEAPONS[p.cur].melee ? 0.25 : 0.7;
      mx = ux * fwd - uy * ai.strafe * sw;
      my = uy * fwd + ux * ai.strafe * sw;
      // прицел с упреждением и человеческой ошибкой
      const w = WEAPONS[p.cur];
      const lead = w.speed ? d / w.speed : 0;
      const ax = t.x + ai.tvx * lead, ay = t.y + ai.tvy * lead;
      ai.aimJ = (ai.aimJ + (Math.random() - 0.5) * 0.09) * 0.9;
      p.a = Math.atan2(ay - p.y, ax - p.x) + ai.aimJ + (Math.random() - 0.5) * 0.05;
      const range = w.melee ? 1.25 : (w.range || 30) * 0.85;
      p.fire = room.time >= ai.fireAt && d <= range;
    } else {
      p.fire = false;
      if (ai.path && ai.pi < ai.path.length) {
        const [wx, wy] = ai.path[ai.pi];
        const dx = wx - p.x, dy = wy - p.y, d = Math.hypot(dx, dy);
        if (d < 0.35) ai.pi++;
        else { mx = dx / d; my = dy / d; }
      }
      if (mx || my) {
        const want = Math.atan2(my, mx);
        let diff = want - p.a;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        p.a += diff * Math.min(1, dt * 10);
      }
    }

    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const [nx, ny] = KV.moveCircle(room.map, p.x, p.y, mx * BOT_SPEED * dt, my * BOT_SPEED * dt, KV.PLAYER_R);
    const moved = Math.hypot(nx - p.x, ny - p.y);
    if (len > 0.1 && moved < BOT_SPEED * dt * 0.2) {
      ai.stuck += dt;
      if (ai.stuck > 0.6) { ai.stuck = 0; ai.path = null; ai.strafe = -ai.strafe; ai.think = 0; ai.repath = 0; }
    } else ai.stuck = 0;
    p.x = nx; p.y = ny;
  }

  think(p, ai) {
    const room = this.room, now = room.time;
    let best = null, bestD = 20;
    for (const o of room.players.values()) {
      if (o === p || !o.alive) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d >= bestD) continue;
      if (!geom.losClear(room.map, p.x, p.y, o.x, o.y, true)) continue;
      best = o; bestD = d;
    }
    if (best) {
      if (best !== ai.target) {
        ai.fireAt = now + 0.35 + Math.random() * 0.4; // реакция
        ai.tvx = 0; ai.tvy = 0;
      } else {
        const el = Math.max(0.05, now - ai.tseen);
        ai.tvx = ai.tvx * 0.5 + ((best.x - ai.tpx) / el) * 0.5;
        ai.tvy = ai.tvy * 0.5 + ((best.y - ai.tpy) / el) * 0.5;
      }
      ai.tpx = best.x; ai.tpy = best.y; ai.tseen = now;
    }
    ai.target = best;
    this.pickWeapon(p, best ? bestD : 99);
    if (best) { ai.path = null; return; }

    if (ai.path && ai.pi < ai.path.length && now < ai.repath) return;
    let gx, gy;
    const strong = p.ammo[W.RIFLE] > 0 || p.ammo[W.SHOTGUN] > 0 || p.ammo[W.SNIPER] > 0 || p.ammo[W.LAUNCHER] > 0;
    const pk = this.nearestUseful(p, !strong);
    let prey = null;
    if (strong) {
      // с оружием бот идёт охотиться: к ближайшему живому противнику
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

  pickWeapon(p, d) {
    const has = w => w === W.FISTS || p.ammo[w] > 0;
    let order;
    if (d < 3.5) order = [W.SHOTGUN, W.RIFLE, W.PISTOL, W.SNIPER, W.FISTS];
    else if (d > 11 && d < 99) order = [W.SNIPER, W.RIFLE, W.LAUNCHER, W.PISTOL, W.SHOTGUN, W.FISTS];
    else order = [W.LAUNCHER, W.RIFLE, W.SHOTGUN, W.PISTOL, W.SNIPER, W.FISTS];
    for (const w of order) if (has(w)) { p.cur = w; return; }
  }

  nearestUseful(p, weak) {
    let best = null, bd = weak ? 70 : 28;
    for (const pk of this.room.pickups.values()) {
      let useful;
      if (pk.kind === PK.WEAPON) useful = !(p.ammo[pk.w] >= WEAPONS[pk.w].max);
      else if (pk.kind === PK.AMMO) useful = p.ammo[pk.w] >= 0 && p.ammo[pk.w] < WEAPONS[pk.w].max;
      else if (pk.kind === PK.HEALTH) useful = p.hp < 70;
      else useful = p.ar < 50;
      if (!useful) continue;
      const d = Math.hypot(pk.x - p.x, pk.y - p.y);
      if (d < bd) { bd = d; best = pk; }
    }
    return best;
  }
}

module.exports = { Bots, AStar };
