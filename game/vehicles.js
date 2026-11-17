'use strict';
/*
 * Машины. Состояния:
 *   traffic - едет водитель-NPC: по своей полосе (правостороннее движение), поворачивает на перекрёстках,
 *             пропускает другие машины на перекрёстке, тормозит и сигналит, если заранее видит человека;
 *   human   - угнал игрок: положение присылает его браузер, сервер проверяет скорость и стены;
 *   bot     - угнал бот: физику и руль считает сервер;
 *   parked  - стоит без водителя (на парковке или брошена), её можно сдвинуть тараном.
 * Любую машину можно угнать. Удары по людям - урон по скорости. Разбитая машина горит и взрывается.
 */
const KV = require('../public/shared.js');
const { CAR, CAR_BLAST } = KV;

const TRAFFIC_TARGET = 10;
const TRAFFIC_SPEED = 9.5;
const PARKED_RESPAWN = 120;   // с - через сколько на месте взорванной машины с парковки появится новая
const MAX_VEHICLES = 44;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const DIR_ANGLE = [0, Math.PI / 2, Math.PI, -Math.PI / 2]; // восток, юг, запад, север
const ikey = (i, j) => i * 100 + j + 1;

class Vehicles {
  constructor(room) {
    this.room = room;
    this.map = room.map;
    this.list = new Map();
    this.nextId = 1;
    this.res = new Map();           // перекрёсток -> { id машины, время }
    this.vr = room.map.roads.x;     // вертикальные дороги [начало, ширина]
    this.hr = room.map.roads.y;     // горизонтальные
    this.nextTrafficAt = 0;
    this.respawnQueue = [];
    for (const sp of room.map.carSpawns) this.create(sp.x, sp.y, sp.a, sp.color, 'parked', sp);
    for (let i = 0; i < TRAFFIC_TARGET; i++) this.spawnTraffic(true);
  }

  create(x, y, a, color, state, spawn) {
    const v = {
      id: this.nextId++, x, y, a, v: 0, sx: 0, sy: 0, color, hp: CAR.HP, state, driver: 0, lastDriver: 0, ai: null,
      burn: 0, lastAttacker: 0, hitCd: new Map(), rams: new Map(), brake: false, hornAt: -10, seenT: 0, stuckT: 0,
      tp: 0, budget: 0, lastMoveTime: this.room.time, crashAt: -10, spawn: spawn || null, dead: false, born: this.room.time
    };
    this.list.set(v.id, v);
    return v;
  }

  // ---------- полосы и перекрёстки ----------
  entry(i, j, d) {
    const vx = this.vr[i][0], hy = this.hr[j][0];
    if (d === 0) return [vx, hy + 3];
    if (d === 1) return [vx + 1, hy];
    if (d === 2) return [vx + 4, hy + 1];
    return [vx + 3, hy + 4];
  }

  exitPt(i, j, d) {
    const vx = this.vr[i][0], hy = this.hr[j][0];
    if (d === 0) return [vx + 4, hy + 3];
    if (d === 1) return [vx + 1, hy + 4];
    if (d === 2) return [vx, hy + 1];
    return [vx + 3, hy];
  }

  nextInter(i, j, d) {
    const ni = i + [1, 0, -1, 0][d], nj = j + [0, 1, 0, -1][d];
    if (ni < 0 || nj < 0 || ni >= this.vr.length || nj >= this.hr.length) return null;
    return [ni, nj];
  }

