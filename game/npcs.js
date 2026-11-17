'use strict';
/*
 * Жители города (NPC). Всё считает сервер.
 *  - прохожие ходят по тротуарам вокруг кварталов, на углах иногда переходят дорогу (ждут, пока нет машин);
 *    появляются вокруг игроков за краем экрана и исчезают вдали; каждый четвёртый вооружён, оружие выпадает;
 *  - на нападение безоружный убегает, вооружённый может отстреливаться; рядом стреляют - паника;
 *  - водитель машины с водителем отвечает на нападение по-разному: уезжает в панике, выскакивает и бежит,
 *    давит обидчика, стреляет из окна, выходит и стреляет; выскочившие не исчезают - живут как прохожие;
 *  - футболисты (10 и тренер) иногда бегают трусцой вокруг парка; задели одного - разбегаются все;
 *  - звёзды розыска (до 5) игрокам за нападения на мирных и машины; полиция приезжает с мигалками и стреляет
 *    на поражение; звезду гасит подобранная звезда погашения (3 на карте), все звёзды - смерть;
 *  - скорая приезжает к убитому мирному, врач лечит, человек встаёт и уходит.
 */
const KV = require('../public/shared.js');
const geom = require('./geom');
const { G, W, WEAPONS, CAR } = KV;

const K = { CIV: 0, COP: 1, MEDIC: 2, FOOT: 3, COACH: 4, SWAT: 5, ARMY: 6, HELI: 7 }; // HELI - только «кто стрелял»
const LAW = new Set([K.COP, K.SWAT, K.ARMY]); // служат закону: ловят того, кого ищут, мирных не трогают
const NPC_ID = -100;                       // «кто стрелял» у NPC: -100 - kind (у игроков номера положительные)
// пули полиции, спецназа, армии и вертолёта своих не задевают (иначе в перестрелке они перебивают друг друга:
// замер 17.11 - за минуту без единого выстрела игрока гибло до 15 из 18 бойцов спецназа)
const LAW_SHOT = new Set([NPC_ID - 1, NPC_ID - 5, NPC_ID - 6, NPC_ID - 7]);
const AMBIENT_NEAR = 12, AMBIENT_CAP = 45; // прохожих вокруг каждого игрока и всего
const WALK = 1.4, RUN = 6.2, JOG = 4.3;
const STAR_HEAT = [0, 25, 90, 200, 380, 650];
const POLICE_CAP = 7, AMB_CAP = 2;
// вертолёт: прочность (2 ракеты в упор, 3 рядом или ~25 попаданий из автомата), сколько всего; танков всего; снаряд танка раз в 3-4 с
const HELI_HP = 340, HELI_CAP = 2, TANK_CAP = 3, TANK_SHELL = 3.5;
const HELI_BLAST = { r: 4.5, dmg: 140, tile: 420 };
const EDGE = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // обход квартала по часовой: верх, право, низ, лево
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

class Npcs {
  constructor(room) {
    this.room = room;
    this.map = room.map;
    this.list = new Map();
    this.nextId = 1;
    this.helis = new Map(); // полицейские вертолёты: летают над домами, это не машины
    this.nextHeli = 1;
    this.team = null;
    this.nextTeamAt = 35 + Math.random() * 40;
    this.tick = 0;
    // тротуар вокруг квартала: прямоугольник по середине двухметровой полосы
    this.loops = (room.map.blocks || []).map(b => {
      const x0 = b.x + 1, y0 = b.y + 1, x1 = b.x + b.w - 1, y1 = b.y + b.h - 1;
      return { b, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, P: 2 * (x1 - x0 + y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    });
    this.grid = new Map();
    for (const l of this.loops) this.grid.set(l.b.i + ',' + l.b.j, l);
    // клетки дороги, где можно поставить машину (полиция, скорая)
    const m = this.map;
    this.roadTiles = [];
    for (let y = 3; y < m.h - 3; y++) {
      for (let x = 3; x < m.w - 3; x++) {
        const k = y * m.w + x;
        if (m.ground[k] !== G.ROAD) continue;
        let ok = true;
        for (let j = -1; j <= 1 && ok; j++) for (let i = -1; i <= 1; i++) { const t = m.block[(y + j) * m.w + x + i]; if (t && !KV.RAMMABLE[t]) { ok = false; break; } }
        if (ok) this.roadTiles.push(k);
      }
    }
  }

  // ======================================================================
  // общее
  // ======================================================================
  create(kind, x, y, o) {
    const n = Object.assign({
      id: this.nextId++, kind, x, y, a: Math.random() * 6.283, hp: kind === K.COP ? 100 : 70, alive: true,
      w: 0, look: Math.floor(Math.random() * 12), state: 'walk', until: 0, target: 0, from: null,
      loop: null, s: 0, dir: 1, lat: 0.3, cross: null, path: null, pi: 0, repath: 0, spd: 0,
      nextShot: 0, fireAt: 0, burstEnd: 0, burstPause: 0, aimJ: 0, strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 1, shotAt: -10,
      veh: 0, team: null, slot: 0, burnUntil: 0, burnBy: 0, burnT: 0, deadAt: 0, amb: 0, ambient: false, stuck: 0, turn: 0
    }, o || {});
    n.maxHp = n.maxHp || n.hp;
    this.list.set(n.id, n);
    return n;
  }
  remove(n) {
    this.list.delete(n.id);
    if (n.team) n.team.members = n.team.members.filter(id => id !== n.id);
  }
  randomGun() { const r = Math.random(); return r < 0.6 ? W.PISTOL : r < 0.8 ? W.SHOTGUN : W.RIFLE; }
  humans() { const out = []; for (const p of this.room.players.values()) if (!p.isBot) out.push(p); return out; }
  nearHuman(x, y, r) { for (const p of this.room.players.values()) if (!p.isBot && Math.abs(p.x - x) < r && Math.abs(p.y - y) < r && Math.hypot(p.x - x, p.y - y) < r) return true; return false; }
  // видно ли точку на экране хоть у одного игрока
  seen(x, y, pad = 2) {
    for (const p of this.room.players.values()) {
      if (p.isBot) continue;
      if (Math.abs(x - p.x) < p.view[0] + pad && Math.abs(y - p.y) < p.view[1] + pad) return true;
    }
    return false;
  }
  // кто цель: игрок или NPC
  targetOf(id) { return id > 0 ? this.room.players.get(id) : id < 0 ? this.list.get(-id) : null; }

  // точка на обходе квартала: s - путь по часовой от левого верхнего угла, lat - сдвиг внутрь квартала
  at(l, s, lat) {
    s = ((s % l.P) + l.P) % l.P;
    let x, y, e;
    if (s < l.w) { x = l.x0 + s; y = l.y0; e = 0; }
    else if (s < l.w + l.h) { x = l.x1; y = l.y0 + (s - l.w); e = 1; }
    else if (s < 2 * l.w + l.h) { x = l.x1 - (s - l.w - l.h); y = l.y1; e = 2; }
    else { x = l.x0; y = l.y1 - (s - 2 * l.w - l.h); e = 3; }
    const d = EDGE[e];
    return { x: x - d[1] * (lat || 0), y: y + d[0] * (lat || 0), e };
  }
  // ближайшая к точке позиция на обходе: { s, d }
  param(l, x, y) {
    const cx = clamp(x, l.x0, l.x1), cy = clamp(y, l.y0, l.y1);
    const c = [
      [cx - l.x0, Math.hypot(x - cx, y - l.y0)],
      [l.w + cy - l.y0, Math.hypot(x - l.x1, y - cy)],
      [l.w + l.h + (l.x1 - cx), Math.hypot(x - cx, y - l.y1)],
      [2 * l.w + l.h + (l.y1 - cy), Math.hypot(x - l.x0, y - cy)]
    ];
    let best = c[0];
    for (const v of c) if (v[1] < best[1]) best = v;
    return { s: best[0], d: best[1] };
  }
  nearestLoop(x, y) {
    let best = null, bd = 1e9, bs = 0;
    for (const l of this.loops) {
      if (Math.abs(l.cx - x) > 45 || Math.abs(l.cy - y) > 45) continue;
      const q = this.param(l, x, y);
      if (q.d < bd) { bd = q.d; best = l; bs = q.s; }
    }
    return best ? { l: best, s: bs, d: bd } : null;
  }

  // шаг к точке со скольжением вдоль стен; машины - препятствие; возвращает пройденное
  step(n, tx, ty, speed, dt) {
    const dx = tx - n.x, dy = ty - n.y, d = Math.hypot(dx, dy);
    if (d < 1e-3) { n.spd = 0; return 0; }
    const k = Math.min(1, (speed * dt) / d);
    let [nx, ny] = KV.moveCircle(this.map, n.x, n.y, dx * k, dy * k, KV.PLAYER_R);
    for (const v of this.room.vehicles.list.values()) {
      if (v.dead || Math.abs(v.x - nx) > 3 || Math.abs(v.y - ny) > 3) continue;
      const out = KV.pushOutOBB(nx, ny, KV.PLAYER_R, v.x, v.y, v.a, CAR.HL, CAR.HW);
      if (out) [nx, ny] = KV.pushOutSafe(this.map, n.x, n.y, out, 0, 0, KV.PLAYER_R);
    }
    const moved = Math.hypot(nx - n.x, ny - n.y);
    if (moved > 1e-4) n.a += angDiff(Math.atan2(ny - n.y, nx - n.x), n.a) * Math.min(1, dt * 10);
    n.x = nx; n.y = ny;
    n.spd = moved / dt;
    return moved;
  }
  // к цели по пути A* (пересчёт раз в 1.5-2 с)
  follow(n, gx, gy, speed, dt, limit) {
    const now = this.room.time;
    if (!n.path || now > n.repath || n.pi >= n.path.length) {
      n.path = this.room.bots.astar.find(Math.floor(n.x), Math.floor(n.y), Math.floor(gx), Math.floor(gy), limit || 1800);
      n.pi = 0;
      n.repath = now + 1.5 + Math.random() * 0.6;
    }
    let tx = gx, ty = gy;
    while (n.pi < n.path.length) {
      const p = n.path[n.pi];
      if (Math.hypot(p[0] - n.x, p[1] - n.y) < 0.45) { n.pi++; continue; }
      tx = p[0]; ty = p[1];
      break;
    }
    return this.step(n, tx, ty, speed, dt);
  }

  // ======================================================================
  // такт
  // ======================================================================
  update(dt) {
    const room = this.room, now = room.time;
    this.tick++;
    for (const n of [...this.list.values()]) {
      if (!this.list.has(n.id)) continue;
      if (!n.alive) continue;
      if (n.burnUntil > now) {
        n.burnT += dt;
        if (n.burnT >= 0.25) { n.burnT -= 0.25; this.damage(n, 3, n.burnBy, W.FLAMER, n.x, n.y, { silent: true }); if (!n.alive) continue; }
        if (n.state !== 'flee' && n.state !== 'incar') this.flee(n, n.x + rnd(-1, 1), n.y + rnd(-1, 1), 3);
      }
      switch (n.state) {
        case 'walk': this.walk(n, dt); break;
        case 'wait': this.waitCross(n, dt); break;
        case 'cross': this.crossStep(n, dt); break;
        case 'return': this.returnStep(n, dt); break;
        case 'flee': this.fleeStep(n, dt); break;
        case 'fight': this.fightStep(n, dt); break;
        case 'jog': break; // ведёт команда (teamStep)
        case 'medic': this.medicStep(n, dt); break;
        case 'leave': this.leaveStep(n, dt); break;
        default: break; // incar - едет в машине
      }
      if (n.state !== 'incar') this.keepApart(n);
    }
    if (this.team) this.teamStep(dt);
    for (const h of [...this.helis.values()]) this.heliStep(h, dt);
    if (this.tick % 15 === 0) { this.populate(); this.cleanup(); }
    if (this.tick % 45 === 0) { this.dispatchPolice(); this.dispatchAmbulance(); this.spawnTeam(); }
  }

  // прохожих чуть отталкивают игроки, чтобы не стояли внутри друг друга
  keepApart(n) {
    for (const p of this.room.players.values()) {
      if (!p.alive || p.vehicle || Math.abs(p.x - n.x) > 0.9 || Math.abs(p.y - n.y) > 0.9) continue;
      const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
      if (d >= 0.84 || d < 1e-4) continue;
      const [nx, ny] = KV.moveCircle(this.map, n.x, n.y, (dx / d) * (0.84 - d) * 0.5, (dy / d) * (0.84 - d) * 0.5, KV.PLAYER_R);
      n.x = nx; n.y = ny;
    }
  }

  // ---------- прохожие: ходьба по тротуару ----------
  walk(n, dt) {
    const l = n.loop;
    if (!l) { this.calm(n); return; }
    const look = this.at(l, n.s + n.dir * 1.1, n.lat);
    if (!KV.circleFree(this.map, look.x, look.y, 0.36)) {
      const other = this.at(l, n.s + n.dir * 1.1, -n.lat);
      if (KV.circleFree(this.map, other.x, other.y, 0.36)) n.lat = -n.lat; else n.dir = -n.dir;
    }
    const cur = this.at(l, n.s, n.lat);
    if (Math.hypot(cur.x - n.x, cur.y - n.y) < 1.2) {
      const e0 = cur.e;
      n.s = (n.s + n.dir * WALK * dt + l.P) % l.P;
      if (this.at(l, n.s, 0).e !== e0 && Math.random() < 0.3) { this.startCross(n, e0); return; }
    }
    const t = this.at(l, n.s + n.dir * 0.8, n.lat);
    if (this.step(n, t.x, t.y, WALK, dt) < WALK * dt * 0.2) {
      n.stuck += dt;
      if (n.stuck > 1.5) { n.stuck = 0; n.dir = -n.dir; n.lat = -n.lat; }
    } else n.stuck = 0;
  }
  // угол квартала: переходит дорогу прямо, к углу соседнего квартала
  startCross(n, e0) {
    const l = n.loop, D = [EDGE[e0][0] * n.dir, EDGE[e0][1] * n.dir];
    const nb = this.grid.get((l.b.i + D[0]) + ',' + (l.b.j + D[1]));
    if (!nb) return;
    const c = this.at(l, n.s, 0);
    const tx = clamp(c.x + D[0] * 6, nb.x0, nb.x1), ty = clamp(c.y + D[1] * 6, nb.y0, nb.y1);
    n.state = 'wait';
    n.cross = { nb, mx: (c.x + tx) / 2, my: (c.y + ty) / 2, tx, ty, D };
    n.until = this.room.time + 6;
  }
  waitCross(n, dt) {
    const c = n.cross;
    let busy = false;
    for (const v of this.room.vehicles.list.values()) {
      if (v.dead || Math.abs(v.v) < 1.5) continue;
      if (Math.hypot(v.x - c.mx, v.y - c.my) < 11) { busy = true; break; }
    }
    if (!busy || this.room.time > n.until) n.state = 'cross';
  }
  crossStep(n, dt) {
    const c = n.cross;
    this.step(n, c.tx, c.ty, WALK * 1.3, dt);
    if (Math.hypot(c.tx - n.x, c.ty - n.y) < 0.4) {
      const nb = c.nb, q = this.param(nb, n.x, n.y);
      const p1 = this.at(nb, q.s + 1, 0), p2 = this.at(nb, q.s - 1, 0);
      n.loop = nb; n.s = q.s;
      n.dir = (p1.x - p2.x) * c.D[0] + (p1.y - p2.y) * c.D[1] >= 0 ? 1 : -1;
      n.state = 'walk'; n.cross = null;
    }
  }
  // успокоился - возвращается на ближайший тротуар
  calm(n) {
    // врач после испуга возвращается к работе, если его скорая на месте
    if (n.kind === K.MEDIC && n.ambCar) {
      const v = this.room.vehicles.list.get(n.ambCar);
      if (v && !v.dead && v.state !== 'human' && v.state !== 'bot') { n.state = 'medic'; n.phase = n.phase === 'toCar' ? 'toCar' : 'toBody'; n.path = null; n.noProg = 0; n.bestD = 1e9; return; }
    }
    const q = this.nearestLoop(n.x, n.y);
    n.target = 0; n.path = null;
    if (!q) { n.state = 'leave'; return; }
    n.loop = q.l; n.s = q.s; n.dir = Math.random() < 0.5 ? 1 : -1; n.lat = Math.random() < 0.5 ? 0.3 : -0.3;
    n.state = q.d < 1.2 ? 'walk' : 'return';
  }
  returnStep(n, dt) {
    const p = this.at(n.loop, n.s, 0);
    this.follow(n, p.x, p.y, WALK * 1.2, dt, 1500);
    if (Math.hypot(p.x - n.x, p.y - n.y) < 1.2) n.state = 'walk';
  }

  // ---------- паника и бегство ----------
  flee(n, fx, fy, secs) {
    if (n.state === 'incar' || n.state === 'medic' && n.phase === 'heal') return;
    n.state = 'flee'; n.from = [fx, fy]; n.until = this.room.time + secs; n.turn = 0; n.stuck = 0; n.path = null;
  }
  fleeStep(n, dt) {
    if (this.room.time > n.until) { this.calm(n); return; }
    let dx = n.x - n.from[0], dy = n.y - n.from[1];
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    if (n.turn) { const c = Math.cos(n.turn), s = Math.sin(n.turn); [dx, dy] = [dx * c - dy * s, dx * s + dy * c]; }
    const moved = this.step(n, n.x + dx * 2, n.y + dy * 2, RUN, dt);
    if (moved < RUN * dt * 0.3) {
      n.stuck += dt;
      if (n.stuck > 0.3) { n.stuck = 0; n.turn = (Math.random() < 0.5 ? 1 : -1) * rnd(1.2, 2.2); }
    } else if (n.turn && Math.random() < dt * 0.6) n.turn = 0;
  }
  // выстрелы и взрывы рядом пугают безоружных (и половину вооружённых); команда футболистов разбегается
  noise(x, y, r) {
    const now = this.room.time;
    for (const n of this.list.values()) {
      // полиция не пугается, врач на вызове тоже
      if (!n.alive || LAW.has(n.kind) || n.kind === K.MEDIC || n.state === 'incar' || n.state === 'fight' || n.state === 'flee') continue;
      if (Math.abs(n.x - x) > r || Math.abs(n.y - y) > r || Math.hypot(n.x - x, n.y - y) > r) continue;
      if (n.team) { this.teamPanic(x, y); continue; }
      if (n.kind === K.MEDIC && n.phase === 'heal') continue;
      if (n.w && Math.random() < 0.5) continue;
      this.flee(n, x, y, rnd(5, 9));
    }
    if (this.team && Math.hypot(this.team.cx - x, this.team.cy - y) < r + 4) this.teamPanic(x, y);
    void now;
  }

  // ---------- бой: вооружённый прохожий, водитель, полицейский ----------
  fight(n, targetId, secs) {
    if (!n.w) { const t = this.targetOf(targetId); this.flee(n, t ? t.x : n.x, t ? t.y : n.y, rnd(6, 10)); return; }
    n.state = 'fight'; n.target = targetId; n.until = this.room.time + secs; n.path = null;
    n.fireAt = this.room.time + rnd(0.4, 0.9);
  }
  fightStep(n, dt) {
    const room = this.room, now = room.time;
    const t = this.targetOf(n.target);
    const law = LAW.has(n.kind);
    const wanted = !law || (t && t.stars > 0);
    if (!t || !t.alive || !wanted || now > n.until) { if (law) this.leave(n); else this.calm(n); return; }
    const tx = t.x, ty = t.y, d = Math.hypot(tx - n.x, ty - n.y);
    if (d > 45 && !law) { this.calm(n); return; }
    const los = d < 32 && geom.losClear(this.map, n.x, n.y, tx, ty, true);
    const w = WEAPONS[n.w];
    const want = n.w === W.SHOTGUN ? 4.5 : 7;
    const onScreen = room.onScreenOf(t, n.x, n.y);
    if (!los || d > want + 3 || !onScreen) this.follow(n, tx, ty, RUN * 0.85, dt, 2200);
    else {
      n.strafeT -= dt;
      if (n.strafeT <= 0) { n.strafe = -n.strafe; n.strafeT = rnd(0.8, 2); }
      const ux = (tx - n.x) / d, uy = (ty - n.y) / d, fwd = d > want + 1 ? 1 : d < want - 1 ? -0.7 : 0;
      this.step(n, n.x + (ux * fwd - uy * n.strafe * 0.7) * 2, n.y + (uy * fwd + ux * n.strafe * 0.7) * 2, RUN * 0.6, dt);
    }
    if (los) {
      n.a = Math.atan2(ty - n.y, tx - n.x);
      if (!law) n.until = Math.max(n.until, now + 6);
      if (onScreen && now >= n.fireAt && now >= n.nextShot && d < w.range * 0.85 && this.canShoot(n, now)) this.shoot(n, tx, ty, d, 0);
    }
  }
  // очереди: 0.5-1 с огня, пауза 0.9-1.6 с
  canShoot(n, now) {
    if (now > n.burstEnd + n.burstPause) { n.burstEnd = now + rnd(0.5, 1); n.burstPause = rnd(0.9, 1.6); }
    return now <= n.burstEnd;
  }
  // выстрел NPC с ошибкой прицела (полиция чуть точнее)
  shoot(n, tx, ty, d, vehId, ox, oy) {
    const w = WEAPONS[n.w];
    if (!w || w.melee) return;
    const now = this.room.time;
    n.nextShot = now + 1 / (w.rate * (LAW.has(n.kind) ? 0.75 : 0.55));
    n.aimJ = (n.aimJ + (Math.random() - 0.5) * 0.3) * 0.9;
    const err = (n.kind === K.SWAT ? 0.07 : LAW.has(n.kind) ? 0.08 : 0.12) + Math.min(0.25, d * 0.011);
    const a = Math.atan2(ty - (oy === undefined ? n.y : oy), tx - (ox === undefined ? n.x : ox)) + n.aimJ + (Math.random() - 0.5) * err * 2;
    n.a = a; n.shotAt = now;
    this.room.spawnShot(ox === undefined ? n.x : ox, oy === undefined ? n.y : oy, a, w, NPC_ID - n.kind, vehId || 0, d, n.id);
    if (this.tick % 2 === 0) this.noise(n.x, n.y, 9);
  }
  leave(n) { n.state = 'leave'; n.target = 0; n.path = null; n.until = this.room.time + 40; }
  // уходит от игроков и исчезает, когда никто не видит
  leaveStep(n, dt) {
    let best = null, bd = 1e9;
    for (const p of this.room.players.values()) { if (p.isBot) continue; const d = Math.hypot(p.x - n.x, p.y - n.y); if (d < bd) { bd = d; best = p; } }
    if (!best) return;
    const dx = n.x - best.x, dy = n.y - best.y, d = Math.hypot(dx, dy) || 1;
    if (this.step(n, n.x + (dx / d) * 2, n.y + (dy / d) * 2, WALK * 1.6, dt) < WALK * dt * 0.3) n.a += 1.2;
  }

  // ======================================================================
  // урон, смерть, реакция
  // ======================================================================
  damage(n, amount, attackerId, weaponId, hx, hy, opt) {
    if (!n.alive || amount <= 0 || n.veh) return;
    n.hp -= amount;
    if (!(opt && opt.silent)) this.room.ev.nh.push([r2(hx), r2(hy)]);
    const att = attackerId > 0 ? this.room.players.get(attackerId) : null;
    if (att && !att.isBot) this.crime(att, LAW.has(n.kind) ? 18 : 8, 'n' + n.id);
    if (n.hp <= 0) { this.die(n, attackerId, weaponId); return; }
    this.provoked(n, attackerId, hx, hy);
  }
  provoked(n, attackerId, x, y) {
    if (n.team) { this.teamPanic(x, y); return; }
    if (n.state === 'incar') return;
    const att = this.targetOf(attackerId);
    if (LAW.has(n.kind)) { if (att && attackerId > 0 && !att.isBot && (n.state !== 'fight' || !(this.targetOf(n.target) || {}).alive)) this.fight(n, attackerId, 60); return; }
    if (n.kind === K.MEDIC) { this.flee(n, x, y, rnd(5, 8)); return; }
    if (n.state === 'fight') return;
    if (att && attackerId > 0 && n.w && Math.random() < 0.6) this.fight(n, attackerId, 20);
    else this.flee(n, att ? att.x : x, att ? att.y : y, rnd(7, 11));
    this.noise(x, y, 8);
  }
  die(n, killerId, weaponId) {
    const room = this.room;
    n.alive = false; n.hp = 0; n.deadAt = room.time; n.state = 'dead'; n.burnUntil = 0; n.path = null; n.amb = 0;
    room.ev.nk.push([n.id, r2(n.x), r2(n.y)]);
    if (n.w) room.addPickup(KV.PK.WEAPON, n.w, n.x, n.y, Math.ceil(WEAPONS[n.w].pick * 0.6)); // оружие убитого падает
    n.w = 0;
    const k = killerId > 0 ? room.players.get(killerId) : null;
    if (k && !k.isBot) {
      if (LAW.has(n.kind)) k.copKills = (k.copKills || 0) + 1; else k.civKills = (k.civKills || 0) + 1;
      room.sbDirty = true;
      this.crime(k, LAW.has(n.kind) ? 60 : 25);
    }
    if (n.team) this.teamPanic(n.x, n.y);
    this.noise(n.x, n.y, 12);
  }
  ignite(n, by, secs) { if (n.alive && !n.veh) { n.burnUntil = Math.max(n.burnUntil, this.room.time + secs); n.burnBy = by; } }

  // попадания по NPC: пуля (ray), огонь, удар, взрыв, машина
  rayHit(b, step, tMax) {
    let best = null, bt = tMax;
    const lawShot = LAW_SHOT.has(b.owner);
    for (const n of this.list.values()) {
      if (!n.alive || n.veh || n.id === b.npc || (lawShot && LAW.has(n.kind))) continue;
      if (Math.abs(n.x - b.x) > step + 1 || Math.abs(n.y - b.y) > step + 1) continue;
      const t = geom.rayCircle(b.x, b.y, b.dx, b.dy, n.x, n.y, b.flame ? 0.65 : 0.5);
      if (t >= 0 && t <= step && t < bt) { bt = t; best = n; }
    }
    return best ? { t: bt, n: best } : null;
  }
  meleeTarget(p, range) {
    const ax = Math.cos(p.a), ay = Math.sin(p.a);
    let best = null, bd = range + 0.5;
    for (const n of this.list.values()) {
      if (!n.alive || n.veh) continue;
      const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
      if (d >= bd || (dx * ax + dy * ay) / (d || 1) < 0.45) continue;
      if (!geom.losClear(this.map, p.x, p.y, n.x, n.y, false)) continue;
      best = n; bd = d;
    }
    return best;
  }
  explode(x, y, blast, ownerId, weaponId) {
    for (const n of [...this.list.values()]) {
      if (!n.alive || n.veh) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d >= blast.r + 0.4) continue;
      let dmg = blast.dmg * (1 - Math.max(0, d - 0.4) / blast.r);
      if (!geom.losClear(this.map, x, y, n.x, n.y, false)) dmg *= 0.4;
      this.damage(n, dmg, ownerId, weaponId, n.x, n.y);
    }
    // вертолёт рядом со взрывом (ракета в него или взрыв под ним): расстояние - от корпуса, ракета рвётся о него
    for (const h of [...this.helis.values()]) {
      const d = Math.max(0, Math.hypot(h.x - x, h.y - y) - 1.6);
      if (d < blast.r) this.heliDamage(h, blast.dmg * (1 - d / blast.r) * 1.6, ownerId);
    }
    this.noise(x, y, 18);
  }
  // машина сбила NPC (скорость - полная, с заносом)
  carHits(v, speed, vx, vy) {
    const room = this.room, now = room.time;
    // служебные машины с водителем-NPC своих (полицию, спецназ, армию, врачей) не давят, скорая - вообще никого:
    // замер 17.11 - скорая сбивала полицейских у игрока и потом сама же ехала за телами
    const service = v.state === 'npc' && (v.kind === 'police' || v.kind === 'swat' || v.kind === 'tank' || v.kind === 'amb');
    for (const n of this.list.values()) {
      if (!n.alive || n.veh || Math.abs(n.x - v.x) > 3.2 || Math.abs(n.y - v.y) > 3.2) continue;
      const out = KV.pushOutOBB(n.x, n.y, KV.PLAYER_R + 0.05, v.x, v.y, v.a, CAR.HL, CAR.HW);
      if (!out) continue;
      const spare = service && (v.kind === 'amb' || LAW.has(n.kind) || n.kind === K.MEDIC);
      if (!spare && speed > (v.kind === 'tank' ? 0.8 : 2.5)) {
        if (now - (n.carHitAt || -10) < 0.7) continue;
        n.carHitAt = now;
        let kx = out[0] - v.x, ky = out[1] - v.y;
        const kl = Math.hypot(kx, ky) || 1;
        kx = (kx / kl) * 0.6 + (vx / speed) * 0.6; ky = (ky / kl) * 0.6 + (vy / speed) * 0.6;
        const q = KV.pushOutSafe(this.map, n.x, n.y, out, kx * (0.6 + speed * 0.12), ky * (0.6 + speed * 0.12), KV.PLAYER_R);
        n.x = q[0]; n.y = q[1];
        const crew = v.crew && v.crew.length ? this.list.get(v.crew[0]) : null;
        const credit = v.driver || (crew ? NPC_ID - crew.kind : 0) || (now - (v.exitAt || -99) < 6 ? v.lastDriver : 0);
        room.ev.ck.push([v.id, 0, r2(n.x), r2(n.y)]);
        this.damage(n, v.kind === 'tank' ? 250 : Math.min(90, Math.max(12, speed * 6)), credit, -2, n.x, n.y);
        if (v.state !== 'human' && v.kind !== 'tank') v.v *= 0.85;
      } else { const q = KV.pushOutSafe(this.map, n.x, n.y, out, 0, 0, KV.PLAYER_R); n.x = q[0]; n.y = q[1]; }
    }
  }
  // человек впереди машины с водителем-NPC (та тормозит)
  personAhead(v, c, s) {
    for (const n of this.list.values()) {
      if (!n.alive || n.veh) continue;
      const dx = n.x - v.x, dy = n.y - v.y;
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12) continue;
      const f = dx * c + dy * s;
      if (f < 1.6 || f > 12 || Math.abs(-dx * s + dy * c) > 1.6) continue;
      return true;
    }
    return false;
  }