  turn(i, j, din, dout) {
    const p0 = this.entry(i, j, din), p2 = this.exitPt(i, j, dout);
    const key = ikey(i, j);
    if (din === dout) return [{ x: p2[0], y: p2[1], key, turn: false, approach: 0 }];
    const vert = din === 1 || din === 3;
    const c = vert ? [p0[0], p2[1]] : [p2[0], p0[1]];
    const out = [];
    for (const t of [0.25, 0.5, 0.75, 1]) {
      const u = 1 - t;
      out.push({ x: u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], y: u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1], key, turn: true, approach: 0 });
    }
    return out;
  }

  // Достраивает маршрут через следующий перекрёсток: прямо чаще, чем налево или направо
  plan(v) {
    const r = v.ai;
    const opts = [];
    for (const [d, w] of [[r.dir, 3], [(r.dir + 1) % 4, 1], [(r.dir + 3) % 4, 1]]) if (this.nextInter(r.i, r.j, d)) opts.push([d, w]);
    let dout = opts.length ? opts[0][0] : r.dir;
    if (opts.length > 1) {
      let tot = 0;
      for (const o of opts) tot += o[1];
      let x = Math.random() * tot;
      for (const [d, w] of opts) { x -= w; if (x <= 0) { dout = d; break; } }
    }
    for (const w of this.turn(r.i, r.j, r.dir, dout)) r.wps.push(w);
    const nx = this.nextInter(r.i, r.j, dout);
    const e = this.entry(nx[0], nx[1], dout);
    r.wps.push({ x: e[0], y: e[1], key: 0, turn: false, approach: ikey(nx[0], nx[1]) });
    r.i = nx[0]; r.j = nx[1]; r.dir = dout;
  }

  spawnTraffic(initial) {
    const room = this.room;
    if (this.list.size >= MAX_VEHICLES) return null;
    for (let tries = 0; tries < 40; tries++) {
      const d = Math.floor(Math.random() * 4);
      const i = Math.floor(Math.random() * this.vr.length), j = Math.floor(Math.random() * this.hr.length);
      const nx = this.nextInter(i, j, d);
      if (!nx) continue;
      const a = this.exitPt(i, j, d), b = this.entry(nx[0], nx[1], d);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 8) continue;
      const t = 0.2 + Math.random() * 0.6;
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      let ok = true;
      for (const o of this.list.values()) if (!o.dead && Math.hypot(o.x - x, o.y - y) < 9) { ok = false; break; }
      if (ok && !initial) for (const p of room.players.values()) if (p.alive && !p.isBot && Math.hypot(p.x - x, p.y - y) < 28) { ok = false; break; }
      if (!ok) continue;
      const v = this.create(x, y, DIR_ANGLE[d], Math.floor(Math.random() * 8), 'traffic', null);
      v.v = TRAFFIC_SPEED * 0.6;
      v.ai = { i: nx[0], j: nx[1], dir: d, wps: [{ x: b[0], y: b[1], key: 0, turn: false, approach: ikey(nx[0], nx[1]) }], wi: 0, held: 0 };
      this.plan(v);
      return v;
    }
    return null;
  }

  releaseAll(v) {
    for (const [k, h] of this.res) if (h.id === v.id) this.res.delete(k);
    if (v.ai) v.ai.held = 0;
  }

  seenByHumans(x, y, r) {
    for (const p of this.room.players.values()) if (!p.isBot && Math.hypot(p.x - x, p.y - y) < r) return true;
    return false;
  }

  updateTraffic(v, dt) {
    const room = this.room, r = v.ai, now = room.time;
    while (r.wps.length - r.wi < 3) this.plan(v);
    if (r.wi > 24) { r.wps.splice(0, r.wi); r.wi = 0; }
    const c = Math.cos(v.a), s = Math.sin(v.a);
    let target = TRAFFIC_SPEED;
    const wp = r.wps[r.wi];
    const dWp = Math.hypot(wp.x - v.x, wp.y - v.y);
    if (wp.approach) {
      const nw = r.wps[r.wi + 1];
      if (nw && nw.turn) target = Math.min(target, 4 + dWp * 0.7);
      if (dWp < 5 && r.held !== wp.approach) {
        const h = this.res.get(wp.approach);
        if (!h || h.id === v.id || !this.list.has(h.id) || now - h.t > 6) { this.res.set(wp.approach, { id: v.id, t: now }); r.held = wp.approach; }
        else target = Math.min(target, Math.max(0, (dWp - 1.2) * 1.5));
      }
    } else if (wp.turn) target = Math.min(target, 4.5);

    // машина впереди
    let blockedByCar = false;
    for (const o of this.list.values()) {
      if (o === v || o.dead) continue;
      const dx = o.x - v.x, dy = o.y - v.y;
      if (dx * dx + dy * dy > 225) continue;
      const f = dx * c + dy * s;
      if (f <= 0) continue;
      if (Math.abs(-dx * s + dy * c) > 1.9) continue;
      const gap = f - 4.4;
      const t2 = gap <= 0.3 ? 0 : Math.max(0, gap * 1.4 + (o.state === 'traffic' ? Math.max(0, o.v) * 0.6 : 0));
      if (t2 < target) { target = t2; blockedByCar = o.state !== 'traffic'; }
    }
    // человек на дороге впереди: водитель замечает не сразу, поэтому выскочившего прямо под колёса собьёт
    let person = false;
    for (const p of room.players.values()) {
      if (!p.alive || p.vehicle) continue;
      const dx = p.x - v.x, dy = p.y - v.y;
      const f = dx * c + dy * s;
      if (f < 1.6 || f > 12) continue;
      if (Math.abs(-dx * s + dy * c) > 1.6) continue;
      person = true;
      break;
    }
    if (person) {
      v.seenT += dt;
      if (v.seenT > 0.35) {
        target = 0;
        if (now - v.hornAt > 2.2) { v.hornAt = now; room.ev.hn.push(v.id); }
      }
    } else v.seenT = 0;

    const prev = v.v;
    if (v.v < target) v.v = Math.min(target, v.v + 4.5 * dt); else v.v = Math.max(target, v.v - 13 * dt);
    v.brake = v.v < prev - 1e-3 || (target < 0.3 && v.v < 0.3);
    if (v.v < 0.3 && target < 0.3) v.stuckT += dt; else v.stuckT = 0;
    if (blockedByCar && v.stuckT > 1.5 && now - v.hornAt > 2.5) { v.hornAt = now; room.ev.hn.push(v.id); }
    if (v.stuckT > 8 && !this.seenByHumans(v.x, v.y, 30)) { this.remove(v); return; }

    let move = v.v * dt, hx = 0, hy = 0;
    for (let guard = 0; move > 1e-6 && guard < 20; guard++) {
      const w = r.wps[r.wi];
      const dx = w.x - v.x, dy = w.y - v.y, d = Math.hypot(dx, dy);
      if (d > 1e-6) { hx = dx / d; hy = dy / d; }
      if (d <= move) {
        v.x = w.x; v.y = w.y; move -= d;
        this.passed(v, r.wi);
        r.wi++;
        while (r.wps.length - r.wi < 3) this.plan(v);
      } else { v.x += hx * move; v.y += hy * move; move = 0; }
    }
    if (hx || hy) v.a += angDiff(Math.atan2(hy, hx), v.a) * Math.min(1, dt * 12);
  }

  passed(v, idx) {
    const r = v.ai, w = r.wps[idx];
    if (w.key && r.held === w.key) {
      const nw = r.wps[idx + 1];
      if (!nw || nw.key !== w.key) {
        const h = this.res.get(w.key);
        if (h && h.id === v.id) this.res.delete(w.key);
        r.held = 0;
      }
    }
  }

  remove(v) {
    this.releaseAll(v);
    v.dead = true;
    this.list.delete(v.id);
  }

  // ---------- физика машин без игрока за рулём ----------
  physics(v, thr, steer, dt, driverId) {
    const res = KV.stepVehicle(this.map, v, thr, steer, dt, null);
    const credit = driverId || v.lastDriver;
    for (const k of res.rammed) this.room.destroyTile(k, credit);
    if (res.impact > 6) this.damage(v, (res.impact - 5) * 6, v.lastAttacker || credit);
    if (res.impact > 3 && this.room.time - v.crashAt > 0.3) { v.crashAt = this.room.time; this.room.ev.cr.push([r2(v.x), r2(v.y), Math.round(res.impact)]); }
    for (const o of this.list.values()) {
      if (o === v || o.dead) continue;
      const mtv = KV.obbObbMTV(v.x, v.y, v.a, o.x, o.y, o.a, CAR.HL, CAR.HW);
      if (!mtv) continue;
      v.x += mtv[0]; v.y += mtv[1];
      const back = KV.resolveCar(this.map, v);
      for (const k of back.rammed) this.room.destroyTile(k, credit);
      const ml = Math.hypot(mtv[0], mtv[1]) || 1, nx = mtv[0] / ml, ny = mtv[1] / ml;
      const c = Math.cos(v.a), s = Math.sin(v.a);
      const into = -((c * v.v + v.sx) * nx + (s * v.v + v.sy) * ny);
      if (into > 0) {
        v.v *= 0.3;
        const sd = v.sx * nx + v.sy * ny;
        if (sd < 0) { v.sx -= nx * sd; v.sy -= ny * sd; }
        if (into > 3) this.ram(v, o, into, -nx, -ny, credit);
      }
    }
  }

  // Удар машины a в машину b; (nx, ny) - направление от a к b
  ram(a, b, impact, nx, ny, attackerId) {
    const now = this.room.time;
    if (now - (a.rams.get(b.id) || -10) < 0.4) return;
    a.rams.set(b.id, now);
    const dmg = Math.max(0, impact - 3) * 5;
    this.damage(a, dmg * 0.6, attackerId);
    this.damage(b, dmg, attackerId);
    if (b.state === 'parked' || b.state === 'bot') { b.sx += nx * impact * 0.7; b.sy += ny * impact * 0.7; }
    else if (b.state === 'human') {
      const d = this.room.players.get(b.driver);
      if (d) this.room.send(d, { t: 'vk', x: r2(nx * impact * 0.6), y: r2(ny * impact * 0.6) });
    }
    this.room.ev.cr.push([r2((a.x + b.x) / 2), r2((a.y + b.y) / 2), Math.round(impact)]);
  }

  damage(v, amount, attackerId) {
    if (v.dead || !(amount > 0)) return;
    v.hp -= amount;
    if (attackerId) v.lastAttacker = attackerId;
    if (v.hp <= 0 && v.burn <= 0) {
      v.hp = 0;
      v.burn = CAR.FIRE;
      if (v.state === 'traffic') this.npcFlee(v);
      this.room.ev.vf.push(v.id);
    }
  }

  // Водитель-NPC выскакивает и убегает (рисует браузер)
  npcFlee(v) {
    this.releaseAll(v);
    const c = Math.cos(v.a), s = Math.sin(v.a);
    const x = v.x + s * (CAR.HW + 0.5), y = v.y - c * (CAR.HW + 0.5);
    this.room.ev.fl.push([r2(x), r2(y), r3(Math.atan2(-c, s) + (Math.random() - 0.5) * 0.8)]);
    v.state = 'parked';
    v.ai = null;
    v.brake = false;
  }

  explodeVehicle(v) {
    if (v.dead) return;
    const room = this.room;
    const d = v.driver ? room.players.get(v.driver) : null;
    if (d && d.vehicle === v.id) {
      this.exit(d, true);
      room.damage(d, 250, v.lastAttacker, -1, d.x, d.y);
    }
    this.remove(v);
    room.ev.vx.push(v.id);
    room.explode(v.x, v.y, CAR_BLAST, v.lastAttacker, -1);
    if (v.spawn) this.respawnQueue.push({ at: room.time + PARKED_RESPAWN, sp: v.spawn });
  }

  // ---------- удары по людям ----------
  checkHits(v) {
    const room = this.room;
    const c = Math.cos(v.a), s = Math.sin(v.a);
    const vx = c * v.v + v.sx, vy = s * v.v + v.sy;
    const speed = Math.hypot(vx, vy);
    for (const p of room.players.values()) {
      if (!p.alive || p.vehicle) continue;
      if (Math.abs(p.x - v.x) > 3.2 || Math.abs(p.y - v.y) > 3.2) continue;
      const out = KV.pushOutOBB(p.x, p.y, KV.PLAYER_R, v.x, v.y, v.a, CAR.HL, CAR.HW);
      if (!out) continue;
      if (speed > 2.5) {
        if (room.time - (v.hitCd.get(p.id) || -10) < 0.7) continue;
        v.hitCd.set(p.id, room.time);
        const dmg = Math.min(90, Math.max(12, speed * 6));
        let kx = out[0] - v.x, ky = out[1] - v.y;
        const kl = Math.hypot(kx, ky) || 1;
        kx = (kx / kl) * 0.6 + (vx / speed) * 0.6;
        ky = (ky / kl) * 0.6 + (vy / speed) * 0.6;
        const k2 = Math.hypot(kx, ky) || 1;
        kx /= k2; ky /= k2;
        const imp = 3 + speed * 0.7;
        room.ev.ck.push([v.id, p.id, r2(p.x), r2(p.y)]);
        if (p.isBot) {
          const q = KV.moveCircle(this.map, out[0], out[1], kx * imp * 0.25, ky * imp * 0.25, KV.PLAYER_R);
          p.x = q[0]; p.y = q[1];
        } else {
          p.budget += imp * 0.6 + 2;
          room.send(p, { t: 'kb', x: r2(kx * imp), y: r2(ky * imp) });
        }
        room.damage(p, dmg, v.driver || 0, -2, p.x, p.y);
        if (v.state !== 'human') v.v *= 0.8;
      } else if (p.isBot) {
        const q = KV.collideCircle(this.map, out[0], out[1], KV.PLAYER_R);
        p.x = q[0]; p.y = q[1];
      }
    }
  }

  // ---------- посадка и выход ----------
  nearestEnterable(p) {
    let best = null, bd = CAR.ENTER;
    for (const v of this.list.values()) {
      if (v.dead || v.burn > 0 || v.state === 'human') continue;
      const d = KV.distToOBB(p.x, p.y, v.x, v.y, v.a, CAR.HL, CAR.HW);
      if (d <= bd) { bd = d; best = v; }
    }
    return best;
  }

  enter(p, vid) {
    const room = this.room;
    const v = vid ? this.list.get(vid) : this.nearestEnterable(p);
    if (!v || v.dead || v.burn > 0 || !p.alive || p.vehicle || v.state === 'human') return false;
    if (KV.distToOBB(p.x, p.y, v.x, v.y, v.a, CAR.HL, CAR.HW) > CAR.ENTER + 0.3) return false;
    if (v.state === 'bot') {
      const b = room.players.get(v.driver);
      if (b && b.vehicle === v.id) this.exit(b, true);
    }
    if (v.state === 'traffic') this.npcFlee(v);
    this.releaseAll(v);
    v.state = p.isBot ? 'bot' : 'human';
    v.driver = p.id; v.lastDriver = p.id; v.ai = null; v.brake = false;
    v.tp++; v.budget = 0; v.lastMoveTime = room.time;
    p.vehicle = v.id; p.fire = false; p.fireLatch = false; p.sprint = false;
    p.x = v.x; p.y = v.y;
    if (!p.isBot) room.send(p, { t: 'car', id: v.id, x: r2(v.x), y: r2(v.y), a: r3(v.a), v: r2(v.v), tp: v.tp });
    room.ev.en.push([v.id, p.id]);
    return true;
  }

  personBlocked(x, y, self) {
    for (const o of this.list.values()) {
      if (o !== self && !o.dead && KV.pushOutOBB(x, y, KV.PLAYER_R, o.x, o.y, o.a, CAR.HL, CAR.HW)) return true;
    }
    return false;
  }

  exit(p, forced) {
    const room = this.room;
    const v = this.list.get(p.vehicle);
    if (!v) { p.vehicle = 0; return true; }
    const c = Math.cos(v.a), s = Math.sin(v.a);
    // левая дверь, правая, сзади, спереди
    const cands = [[s, -c, CAR.HW + 0.6], [-s, c, CAR.HW + 0.6], [-c, -s, CAR.HL + 0.6], [c, s, CAR.HL + 0.6]];
    let spot = null;
    for (const [dx, dy, dist] of cands) {
      const x = v.x + dx * dist, y = v.y + dy * dist;
      if (KV.circleFree(this.map, x, y, KV.PLAYER_R) && !this.personBlocked(x, y, v)) { spot = [x, y]; break; }
    }
    if (!spot) {
      if (!forced) return false;
      spot = KV.collideCircle(this.map, v.x + s * (CAR.HW + 0.6), v.y - c * (CAR.HW + 0.6), KV.PLAYER_R);
    }
    p.vehicle = 0;
    v.driver = 0; v.state = 'parked'; v.lastDriver = p.id; v.tp++; v.brake = false;
    room.ev.ex.push([v.id, p.id]);
    room.teleport(p, spot[0], spot[1]);
    return true;
  }

  // ---------- машина игрока: положение присылает браузер ----------
  onDrive(p, c) {
    const room = this.room;
    const v = this.list.get(p.vehicle);
    if (!v || v.state !== 'human' || v.driver !== p.id || !Array.isArray(c)) return;
    if (c[4] !== v.tp) return;
    const x = Number(c[0]), y = Number(c[1]), a = Number(c[2]), spd = Number(c[3]);
    if (![x, y, a, spd].every(Number.isFinite)) return;
    const dist = Math.hypot(x - v.x, y - v.y);
    v.budget = Math.min(v.budget + (room.time - v.lastMoveTime) * CAR.MAX * 1.35, CAR.MAX * 1.2);
    v.lastMoveTime = room.time;
    if (dist > v.budget + 0.4 || KV.carHitsHard(this.map, x, y, a, 0.15)) {
      v.tp++;
      room.send(p, { t: 'ctp', x: r2(v.x), y: r2(v.y), a: r3(v.a), tp: v.tp });
      return;
    }
    v.budget -= dist;
    v.x = x; v.y = y; v.a = a;
    v.v = Math.max(-CAR.REV, Math.min(CAR.MAX * 1.05, spd));
    p.x = x; p.y = y;
    if (Math.abs(v.v) > KV.RAM_SPEED * 0.75) for (const k of KV.carOverlapTiles(this.map, x, y, a, 0.05, [])) room.destroyTile(k, p.id);
  }

  onRam(p, m) {
    const v = this.list.get(p.vehicle), o = this.list.get(m.id | 0);
    if (!v || !o || o === v || o.dead || v.state !== 'human' || v.driver !== p.id) return;
    const s = Math.min(Number(m.s) || 0, CAR.MAX * 1.3);
    if (!(s > 3) || Math.hypot(o.x - v.x, o.y - v.y) > 6.5) return;
    const nx = o.x - v.x, ny = o.y - v.y, l = Math.hypot(nx, ny) || 1;
    this.ram(v, o, s, nx / l, ny / l, p.id);
  }

  onCrash(p, m) {
    const v = this.list.get(p.vehicle);
    if (!v || v.state !== 'human' || v.driver !== p.id) return;
    const s = Math.min(Number(m.s) || 0, 25);
    if (!(s > 3) || this.room.time - v.crashAt < 0.3) return;
    v.crashAt = this.room.time;
    if (s > 6) this.damage(v, (s - 5) * 6, v.lastAttacker || p.id);
    this.room.ev.cr.push([r2(v.x), r2(v.y), Math.round(s)]);
  }

  // ---------- такт ----------
  update(dt) {
    const room = this.room;
    for (const v of [...this.list.values()]) {
      if (v.dead) continue;
      if (v.state === 'traffic') {
        this.updateTraffic(v, dt);
        if (v.dead) continue;
      } else if (v.state === 'bot') {
        const d = room.players.get(v.driver);
        if (!d || !d.alive || d.vehicle !== v.id) { v.state = 'parked'; v.driver = 0; }
        else {
          const ctl = room.bots.driveControl(d, v, dt);
          if (d.vehicle === v.id) { this.physics(v, ctl[0], ctl[1], dt, d.id); d.x = v.x; d.y = v.y; }
        }
      } else if (v.state === 'parked') {
        if (Math.abs(v.v) > 0.02 || Math.abs(v.sx) > 0.02 || Math.abs(v.sy) > 0.02) this.physics(v, 0, 0, dt, 0);
        v.brake = false;
      } else if (v.state === 'human') {
        const d = room.players.get(v.driver);
        if (!d || !d.alive || d.vehicle !== v.id) { v.state = 'parked'; v.driver = 0; v.v = 0; }
      }
      if (v.burn > 0) {
        v.burn -= dt;
        if (v.burn <= 0) { this.explodeVehicle(v); continue; }
      }
      this.checkHits(v);
    }
    let traffic = 0;
    for (const v of this.list.values()) if (v.state === 'traffic') traffic++;
    if (traffic < TRAFFIC_TARGET && room.time >= this.nextTrafficAt) this.nextTrafficAt = room.time + (this.spawnTraffic(false) ? 6 : 2);
    if (this.respawnQueue.length && this.respawnQueue[0].at <= room.time) {
      const e = this.respawnQueue.shift();
      let free = this.list.size < MAX_VEHICLES;
      for (const o of this.list.values()) if (Math.hypot(o.x - e.sp.x, o.y - e.sp.y) < 4.5) free = false;
      if (free && this.seenByHumans(e.sp.x, e.sp.y, 14)) free = false;
      if (free && KV.carHitsHard(this.map, e.sp.x, e.sp.y, e.sp.a, 0.05)) free = false;
      if (free) this.create(e.sp.x, e.sp.y, e.sp.a, Math.floor(Math.random() * 8), 'parked', e.sp);
      else this.respawnQueue.push({ at: room.time + 20, sp: e.sp });
    }
  }

  snap(v) {
    const st = v.hp > CAR.HP * 0.66 ? 0 : v.hp > CAR.HP * 0.4 ? 1 : v.hp > CAR.HP * 0.2 ? 2 : 3;
    const fl = (v.brake ? 1 : 0) | (v.burn > 0 ? 2 : 0) | (v.state === 'traffic' ? 4 : 0) | (v.driver ? 8 : 0);
    return [v.id, r2(v.x), r2(v.y), r3(v.a), Math.round(v.v * 10) / 10, st, v.color, fl, v.driver || 0, Math.ceil(v.hp)];
  }
}

module.exports = { Vehicles, TRAFFIC_TARGET };