  // ======================================================================
  // население: прохожие вокруг игроков, уборка вдали
  // ======================================================================
  populate() {
    const hs = this.humans();
    if (!hs.length || !this.loops.length) return;
    let total = 0;
    for (const n of this.list.values()) if (n.ambient && n.alive) total++;
    for (const p of hs) {
      if (total >= AMBIENT_CAP) return;
      let near = 0;
      for (const n of this.list.values()) if (n.ambient && n.alive && Math.abs(n.x - p.x) < 40 && Math.abs(n.y - p.y) < 40) near++;
      for (let tries = 0; tries < 6 && near < AMBIENT_NEAR && total < AMBIENT_CAP; tries++) {
        const l = this.loops[Math.floor(Math.random() * this.loops.length)];
        if (Math.abs(l.cx - p.x) > 55 || Math.abs(l.cy - p.y) > 55) continue;
        const s = Math.random() * l.P, lat = Math.random() < 0.5 ? 0.3 : -0.3;
        const pt = this.at(l, s, lat);
        const d = Math.hypot(pt.x - p.x, pt.y - p.y);
        if (d < 16 || d > 42 || this.seen(pt.x, pt.y, 1.5) || !KV.circleFree(this.map, pt.x, pt.y, KV.PLAYER_R)) continue;
        this.create(K.CIV, pt.x, pt.y, { ambient: true, loop: l, s, lat, dir: Math.random() < 0.5 ? 1 : -1, w: Math.random() < 0.25 ? this.randomGun() : 0 });
        near++; total++;
      }
    }
  }
  cleanup() {
    const now = this.room.time;
    for (const n of [...this.list.values()]) {
      if (n.state === 'incar' || n.team) continue;
      if (!n.alive) {
        // тело: ждёт скорую, потом исчезает
        if (n.healing) continue;
        if (now - n.deadAt > 70 || (now - n.deadAt > 10 && !this.nearHuman(n.x, n.y, 55)) || ((LAW.has(n.kind) || n.kind === K.MEDIC) && now - n.deadAt > 30 && !this.seen(n.x, n.y))) this.remove(n);
        continue;
      }
      if (n.state === 'leave') { if (!this.seen(n.x, n.y, 3) || now > n.until) this.remove(n); continue; }
      if ((n.state === 'walk' || n.state === 'wait' || n.state === 'cross' || n.state === 'return' || n.state === 'flee') && !this.nearHuman(n.x, n.y, 55)) this.remove(n);
      else if (LAW.has(n.kind) && n.state !== 'fight' && !this.nearHuman(n.x, n.y, 70)) this.remove(n);
    }
    // машины NPC вдали от игроков убираем вместе с теми, кто внутри
    for (const v of [...this.room.vehicles.list.values()]) {
      if (v.state !== 'npc' || v.dead) continue;
      if ((v.role === 'cruise' || v.role === 'leave' || (v.role === 'flee' && now > v.until)) && !this.nearHuman(v.x, v.y, 55)) this.removeCar(v);
    }
    // застрявшая погоня (полиция, спецназ, танк): 10 с на месте там, где её никто не видит, - убираем, приедет другая
    // (замер 17.11: на 1 карте из 8 грузовик спецназа простоял за углом 49 с)
    for (const v of [...this.room.vehicles.list.values()]) {
      if (v.state !== 'npc' || v.dead || (v.role !== 'police' && v.role !== 'tank')) continue;
      const moved = v.lastPos ? Math.hypot(v.x - v.lastPos[0], v.y - v.lastPos[1]) : 99;
      v.lastPos = [v.x, v.y];
      v.stillT = moved < 1 ? (v.stillT || 0) + 0.5 : 0;
      if (v.stillT > 10 && !this.seen(v.x, v.y, 4)) this.removeCar(v);
    }
  }
  removeCar(v) {
    for (const id of v.crew || []) { const n = this.list.get(id); if (n) this.remove(n); }
    v.crew = [];
    this.room.vehicles.remove(v);
  }

  // ======================================================================
  // машины с водителем-NPC: реакция на нападение, посадка, пилот
  // ======================================================================
  // Машину с водителем обстреляли, протаранили, взорвали рядом, подожгли или угоняют
  driverReact(v, attackerId, cause) {
    if (v.state !== 'traffic' || v.dead) return;
    const room = this.room;
    room.vehicles.releaseAll(v);
    const drv = this.create(K.CIV, v.x, v.y, { state: 'incar', veh: v.id, w: Math.random() < 0.25 ? this.randomGun() : 0, hp: 70 });
    v.state = 'npc'; v.crew = [drv.id]; v.ai = null; v.pilot = {}; v.brake = false; v.from = null; v.target = 0;
    const att = attackerId > 0 ? room.players.get(attackerId) : null;
    const fx = att ? att.x : v.x, fy = att ? att.y : v.y;
    if (cause === 'steal' || cause === 'fire' || cause === 'blast' || !att) {
      this.exitCar(v, drv);
      if (att && drv.w && cause === 'steal' && Math.random() < 0.5) this.fight(drv, attackerId, 20);
      else this.flee(drv, fx, fy, rnd(7, 11));
      return;
    }
    // как в жизни: чаще бегут, вооружённые иногда отвечают
    const r = Math.random();
    let act;
    if (drv.w) act = r < 0.3 ? 'flee' : r < 0.5 ? 'exit-flee' : r < 0.65 ? 'ram' : r < 0.82 ? 'driveby' : 'exit-fight';
    else act = r < 0.45 ? 'flee' : r < 0.8 ? 'exit-flee' : 'ram';
    if (act === 'exit-flee') { this.exitCar(v, drv); this.flee(drv, fx, fy, rnd(7, 11)); return; }
    if (act === 'exit-fight') { this.exitCar(v, drv); this.fight(drv, attackerId, 25); return; }
    v.role = act === 'flee' ? 'flee' : act; v.target = attackerId; v.from = [fx, fy];
    v.until = room.time + (act === 'flee' ? 15 : act === 'ram' ? 12 : 16);
  }
  // кто-то садится в машину NPC - всех выталкивают; полицейские и вооружённые дают отпор
  ejectCrew(v, thiefId) {
    for (const id of [...(v.crew || [])]) {
      const n = this.list.get(id);
      if (!n) continue;
      this.exitCar(v, n);
      if (LAW.has(n.kind)) { const t = this.room.players.get(thiefId); if (t && !t.isBot) this.crime(t, 18); this.fight(n, thiefId, 60); }
      else if (n.w && Math.random() < 0.5) this.fight(n, thiefId, 20);
      else { const t = this.room.players.get(thiefId); this.flee(n, t ? t.x : v.x, t ? t.y : v.y, rnd(7, 11)); }
    }
    v.crew = [];
  }
  exitCar(v, n) {
    const c = Math.cos(v.a), s = Math.sin(v.a);
    // двери с обеих сторон, сзади и спереди; где уже стоит вышедший - занято (из грузовика спецназа выходят шестеро)
    const cands = [];
    for (const along of [0, -1.3, 1.3]) for (const side of [1, -1]) cands.push([v.x + c * along + s * side * (CAR.HW + 0.6), v.y + s * along - c * side * (CAR.HW + 0.6)]);
    cands.push([v.x - c * (CAR.HL + 0.6), v.y - s * (CAR.HL + 0.6)], [v.x + c * (CAR.HL + 0.6), v.y + s * (CAR.HL + 0.6)]);
    let spot = null;
    for (const [x, y] of cands) {
      if (!KV.circleFree(this.map, x, y, KV.PLAYER_R) || this.room.vehicles.personBlocked(x, y, v)) continue;
      let busy = false;
      for (const o of this.list.values()) if (o !== n && o.alive && !o.veh && Math.abs(o.x - x) < 0.75 && Math.abs(o.y - y) < 0.75) { busy = true; break; }
      if (!busy) { spot = [x, y]; break; }
    }
    if (!spot) spot = KV.collideCircle(this.map, v.x + s * (CAR.HW + 0.6), v.y - c * (CAR.HW + 0.6), KV.PLAYER_R);
    n.x = spot[0]; n.y = spot[1]; n.veh = 0; n.state = 'walk'; n.loop = null;
    v.crew = (v.crew || []).filter(id => id !== n.id);
    if (!v.crew.length && v.state === 'npc') { v.state = 'parked'; v.role = null; v.siren = false; v.brake = false; v.v *= 0.4; }
  }
  syncCrew(v) {
    for (const id of v.crew || []) { const n = this.list.get(id); if (n) { n.x = v.x; n.y = v.y; n.a = v.a; } }
  }
  // машина взорвалась - все внутри погибают (тела рядом с машиной)
  carExploded(v) {
    for (const id of [...(v.crew || [])]) {
      const n = this.list.get(id);
      if (!n) continue;
      n.veh = 0; n.state = 'walk';
      const q = KV.collideCircle(this.map, v.x + rnd(-1.5, 1.5), v.y + rnd(-1.5, 1.5), KV.PLAYER_R);
      n.x = q[0]; n.y = q[1];
      this.die(n, v.lastAttacker, -1);
    }
    v.crew = [];
  }
  // далёкая точка на дороге (уехать от обидчика)
  farRoad(v, fx, fy) {
    let best = null, bs = -1;
    for (let i = 0; i < 14; i++) {
      const k = this.roadTiles[Math.floor(Math.random() * this.roadTiles.length)];
      const x = (k % this.map.w) + 0.5, y = Math.floor(k / this.map.w) + 0.5;
      const sc = Math.hypot(x - fx, y - fy) - Math.hypot(x - v.x, y - v.y) * 0.3;
      if (sc > bs) { bs = sc; best = [x, y]; }
    }
    return best;
  }

  // Пилот машины NPC: возвращает [газ, руль]
  pilot(v, dt) {
    const room = this.room, now = room.time, P = v.pilot || (v.pilot = {});
    if (!v.crew || !v.crew.length) { v.state = 'parked'; return [0, 0]; }
    const drv = this.list.get(v.crew[0]);
    if (!drv || !drv.alive) { this.ejectCrew(v, 0); return [0, 0]; }
    if (!room.bots.driveMask || now - room.bots.driveMaskAt > 10) room.bots.buildDriveMask();
    let gx = null, gy = null, direct = false, limit = 99;
    const t = v.target ? room.players.get(v.target) : null;
    const tv = t && t.vehicle ? room.vehicles.list.get(t.vehicle) : null;
    const txp = tv ? tv.x : t ? t.x : 0, typ = tv ? tv.y : t ? t.y : 0;
    const dT = t ? Math.hypot(txp - v.x, typ - v.y) : 1e9;
    const los = t && t.alive && dT < 28 && geom.losClear(this.map, v.x, v.y, txp, typ, true);

    if (v.role === 'ram' || v.role === 'driveby') {
      if (!t || !t.alive || now > v.until) { v.role = 'flee'; v.until = now + 15; v.from = t ? [t.x, t.y] : [v.x, v.y]; P.dest = null; }
    }
    if (v.role === 'police') {
      if (!t || !t.alive || !(t.stars > 0)) { v.role = 'leave'; v.siren = false; P.dest = null; }
      else {
        gx = txp; gy = typ;
        if (tv && t.stars >= 2 && los) direct = true; // таранит машину того, кого ищут
        // пешего вблизи - выходят и стреляют
        if (!t.vehicle && ((dT < 11 && los) || (dT < 18 && Math.abs(v.v) < 1 && (P.slowT = (P.slowT || 0) + dt) > 1.5))) {
          for (const id of [...v.crew]) { const c = this.list.get(id); if (c) { this.exitCar(v, c); this.fight(c, t.id, 90); } }
          return [0, 0];
        }
        if (Math.abs(v.v) >= 1) P.slowT = 0;
        // с 3 звёзд напарник стреляет из окна
        const mate = v.crew[1] ? this.list.get(v.crew[1]) : null;
        if (mate && t.stars >= 3 && los && dT < 15 && room.onScreenOf(t, v.x, v.y) && now >= mate.nextShot && this.canShoot(mate, now)) this.shoot(mate, txp, typ, dT, v.id, v.x + Math.cos(v.a + 1.57) * 0.6, v.y + Math.sin(v.a + 1.57) * 0.6);
      }
    }
    if (v.role === 'tank') {
      if (!t || !t.alive || !(t.stars >= 5)) { v.role = 'leave'; P.dest = null; }
      else {
        // едет прямо на цель и давит всё на пути; башня смотрит на цель; снаряд - когда цель видна и танк у неё на экране
        gx = txp; gy = typ; direct = los;
        v.turret = Math.atan2(typ - v.y, txp - v.x);
        if (los && dT > 5 && dT < 26 && now >= (v.shellAt || 0) && room.onScreenOf(t, v.x, v.y)) {
          v.shellAt = now + TANK_SHELL + rnd(-0.5, 0.5);
          const a = v.turret + rnd(-0.05, 0.05);
          room.spawnShot(v.x + Math.cos(a) * 2.6, v.y + Math.sin(a) * 2.6, a, WEAPONS[W.LAUNCHER], NPC_ID - K.ARMY, v.id, Math.max(2.5, dT - 2.6 + rnd(-1, 1)), drv.id);
          this.noise(v.x, v.y, 16);
        }
      }
    }
    if (v.role === 'ram') { gx = txp; gy = typ; direct = los; }
    if (v.role === 'driveby') {
      gx = txp; gy = typ; direct = los && dT > 9;
      if (dT < 9) limit = 3;
      if (los && dT < 16 && room.onScreenOf(t, v.x, v.y) && now >= drv.nextShot && this.canShoot(drv, now)) this.shoot(drv, txp, typ, dT, v.id, v.x + Math.cos(v.a - 1.57) * 0.6, v.y + Math.sin(v.a - 1.57) * 0.6);
    }
    if (v.role === 'amb') {
      gx = v.stop[0]; gy = v.stop[1];
      const ds = Math.hypot(gx - v.x, gy - v.y);
      // застряла по дороге: недалеко - врач дойдёт пешком, далеко - вызов снимается (приедет другая)
      if (now - v.ambT > 40) {
        if (ds < 25 && Math.abs(v.v) < 1) { v.v = 0; v.sx = 0; v.sy = 0; this.ambArrived(v); return [0, 0]; }
        if (ds >= 25) { const b = this.list.get(v.body); if (b && b.amb === v.id) b.amb = 0; v.role = 'leave'; v.siren = false; P.dest = null; v.from = [v.x, v.y]; }
      }
      if (ds < 8) limit = Math.max(2, ds * 1.2);
      if (ds < 2 || (ds < 10 && Math.abs(v.v) < 0.6 && (P.slowT = (P.slowT || 0) + dt) > 2.5)) {
        // доехали: тормоз до полной остановки, только потом выходит врач
        v.brake = true;
        if (Math.abs(v.v) > 0.4) return [v.v > 0 ? -1 : 1, 0];
        v.v = 0; v.sx = 0; v.sy = 0;
        this.ambArrived(v);
        return [0, 0];
      }
    }
    if (v.role === 'park') { v.brake = true; return [v.v > 0.3 ? -1 : 0, 0]; }
    if (v.role === 'flee' || v.role === 'leave' || v.role === 'cruise') {
      if (!P.dest || Math.hypot(P.dest[0] - v.x, P.dest[1] - v.y) < 8 || now > (P.destT || 0)) {
        P.dest = this.farRoad(v, v.from ? v.from[0] : v.x, v.from ? v.from[1] : v.y);
        P.destT = now + 25;
        if (!P.dest) return [0, 0];
      }
      [gx, gy] = P.dest;
      if (v.role === 'cruise') limit = 11;
      if (v.role === 'flee' && now > v.until) { v.role = 'cruise'; }
    }
    if (gx === null) return [0, 0];
    let tx = gx, ty = gy;
    if (!direct) {
      if (!P.path || now > (P.repath || 0) || P.pi >= P.path.length) {
        P.path = room.bots.vastar.find(Math.floor(v.x), Math.floor(v.y), Math.floor(gx), Math.floor(gy), 2500);
        P.pi = 0; P.repath = now + 1.3;
      }
      if (P.path.length) {
        while (P.pi < P.path.length - 1 && Math.hypot(P.path[P.pi][0] - v.x, P.path[P.pi][1] - v.y) < 4.5) P.pi++;
        [tx, ty] = P.path[Math.min(P.pi, P.path.length - 1)];
      }
    }
    if (P.revT > 0) { P.revT -= dt; return [-1, -P.revSteer]; }
    const diff = angDiff(Math.atan2(ty - v.y, tx - v.x), v.a);
    // жители водят аккуратнее игроков: своя предельная скорость и торможение перед поворотом (иначе бьются о стены)
    limit = Math.min(limit, v.maxV || 99, v.role === 'ram' ? 18 : v.role === 'police' ? 16 : v.role === 'amb' ? 14 : 13);
    if (Math.abs(diff) > 0.5) limit = Math.min(limit, 7);
    let thr = Math.abs(diff) < 1.2 ? 1 : 0.45;
    if (v.v > limit) thr = v.v > limit + 2 ? -0.6 : 0;
    const steer = clamp(diff * 2.2, -1, 1);
    if (Math.abs(v.v) < 0.8 && thr > 0) {
      P.stuck = (P.stuck || 0) + dt;
      if (P.stuck > 1.3) { P.stuck = 0; P.revT = 0.9; P.revSteer = steer >= 0 ? 1 : -1; P.repath = 0; }
    } else P.stuck = 0;
    v.brake = thr <= 0;
    return [thr, steer];
  }

  // ======================================================================
  // звёзды розыска и полиция
  // ======================================================================
  crime(p, heat, key) {
    if (!p || p.isBot || !p.alive) return;
    const now = this.room.time;
    if (key) {
      if (!p.crimeAt) p.crimeAt = new Map();
      if (now - (p.crimeAt.get(key) || -9) < 0.5) return;
      p.crimeAt.set(key, now);
      if (p.crimeAt.size > 200) p.crimeAt.clear();
    }
    p.heat = (p.heat || 0) + heat;
    let s = 0;
    while (s < 5 && p.heat >= STAR_HEAT[s + 1]) s++;
    if (s > (p.stars || 0)) { p.stars = s; this.room.ev.ws.push([p.id, s]); }
  }
  // подобрал звезду погашения: минус одна звезда
  starPicked(p) {
    p.stars = Math.max(0, (p.stars || 0) - 1);
    p.heat = p.stars ? STAR_HEAT[p.stars] : 0;
    this.room.ev.ws.push([p.id, p.stars]);
  }
  playerDied(p) {
    if (p.stars) this.room.ev.ws.push([p.id, 0]);
    p.stars = 0; p.heat = 0;
  }
  // клетка дороги в нужном кольце расстояний, которую не видит ни один игрок
  roadSpawn(x, y, rmin, rmax) {
    for (let i = 0; i < 40; i++) {
      const k = this.roadTiles[Math.floor(Math.random() * this.roadTiles.length)];
      const rx = (k % this.map.w) + 0.5, ry = Math.floor(k / this.map.w) + 0.5;
      const d = Math.hypot(rx - x, ry - y);
      if (d < rmin || d > rmax || this.seen(rx, ry, 4)) continue;
      let free = true;
      for (const v of this.room.vehicles.list.values()) if (!v.dead && Math.hypot(v.x - rx, v.y - ry) < 6) { free = false; break; }
      if (!free) continue;
      // машина длиной 4 м: весь кузов должен встать на свободное место (носом к цели или вдоль дороги)
      const toward = Math.atan2(y - ry, x - rx);
      for (const a of [toward, 0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        if (!KV.carOverlapsSolid(this.map, rx, ry, a, 0.05, null)) return { x: rx, y: ry, a };
      }
    }
    return null;
  }
  roadNear(x, y, r, minD) {
    const m = this.map;
    let best = null, bd = r;
    minD = minD || 0;
    for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
      for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
        if (tx < 2 || ty < 2 || tx >= m.w - 2 || ty >= m.h - 2 || m.ground[ty * m.w + tx] !== G.ROAD) continue;
        const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
        if (d >= minD && d < bd && this.room.bots.driveMask && this.room.bots.driveMask[ty * m.w + tx]) { bd = d; best = [tx + 0.5, ty + 0.5]; }
      }
    }
    return best;
  }
  dispatchPolice() {
    const room = this.room;
    let total = 0;
    const per = new Map();
    for (const v of room.vehicles.list.values()) {
      if (v.dead || v.kind !== 'police' || v.state !== 'npc' || v.role !== 'police') continue;
      total++;
      per.set(v.target, (per.get(v.target) || 0) + 1);
    }
    // вышедшие из машин полицейские, которые уже ловят игрока: двое - как одна машина
    const onFoot = new Map();
    for (const n of this.list.values()) if (n.alive && n.kind === K.COP && n.state === 'fight') onFoot.set(n.target, (onFoot.get(n.target) || 0) + 1);
    for (const [id, c] of onFoot) { const u = Math.ceil(c / 2); per.set(id, (per.get(id) || 0) + u); total += u; }
    for (const p of room.players.values()) {
      if (p.isBot || !p.alive || !(p.stars > 0)) continue;
      const want = Math.min(5, p.stars);
      if ((per.get(p.id) || 0) >= want || total >= POLICE_CAP) continue;
      const sp = this.roadSpawn(p.x, p.y, 30, 55);
      if (!sp) continue;
      const v = room.vehicles.create(sp.x, sp.y, sp.a, 6, 'npc', null);
      v.kind = 'police'; v.role = 'police'; v.target = p.id; v.siren = true; v.pilot = {};
      const gun = p.stars <= 2 ? W.PISTOL : p.stars === 3 ? W.SHOTGUN : W.RIFLE;
      v.crew = [this.create(K.COP, v.x, v.y, { state: 'incar', veh: v.id, w: gun, hp: 100 }).id,
        this.create(K.COP, v.x, v.y, { state: 'incar', veh: v.id, w: gun === W.PISTOL ? W.PISTOL : W.SHOTGUN, hp: 100 }).id];
      total++;
      per.set(p.id, (per.get(p.id) || 0) + 1);
    }
    // тяжёлая техника по звёздам: 3 - грузовик спецназа, 4 - вертолёт, 5 - танки
    for (const p of room.players.values()) {
      if (p.isBot || !p.alive) continue;
      const s = p.stars || 0;
      if (s >= 3 && !this.unitFor(p.id, 'swat')) this.spawnUnit(p, 'swat');
      if (s >= 4 && this.helis.size < HELI_CAP && ![...this.helis.values()].some(h => h.target === p.id && h.state === 'fly')) this.spawnHeli(p);
      if (s >= 5 && this.unitFor(p.id, 'tank') < 2 && this.unitFor(0, 'tank') < TANK_CAP) this.spawnUnit(p, 'tank');
    }
  }
  // сколько техники этого вида гонится за игроком (pid 0 - за всеми); вышедший спецназ тоже в деле:
  // пока бьются хотя бы двое бойцов, новый грузовик не едет
  unitFor(pid, kind) {
    let n = 0;
    const role = kind === 'tank' ? 'tank' : 'police';
    for (const v of this.room.vehicles.list.values()) if (!v.dead && v.kind === kind && v.state === 'npc' && v.role === role && (!pid || v.target === pid)) n++;
    if (kind === 'swat') {
      let f = 0;
      for (const o of this.list.values()) if (o.alive && o.kind === K.SWAT && o.state === 'fight' && (!pid || o.target === pid)) f++;
      if (f >= 2) n++;
    }
    return n;
  }
  spawnUnit(p, kind) {
    const room = this.room;
    const sp = this.roadSpawn(p.x, p.y, 32, 58);
    if (!sp) return null;
    const v = room.vehicles.setKind(room.vehicles.create(sp.x, sp.y, sp.a, 6, 'npc', null), kind);
    v.target = p.id; v.pilot = {}; v.crew = [];
    if (kind === 'swat') {
      // бронированный грузовик и шестеро бойцов с автоматами
      v.role = 'police'; v.siren = true;
      for (let i = 0; i < 6; i++) v.crew.push(this.create(K.SWAT, v.x, v.y, { state: 'incar', veh: v.id, w: W.RIFLE, hp: 130 }).id);
    } else {
      v.role = 'tank'; v.siren = false; v.turret = sp.a; v.shellAt = room.time + 2;
      v.crew.push(this.create(K.ARMY, v.x, v.y, { state: 'incar', veh: v.id, w: W.RIFLE, hp: 120 }).id);
    }
    return v;
  }

  // ======================================================================
  // полицейский вертолёт: прилетает из-за края экрана, кружит над целью с прожектором и бьёт очередями сверху.
  // Летает над домами (стены ему не мешают). Сбить можно: 2-3 ракеты или много пуль - падает и взрывается.
  // ======================================================================
  spawnHeli(p) {
    const m = this.map;
    let x = p.x, y = p.y;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      x = clamp(p.x + Math.cos(a) * 45, 2, m.w - 2); y = clamp(p.y + Math.sin(a) * 45, 2, m.h - 2);
      if (!this.seen(x, y, 3)) break;
    }
    const h = { id: this.nextHeli++, x, y, a: 0, hp: HELI_HP, maxHp: HELI_HP, target: p.id, orbit: Math.random() * Math.PI * 2,
      state: 'fly', nextBurst: this.room.time + 3, burst: 0, shotT: 0, shotAt: -9, fallT: 0, killer: 0 };
    this.helis.set(h.id, h);
    return h;
  }
  heliStep(h, dt) {
    const room = this.room, now = room.time, m = this.map;
    if (h.state === 'fall') {
      // сбит: крутится, падает и взрывается на месте падения; обломки - как из взорванной машины
      h.fallT += dt; h.a += dt * 7;
      h.x += Math.cos(h.a) * dt * 2.5; h.y += Math.sin(h.a) * dt * 2.5;
      if (h.fallT > 1.4) {
        this.helis.delete(h.id);
        room.ev.hx.push(h.id);
        const x = clamp(h.x, 1.5, m.w - 1.5), y = clamp(h.y, 1.5, m.h - 1.5);
        room.explode(x, y, HELI_BLAST, h.killer, -1);
        room.carLoot(x, y, h.killer);
      }
      return;
    }
    const t = room.players.get(h.target);
    if (h.state === 'fly' && (!t || !t.alive || !(t.stars >= 4))) h.state = 'leave';
    let gx, gy;
    if (h.state === 'leave') {
      // улетает от людей и исчезает, когда никто не видит
      let best = null, bd = 1e9;
      for (const p of room.players.values()) { if (p.isBot) continue; const d = Math.hypot(p.x - h.x, p.y - h.y); if (d < bd) { bd = d; best = p; } }
      if (!best || (!this.seen(h.x, h.y, 6) && bd > 30)) { this.helis.delete(h.id); room.ev.hx.push(h.id); return; }
      gx = h.x + ((h.x - best.x) / (bd || 1)) * 10; gy = h.y + ((h.y - best.y) / (bd || 1)) * 10;
    } else {
      h.orbit += dt * 0.5;
      gx = t.x + Math.cos(h.orbit) * 9; gy = t.y + Math.sin(h.orbit) * 7;
    }
    const dx = gx - h.x, dy = gy - h.y, d = Math.hypot(dx, dy);
    if (d > 0.05) {
      const sp = Math.min(14, d * 2) * dt;
      h.x = clamp(h.x + (dx / d) * sp, -30, m.w + 30); h.y = clamp(h.y + (dy / d) * sp, -30, m.h + 30);
      h.a += angDiff(Math.atan2(dy, dx), h.a) * Math.min(1, dt * 3);
    }
    // очередь из пулемёта: неметко; только когда вертолёт виден у цели на экране и цель не под крышей
    if (h.state === 'fly' && t) {
      if (h.burst <= 0 && now >= h.nextBurst && room.onScreenOf(t, h.x, h.y, 0) && !this.underRoof(t.x, t.y)) { h.burst = 6; h.nextBurst = now + rnd(3.5, 5); }
      if (h.burst > 0 && now >= h.shotT) {
        h.burst--; h.shotT = now + 0.11; h.shotAt = now;
        const dist = Math.hypot(t.x - h.x, t.y - h.y);
        const a = Math.atan2(t.y - h.y, t.x - h.x) + rnd(-0.28, 0.28); // сверху и на ходу - неметко
        room.spawnShot(h.x, h.y, a, WEAPONS[W.RIFLE], NPC_ID - K.HELI, 0, dist, 0, 1);
        if (h.burst === 5) this.noise(t.x, t.y, 12);
      }
    }
  }
  // под крышей целого дома (вертолёт сверху не видит)
  underRoof(x, y) {
    const m = this.map, tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
    const bid = m.owner[ty * m.w + tx];
    return bid >= 0 && !!m.buildings[bid] && !!m.buildings[bid].roof;
  }
  // целится ли игрок в вертолёт (точка прицела рядом с ним) - тогда стреляет вверх
  aimHeli(p) {
    if (!this.helis.size || !(p.aimD > 0)) return null;
    const ax = p.x + Math.cos(p.a) * p.aimD, ay = p.y + Math.sin(p.a) * p.aimD;
    for (const h of this.helis.values()) if (h.state !== 'fall' && Math.hypot(h.x - ax, h.y - ay) < 2.8) return h;
    return null;
  }
  heliHit(b, step, tMax) {
    let best = null, bt = tMax;
    for (const h of this.helis.values()) {
      if (h.state === 'fall' || Math.abs(h.x - b.x) > step + 2 || Math.abs(h.y - b.y) > step + 2) continue;
      const t = geom.rayCircle(b.x, b.y, b.dx, b.dy, h.x, h.y, 1.6);
      if (t >= 0 && t <= step && t < bt) { bt = t; best = h; }
    }
    return best ? { t: bt, h: best } : null;
  }
  heliDamage(h, dmg, by) {
    if (h.state === 'fall' || !(dmg > 0)) return;
    h.hp -= dmg;
    const att = by > 0 ? this.room.players.get(by) : null;
    if (att && !att.isBot) this.crime(att, 10, 'h' + h.id);
    if (h.hp > 0) return;
    h.state = 'fall'; h.fallT = 0; h.killer = by; h.burst = 0;
    this.room.ev.hf.push(h.id);
    if (att && !att.isBot) { att.copKills = (att.copKills || 0) + 1; this.room.sbDirty = true; this.crime(att, 60); }
  }
  // вертолёты рядом с игроком: [номер, x, y, курс, прочность %, флаги: 1 падает, 2 улетает, 4 стреляет, кого ловит]
  heliSnap(p, vw, vh) {
    const out = [], now = this.room.time;
    for (const h of this.helis.values()) {
      if (Math.abs(h.x - p.x) > vw || Math.abs(h.y - p.y) > vh) continue;
      out.push([h.id, r2(h.x), r2(h.y), r3(h.a), Math.max(0, Math.ceil((100 * h.hp) / h.maxHp)),
        (h.state === 'fall' ? 1 : 0) | (h.state === 'leave' ? 2 : 0) | (now - h.shotAt < 0.15 ? 4 : 0), h.target]);
    }
    return out;
  }

  // ======================================================================
  // скорая помощь
  // ======================================================================
  dispatchAmbulance() {
    const room = this.room, now = room.time;
    // в работе - скорые, у которых жив врач (в машине или у тела)
    let active = 0;
    for (const n of this.list.values()) if (n.alive && n.kind === K.MEDIC && n.ambCar && (n.state === 'incar' || n.state === 'medic')) active++;
    if (active >= AMB_CAP) return;
    let body = null;
    for (const n of this.list.values()) {
      // полицейских и врачей скорая не поднимает (иначе скорые ехали бы за скорыми)
      if (n.alive || LAW.has(n.kind) || n.kind === K.MEDIC || n.amb || now - n.deadAt < 2.5 || !this.nearHuman(n.x, n.y, 50)) continue;
      body = n; break;
    }
    if (!body) return;
    if (!room.bots.driveMask) room.bots.buildDriveMask();
    const stop = this.roadNear(body.x, body.y, 10, 3.6) || this.roadNear(body.x, body.y, 10, 0);
    if (!stop) { body.amb = -1; return; }
    const sp = this.roadSpawn(body.x, body.y, 28, 50);
    if (!sp) return;
    const v = room.vehicles.create(sp.x, sp.y, sp.a, 5, 'npc', null);
    v.kind = 'amb'; v.role = 'amb'; v.stop = stop; v.siren = true; v.pilot = {}; v.body = body.id; v.ambT = now;
    const medic = this.create(K.MEDIC, v.x, v.y, { state: 'incar', veh: v.id, hp: 80, ambCar: v.id });
    v.crew = [medic.id];
    body.amb = v.id;
  }
  ambArrived(v) {
    v.role = 'park'; v.siren = false; v.brake = true;
    const medic = this.list.get(v.crew[0]);
    if (!medic) return;
    v.crew = [];
    // выходит с той стороны машины, где лежит человек
    const c = Math.cos(v.a), s = Math.sin(v.a), body = this.list.get(v.body);
    const bx = body ? body.x : v.x, by = body ? body.y : v.y;
    let spot = null, bd = 1e9;
    for (const [dx, dy, dist] of [[s, -c, CAR.HW + 0.6], [-s, c, CAR.HW + 0.6], [-c, -s, CAR.HL + 0.6], [c, s, CAR.HL + 0.6]]) {
      const x = v.x + dx * dist, y = v.y + dy * dist;
      if (!KV.circleFree(this.map, x, y, KV.PLAYER_R)) continue;
      const d = Math.hypot(bx - x, by - y);
      if (d < bd) { bd = d; spot = [x, y]; }
    }
    const q = spot || KV.collideCircle(this.map, v.x + s * (CAR.HW + 0.6), v.y - c * (CAR.HW + 0.6), KV.PLAYER_R);
    medic.x = q[0]; medic.y = q[1]; medic.veh = 0;
    medic.state = 'medic'; medic.phase = 'toBody'; medic.body = v.body || 0; medic.path = null; medic.bestD = 1e9; medic.noProg = 0; medic.bodyT = this.room.time;
  }
  // врач: к телу, лечит 3 секунды, следующее тело рядом, потом обратно в машину
  medicStep(n, dt) {
    const room = this.room, now = room.time;
    const v = room.vehicles.list.get(n.ambCar);
    if (!v || v.dead || v.state === 'human' || v.state === 'bot') { n.kind = K.CIV; n.ambient = true; this.calm(n); return; }
    if (n.phase === 'toBody' || n.phase === 'heal') {
      let body = n.body ? this.list.get(n.body) : null;
      if (!body || body.alive) {
        body = null;
        let bd = 16;
        for (const b of this.list.values()) {
          if (b.alive || LAW.has(b.kind) || b.kind === K.MEDIC || (b.amb && b.amb > 0 && b.amb !== v.id)) continue;
          const d = Math.hypot(b.x - n.x, b.y - n.y);
          if (d < bd) { bd = d; body = b; }
        }
        if (!body) { n.phase = 'toCar'; n.path = null; return; }
        n.body = body.id; body.amb = v.id; n.phase = 'toBody'; n.path = null; n.bestD = 1e9; n.noProg = 0; n.bodyT = now;
      }
      // к телу не пройти (за стеной без прохода) - бросает его и идёт к следующему
      if (n.phase === 'toBody' && now - (n.bodyT || now) > 25) { body.amb = -1; n.body = 0; n.bodyT = now; return; }
      const d = Math.hypot(body.x - n.x, body.y - n.y);
      if (n.phase === 'toBody') {
        // подошёл вплотную - лечит; упёрся рядом (тело у стены или под машиной) - лечит оттуда
        if (d < n.bestD - 0.05) { n.bestD = d; n.noProg = 0; } else n.noProg += dt;
        if (d > 1.5 && !(d < 7 && n.noProg > 3)) this.follow(n, body.x, body.y, RUN * 0.75, dt, 4000);
        else { n.phase = 'heal'; n.until = now + 3; body.healing = true; n.a = Math.atan2(body.y - n.y, body.x - n.x); }
      } else if (now > n.until) {
        // человек встаёт и уходит
        body.alive = true; body.hp = 50; body.healing = false; body.amb = 0; body.deadAt = 0;
        body.ambient = true;
        this.calm(body);
        room.ev.rv.push([body.id]);
        n.body = 0; n.phase = 'toBody';
      }
      return;
    }
    // обратно в машину и уезжает
    if (Math.hypot(v.x - n.x, v.y - n.y) < 2.4) {
      n.state = 'incar'; n.veh = v.id; v.crew = [n.id]; v.state = 'npc'; v.role = 'leave'; v.siren = false; v.pilot = {}; v.from = [v.x, v.y];
      return;
    }
    this.follow(n, v.x, v.y, RUN * 0.6, dt, 1500);
  }

  // ======================================================================
  // футболисты: тренер и 10 игроков бегают трусцой вокруг парка
  // ======================================================================
  spawnTeam() {
    const now = this.room.time;
    if (this.team || now < this.nextTeamAt) return;
    const hs = this.humans();
    if (!hs.length) return;
    // парк рядом с кем-нибудь из игроков (если парков нет - любой квартал)
    const parks = this.loops.filter(l => l.b.kind === 'park');
    const pool = (parks.length ? parks : this.loops).filter(l => hs.some(p => Math.hypot(l.cx - p.x, l.cy - p.y) < 75));
    if (!pool.length) { this.nextTeamAt = now + 20; return; }
    const l = pool[Math.floor(Math.random() * pool.length)];
    let s0 = null;
    for (let i = 0; i < 12; i++) {
      const s = Math.random() * l.P, p = this.at(l, s, 0);
      if (!this.seen(p.x, p.y, 3)) { s0 = s; break; }
    }
    if (s0 === null) { this.nextTeamAt = now + 10; return; }
    const team = { loop: l, s: s0, dir: Math.random() < 0.5 ? 1 : -1, run: 0, members: [], cx: 0, cy: 0, farT: 0 };
    const look = Math.floor(Math.random() * 4);
    for (let i = 0; i < 11; i++) {
      const p = this.at(l, s0 - team.dir * (i ? 1.6 + Math.floor((i - 1) / 2) * 1.25 : 0), 0);
      const n = this.create(i ? K.FOOT : K.COACH, p.x, p.y, { state: 'jog', team, slot: i, look, hp: 70 });
      team.members.push(n.id);
    }
    this.team = team;
  }
  teamStep(dt) {
    const t = this.team, l = t.loop, now = this.room.time;
    t.s += t.dir * JOG * dt;
    t.run += JOG * dt;
    let cx = 0, cy = 0, cnt = 0;
    for (const id of t.members) {
      const n = this.list.get(id);
      if (!n || !n.alive) continue;
      const back = n.slot ? 1.6 + Math.floor((n.slot - 1) / 2) * 1.25 : 0;
      const lat = n.slot ? (n.slot % 2 ? 0.42 : -0.42) : 0;
      // на дорожке ящик или бочка - обегает по другой стороне тротуара
      let p = this.at(l, t.s - t.dir * (back - 0.8), lat);
      if (!KV.circleFree(this.map, p.x, p.y, 0.36)) { const q = this.at(l, t.s - t.dir * (back - 0.8), -lat || 0.45); if (KV.circleFree(this.map, q.x, q.y, 0.36)) p = q; }
      else p = this.at(l, t.s - t.dir * back, lat);
      this.step(n, p.x, p.y, JOG * 1.4, dt);
      cx += n.x; cy += n.y; cnt++;
    }
    if (cnt) { t.cx = cx / cnt; t.cy = cy / cnt; }
    // пробежали 3 круга - расходятся; рядом нет игроков - исчезают
    if (t.run > l.P * 3) { this.disband(false); return; }
    if (!this.nearHuman(t.cx, t.cy, 75)) { t.farT += dt; if (t.farT > 20) this.disband(true); } else t.farT = 0;
    void now;
  }
  // задели кого-то из команды - все разбегаются в панике
  teamPanic(x, y) {
    const t = this.team;
    if (!t) return;
    for (const id of t.members) {
      const n = this.list.get(id);
      if (!n || !n.alive) continue;
      n.team = null; n.ambient = true;
      const a = Math.atan2(n.y - y, n.x - x) + rnd(-0.8, 0.8);
      this.flee(n, n.x - Math.cos(a) * 3, n.y - Math.sin(a) * 3, rnd(6, 9));
    }
    this.team = null;
    this.nextTeamAt = this.room.time + 150 + Math.random() * 60;
  }
  disband(vanish) {
    const t = this.team;
    for (const id of t.members) {
      const n = this.list.get(id);
      if (!n) continue;
      n.team = null;
      if (vanish) this.remove(n); else { n.ambient = true; n.loop = t.loop; n.s = this.param(t.loop, n.x, n.y).s; n.dir = t.dir; n.state = 'walk'; }
    }
    this.team = null;
    this.nextTeamAt = this.room.time + 150 + Math.random() * 60;
  }

  // ======================================================================
  // для браузера
  // ======================================================================
  // [номер, x, y, угол, флаги, оружие, кто, вид, здоровье %]; флаги: 1 жив, 2 бежит, 4 выстрел, 8 лечит, 16 нападает, 32 горит
  snapFor(p, vw, vh) {
    const out = [], now = this.room.time;
    for (const n of this.list.values()) {
      if (n.state === 'incar' || Math.abs(n.x - p.x) > vw || Math.abs(n.y - p.y) > vh) continue;
      const fl = (n.alive ? 1 : 0) | (n.spd > 3 ? 2 : 0) | (now - n.shotAt < 0.15 ? 4 : 0) | (n.phase === 'heal' && n.state === 'medic' ? 8 : 0) |
        (n.state === 'fight' ? 16 : 0) | (n.burnUntil > now ? 32 : 0);
      out.push([n.id, r2(n.x), r2(n.y), r3(n.a), fl, n.w, n.kind, n.look, Math.max(0, Math.ceil((100 * n.hp) / n.maxHp))]);
    }
    return out;
  }
}

module.exports = { Npcs, K, NPC_ID, STAR_HEAT, LAW_SHOT };
