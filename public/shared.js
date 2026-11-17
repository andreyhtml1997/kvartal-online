/* «Квартал»: общие константы и физика (люди и машины) - один файл для сервера (Node) и браузера. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KV = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAP_W = 128;            // метров (1 клетка = 1 м)
  const MAP_H = 128;
  const PLAYER_R = 0.42;        // радиус игрока, м
  const PLAYER_SPEED = 8;       // м/с, обычный бег
  const SPRINT_SPEED = 11.5;    // м/с, рывок
  const STAMINA = { MAX: 100, DRAIN: 28, REGEN: 20, DELAY: 0.7, START: 15 }; // в секунду; DELAY - пауза перед восстановлением
  const VIEW_RADIUS = 11;       // сколько метров видно вокруг игрока по короткой стороне экрана
  const TICK_RATE = 30;         // тиков сервера в секунду
  const RESPAWN_DELAY = 3;      // с
  const SPAWN_PROTECT = 1.5;    // с неуязвимости после появления
  const MAX_HP = 100;
  const MAX_ARMOR = 100;

  // Земля (по ней ходят)
  const G = { GRASS: 0, ROAD: 1, WALK: 2, FLOOR: 3, RUBBLE: 4, DIRT: 5, WATER: 6, LOT: 7, BURNT: 8 };
  // Препятствия (клетки 1x1 м, у каждой своя прочность). CAR оставлен для совместимости: машины теперь отдельные объекты.
  const B = { NONE: 0, BORDER: 1, BRICK: 2, CONCRETE: 3, GLASS: 4, FENCE: 5, CRATE: 6, TREE: 7, BARREL: 8, CAR: 9, BENCH: 10 };

  // hp - прочность; bullet / blast - какая доля урона от пули / взрыва доходит до клетки;
  // rubble - во что превращается земля после разрушения; explode - взрыв при разрушении;
  // low - низкое препятствие: сквозь него видно (боты замечают противника)
  const BLOCKS = [];
  // crumble - разрушенная клетка трескает соседние такого же типа (дыры в стенах расширяются)
  BLOCKS[B.BORDER] = { name: 'граница', hp: Infinity, bullet: 0, blast: 0 };
  BLOCKS[B.BRICK] = { name: 'кирпич', hp: 110, bullet: 0.65, blast: 1, rubble: G.RUBBLE, crumble: 0.3 };
  BLOCKS[B.CONCRETE] = { name: 'бетон', hp: 240, bullet: 0.35, blast: 0.8, rubble: G.RUBBLE, crumble: 0.2 };
  BLOCKS[B.GLASS] = { name: 'стекло', hp: 6, bullet: 1, blast: 1, low: true };
  BLOCKS[B.FENCE] = { name: 'забор', hp: 28, bullet: 1, blast: 1, low: true };
  BLOCKS[B.CRATE] = { name: 'ящик', hp: 40, bullet: 1, blast: 1 };
  BLOCKS[B.TREE] = { name: 'дерево', hp: 90, bullet: 0.8, blast: 1 };
  BLOCKS[B.BARREL] = { name: 'бочка', hp: 25, bullet: 1, blast: 1, low: true, explode: { r: 3.2, dmg: 75, tile: 260 } };
  BLOCKS[B.CAR] = { name: 'машина', hp: 110, bullet: 0.7, blast: 0.8, explode: { r: 4, dmg: 95, tile: 320 }, rubble: G.BURNT };
  BLOCKS[B.BENCH] = { name: 'скамейка', hp: 24, bullet: 1, blast: 1, low: true };

  const W = { FISTS: 0, PISTOL: 1, RIFLE: 2, SHOTGUN: 3, SNIPER: 4, LAUNCHER: 5, FLAMER: 6, SAW: 7 };
  // rate - выстрелов в секунду; speed - м/с; spread - разброс, рад; range - дальность, м;
  // pick - патронов в подобранном оружии; box - в коробке патронов; max - сколько можно носить
  const WEAPONS = [
    { id: 0, name: 'Кулаки', melee: true, dmg: 20, rate: 2.5, range: 1.3, tileDmg: 16 },
    { id: 1, name: 'Пистолет', dmg: 22, rate: 4, speed: 50, spread: 0.035, pellets: 1, range: 32, pick: 24, box: 36, max: 120 },
    { id: 2, name: 'Автомат', dmg: 14, rate: 10, speed: 60, spread: 0.07, pellets: 1, range: 36, pick: 60, box: 90, max: 270 },
    { id: 3, name: 'Дробовик', dmg: 11, rate: 1.1, speed: 44, spread: 0.3, pellets: 8, range: 14, pick: 10, box: 16, max: 48 },
    { id: 4, name: 'Снайперка', dmg: 95, rate: 0.7, speed: 150, spread: 0, pellets: 1, range: 75, pick: 6, box: 10, max: 30, zoom: 1.7 },
    { id: 5, name: 'Гранатомёт', grenade: true, rate: 0.8, speed: 24, spread: 0.01, pellets: 1, range: 28, blast: { r: 3.6, dmg: 110, tile: 560 }, pick: 4, box: 6, max: 16 },
    // огнемёт: короткая струя проходит сквозь людей и поджигает их (burn - сколько секунд горит), деревянное сгорает, машины загораются
    { id: 6, name: 'Огнемёт', flame: true, dmg: 5, rate: 14, speed: 14, spread: 0.12, pellets: 1, range: 6.5, burn: 3, pick: 120, box: 150, max: 300 },
    // бензопила: держишь - пилит в упор; режет любые стены (кроме границы карты) и машины; патроны - бензин
    { id: 7, name: 'Бензопила', melee: true, saw: true, dmg: 14, rate: 9, range: 1.5, tileDmg: 75, carDmg: 30, pick: 150, box: 150, max: 300 }
  ];
  // Что и как часто появляется на карте
  const WEAPON_WEIGHTS = [[W.PISTOL, 30], [W.RIFLE, 26], [W.SHOTGUN, 20], [W.SNIPER, 12], [W.LAUNCHER, 12], [W.FLAMER, 11], [W.SAW, 11]];
  const PK = { WEAPON: 0, AMMO: 1, HEALTH: 2, ARMOR: 3, SHROOM: 4 };
  const TRIP = 10;                          // с: сколько действует съеденный гриб
  const ROLL = { SPEED: 7.5, TIME: 1.0 };  // выпрыгнул из машины быстрее SPEED м/с - катится по дороге TIME секунд
  // пустой набор оружия: кулаки есть всегда, остального нет (-1)
  const emptyAmmo = () => WEAPONS.map((w, i) => (i === 0 ? 0 : -1));

  // ---------- машины ----------
  // HL/HW - половина длины/ширины, MAX - м/с вперёд, REV - назад, ACCEL/BRAKE - м/с², ROLL - накат без газа,
  // DRAG - сопротивление, STEER - рад/с на скорости, HP - прочность, FIRE - сколько секунд горит до взрыва
  const CAR = { HL: 2.0, HW: 0.95, MAX: 21, REV: 7, ACCEL: 14, BRAKE: 26, ROLL: 3, DRAG: 0.3, STEER: 3.0, HP: 220, FIRE: 4, ENTER: 1.7 };
  const CAR_BLAST = { r: 4, dmg: 95, tile: 320 };
  // Лёгкие препятствия, которые машина на скорости проламывает
  const RAMMABLE = [];
  [B.FENCE, B.CRATE, B.BENCH, B.BARREL, B.GLASS].forEach(t => { RAMMABLE[t] = true; });
  const RAM_SPEED = 4;

  function isSolid(map, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
    const k = ty * map.w + tx;
    return map.block[k] !== B.NONE || map.ground[k] === G.WATER;
  }

  // Выталкивает круг из твёрдых клеток. Возвращает [x, y].
  function collideCircle(map, x, y, r) {
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
      const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (!isSolid(map, tx, ty)) continue;
          const cx = Math.max(tx, Math.min(x, tx + 1));
          const cy = Math.max(ty, Math.min(y, ty + 1));
          const dx = x - cx, dy = y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          if (d2 > 1e-10) {
            const d = Math.sqrt(d2);
            const push = r - d + 1e-4;
            x += (dx / d) * push;
            y += (dy / d) * push;
          } else {
            const left = x - tx, right = tx + 1 - x, top = y - ty, bottom = ty + 1 - y;
            const m = Math.min(left, right, top, bottom);
            if (m === left) x = tx - r - 1e-4;
            else if (m === right) x = tx + 1 + r + 1e-4;
            else if (m === top) y = ty - r - 1e-4;
            else y = ty + 1 + r + 1e-4;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
    return [x, y];
  }

  // Движение круга со скольжением вдоль стен; шаги не длиннее 0.3 м, чтобы не проскакивать сквозь клетку.
  function moveCircle(map, x, y, dx, dy, r) {
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-9) return collideCircle(map, x, y, r);
    const steps = Math.max(1, Math.ceil(dist / 0.3));
    let p = [x, y];
    for (let s = 0; s < steps; s++) p = collideCircle(map, p[0] + dx / steps, p[1] + dy / steps, r);
    return p;
  }

  function circleFree(map, x, y, r) {
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
    const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!isSolid(map, tx, ty)) continue;
        const cx = Math.max(tx, Math.min(x, tx + 1));
        const cy = Math.max(ty, Math.min(y, ty + 1));
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < r * r) return false;
      }
    }
    return true;
  }

  // Можно ли пройти кругом радиуса r по прямой из (x0,y0) в (x1,y1)
  function segmentClear(map, x0, y0, x1, y1, r) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(d / 0.2));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (!circleFree(map, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r)) return false;
    }
    return true;
  }

  // ---------- геометрия машин (повёрнутый прямоугольник) ----------
  // Насколько вытолкнуть машину A, чтобы она не пересекала клетку (tx,ty). null - не пересекает.
  function obbTileMTV(cx, cy, c, s, hl, hw, tx, ty) {
    const dx = tx + 0.5 - cx, dy = ty + 0.5 - cy;
    let best = Infinity, bx = 0, by = 0;
    for (let i = 0; i < 4; i++) {
      const ax = i === 0 ? 1 : i === 1 ? 0 : i === 2 ? c : -s;
      const ay = i === 0 ? 0 : i === 1 ? 1 : i === 2 ? s : c;
      const rc = hl * Math.abs(c * ax + s * ay) + hw * Math.abs(-s * ax + c * ay);
      const rt = 0.5 * (Math.abs(ax) + Math.abs(ay));
      const d = dx * ax + dy * ay;
      const o = rc + rt - Math.abs(d);
      if (o <= 0) return null;
      if (o < best) { best = o; const sg = d > 0 ? -1 : 1; bx = ax * sg * o; by = ay * sg * o; }
    }
    return [bx, by];
  }

  // Насколько вытолкнуть машину A из машины B (обе одного размера). null - не пересекаются.
  function obbObbMTV(ax, ay, aa, bx, by, ba, hl, hw) {
    const ca = Math.cos(aa), sa = Math.sin(aa), cb = Math.cos(ba), sb = Math.sin(ba);
    const dx = bx - ax, dy = by - ay;
    if (dx * dx + dy * dy > 4 * (hl * hl + hw * hw)) return null;
    let best = Infinity, mx = 0, my = 0;
    for (let i = 0; i < 4; i++) {
      const ux = i === 0 ? ca : i === 1 ? -sa : i === 2 ? cb : -sb;
      const uy = i === 0 ? sa : i === 1 ? ca : i === 2 ? sb : cb;
      const ra = hl * Math.abs(ca * ux + sa * uy) + hw * Math.abs(-sa * ux + ca * uy);
      const rb = hl * Math.abs(cb * ux + sb * uy) + hw * Math.abs(-sb * ux + cb * uy);
      const d = dx * ux + dy * uy;
      const o = ra + rb - Math.abs(d);
      if (o <= 0) return null;
      if (o < best) { best = o; const sg = d > 0 ? -1 : 1; mx = ux * sg * o; my = uy * sg * o; }
    }
    return [mx, my];
  }

  // Выталкивает круг (человека) из машины. Возвращает новые [x, y] или null, если не пересекаются.
  function pushOutOBB(x, y, r, cx, cy, a, hl, hw) {
    const c = Math.cos(a), s = Math.sin(a);
    const dx = x - cx, dy = y - cy;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    if (Math.abs(lx) > hl + r || Math.abs(ly) > hw + r) return null;
    const qx = Math.max(-hl, Math.min(hl, lx)), qy = Math.max(-hw, Math.min(hw, ly));
    const ex = lx - qx, ey = ly - qy;
    const d2 = ex * ex + ey * ey;
    if (d2 >= r * r) return null;
    let nlx, nly;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      nlx = lx + (ex / d) * (r - d + 1e-3);
      nly = ly + (ey / d) * (r - d + 1e-3);
    } else if (hl - Math.abs(lx) < hw - Math.abs(ly)) {
      nlx = (lx >= 0 ? 1 : -1) * (hl + r + 1e-3); nly = ly;
    } else {
      nlx = lx; nly = (ly >= 0 ? 1 : -1) * (hw + r + 1e-3);
    }
    return [cx + nlx * c - nly * s, cy + nlx * s + nly * c];
  }

  function distToOBB(x, y, cx, cy, a, hl, hw) {
    const c = Math.cos(a), s = Math.sin(a);
    const dx = x - cx, dy = y - cy;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    return Math.hypot(Math.max(0, Math.abs(lx) - hl), Math.max(0, Math.abs(ly) - hw));
  }

  // Для машины твёрдое всё, кроме пустой клетки; вода тоже. Лёгкие препятствия проламываются на скорости.
  function carSolidAt(map, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return B.BORDER;
    const k = ty * map.w + tx;
    if (map.block[k] !== B.NONE) return map.block[k];
    return map.ground[k] === G.WATER ? B.BORDER : 0;
  }

  // Стоит ли машина на твёрдом (не проламываемом) препятствии; shrink - допуск
  function carHitsHard(map, x, y, a, shrink) {
    const c = Math.cos(a), s = Math.sin(a);
    const hl = CAR.HL - shrink, hw = CAR.HW - shrink;
    for (let ty = Math.floor(y - 2.3); ty <= Math.floor(y + 2.3); ty++) {
      for (let tx = Math.floor(x - 2.3); tx <= Math.floor(x + 2.3); tx++) {
        const t = carSolidAt(map, tx, ty);
        if (!t || RAMMABLE[t]) continue;
        if (obbTileMTV(x, y, c, s, hl, hw, tx, ty)) return true;
      }
    }
    return false;
  }

  // Клетки с лёгкими препятствиями под машиной
  function carOverlapTiles(map, x, y, a, shrink, out) {
    const c = Math.cos(a), s = Math.sin(a);
    const hl = CAR.HL - shrink, hw = CAR.HW - shrink;
    for (let ty = Math.floor(y - 2.3); ty <= Math.floor(y + 2.3); ty++) {
      for (let tx = Math.floor(x - 2.3); tx <= Math.floor(x + 2.3); tx++) {
        const t = carSolidAt(map, tx, ty);
        if (!t || !RAMMABLE[t] || t === B.BORDER) continue;
        if (obbTileMTV(x, y, c, s, hl, hw, tx, ty)) out.push(ty * map.w + tx);
      }
    }
    return out;
  }

  // Пересекает ли машина хоть одно препятствие (кроме уже проломленных клеток из ignore)
  function carOverlapsSolid(map, x, y, a, shrink, ignore) {
    const c = Math.cos(a), s = Math.sin(a);
    const hl = CAR.HL - shrink, hw = CAR.HW - shrink;
    for (let ty = Math.floor(y - 2.3); ty <= Math.floor(y + 2.3); ty++) {
      for (let tx = Math.floor(x - 2.3); tx <= Math.floor(x + 2.3); tx++) {
        if (!carSolidAt(map, tx, ty)) continue;
        if (ignore && ignore.has(ty * map.w + tx)) continue;
        if (obbTileMTV(x, y, c, s, hl, hw, tx, ty)) return true;
      }
    }
    return false;
  }

  /*
   * Один шаг физики машины. car: {x, y, a, v, sx, sy, w}; v - скорость вдоль кузова, (sx, sy) - занос,
   * w - вращение от ударов (рад/с); throttle и steer от -1 до 1.
   * ignore - Set клеток, которые уже проломлены (ещё не подтверждены сервером).
   * Возвращает { impact: сила удара о твёрдое, rammed: [проломленные клетки] }.
   */
  function stepVehicle(map, car, throttle, steer, dt, ignore) {
    const px = car.x, py = car.y, pa = car.a;
    if (!car.w) car.w = 0;
    if (throttle > 0) car.v += (car.v < 0 ? CAR.BRAKE : CAR.ACCEL) * throttle * dt;
    else if (throttle < 0) car.v += (car.v > 0 ? CAR.BRAKE : CAR.ACCEL * 0.6) * throttle * dt;
    else { const r = CAR.ROLL * dt; car.v = Math.abs(car.v) <= r ? 0 : car.v - Math.sign(car.v) * r; }
    car.v -= car.v * CAR.DRAG * dt;
    if (car.v > CAR.MAX) car.v = CAR.MAX;
    if (car.v < -CAR.REV) car.v = -CAR.REV;
    const sf = car.v / (Math.abs(car.v) + 2.5);
    car.a += (steer * CAR.STEER * sf + car.w) * dt;
    car.w *= Math.exp(-2.5 * dt);
    if (Math.abs(car.w) < 0.01) car.w = 0;
    const fr = Math.exp(-3.5 * dt);
    car.sx *= fr; car.sy *= fr;
    const c0 = Math.cos(car.a), s0 = Math.sin(car.a);
    const mx = (c0 * car.v + car.sx) * dt, my = (s0 * car.v + car.sy) * dt;
    const n = Math.max(1, Math.ceil(Math.hypot(mx, my) / 0.25));
    const res = { impact: 0, rammed: [] };
    const ign = ignore || new Set();
    for (let i = 0; i < n; i++) {
      car.x += mx / n; car.y += my / n;
      resolveCarTiles(map, car, res, ign);
    }
    // зажало между препятствиями и вытолкнуть не вышло - шаг отменяется, машина остаётся где была
    if (carOverlapsSolid(map, car.x, car.y, car.a, 0.03, ign) && !carOverlapsSolid(map, px, py, pa, 0.03, ign)) {
      car.x = px; car.y = py; car.a = pa;
      car.v = 0; car.sx = 0; car.sy = 0; car.w = 0;
    }
    if (res.impact > 2) car.w *= 0.5;
    return res;
  }

  // ---------- столкновения машин между собой ----------
  // Толчок (jx, jy) в точке (px, py): меняет скорость и закручивает машину, если удар не по центру
  function applyImpulse(car, jx, jy, px, py) {
    const c = Math.cos(car.a), s = Math.sin(car.a);
    const vx = c * car.v + car.sx + jx, vy = s * car.v + car.sy + jy;
    car.v = vx * c + vy * s;
    car.sx = vx - c * car.v;
    car.sy = vy - s * car.v;
    const rx = px - car.x, ry = py - car.y;
    car.w = (car.w || 0) + ((rx * jy - ry * jx) / 1.65) * 0.6; // 1.65 - момент инерции кузова 4x1.9 м
    if (car.w > 4) car.w = 4;
    if (car.w < -4) car.w = -4;
  }

  // Ближайшая к точке (x, y) точка кузова машины - туда приходится удар
  function carContactPoint(car, x, y) {
    const c = Math.cos(car.a), s = Math.sin(car.a);
    const dx = x - car.x, dy = y - car.y;
    const lx = Math.max(-CAR.HL, Math.min(CAR.HL, dx * c + dy * s));
    const ly = Math.max(-CAR.HW, Math.min(CAR.HW, -dx * s + dy * c));
    return [car.x + lx * c - ly * s, car.y + lx * s + ly * c];
  }

  /*
   * Удар двух машин по законам импульса (массы равны, упругость 0.3) + разворот от удара не по центру.
   * a и b - машины {x, y, a, v, sx, sy, w}; bvx, bvy - скорость b вектором.
   * opts.aOnly - менять только a (вторую машину посчитает её владелец: сервер или браузер другого игрока);
   * opts.bStatic - b не сдвигается (как стена): a получает весь толчок и всё раздвигание.
   * Возвращает null или { impact: скорость сближения, jx, jy: толчок для b, px, py: точка удара на b }.
   */
  function carCollide(a, b, bvx, bvy, opts) {
    const o = opts || {};
    const mtv = obbObbMTV(a.x, a.y, a.a, b.x, b.y, b.a, CAR.HL, CAR.HW);
    if (!mtv) return null;
    const ml = Math.hypot(mtv[0], mtv[1]) || 1e-6;
    const nx = mtv[0] / ml, ny = mtv[1] / ml; // от b к a
    const shareA = o.bStatic ? 1 : 0.5;
    a.x += mtv[0] * shareA; a.y += mtv[1] * shareA;
    if (!o.aOnly && !o.bStatic) { b.x -= mtv[0] * 0.5; b.y -= mtv[1] * 0.5; }
    const ca = Math.cos(a.a), sa = Math.sin(a.a);
    const avx = ca * a.v + a.sx, avy = sa * a.v + a.sy;
    const rel = (avx - bvx) * nx + (avy - bvy) * ny;
    if (rel >= 0) return null;
    const jFull = -1.3 * rel;
    const j = o.bStatic ? jFull : jFull / 2;
    const pa = carContactPoint(a, b.x, b.y);
    applyImpulse(a, nx * j, ny * j, pa[0], pa[1]);
    const pb = carContactPoint(b, a.x, a.y);
    if (!o.aOnly && !o.bStatic) applyImpulse(b, -nx * j, -ny * j, pb[0], pb[1]);
    return { impact: -rel, jx: o.bStatic ? 0 : -nx * j, jy: o.bStatic ? 0 : -ny * j, px: pb[0], py: pb[1] };
  }

  function resolveCarTiles(map, car, res, ign) {
    for (let iter = 0; iter < 5; iter++) {
      const c = Math.cos(car.a), s = Math.sin(car.a);
      let hit = false;
      for (let ty = Math.floor(car.y - 2.3); ty <= Math.floor(car.y + 2.3); ty++) {
        for (let tx = Math.floor(car.x - 2.3); tx <= Math.floor(car.x + 2.3); tx++) {
          const t = carSolidAt(map, tx, ty);
          if (!t) continue;
          const k = ty * map.w + tx;
          if (ign.has(k)) continue;
          const mtv = obbTileMTV(car.x, car.y, c, s, CAR.HL, CAR.HW, tx, ty);
          if (!mtv) continue;
          if (RAMMABLE[t] && Math.abs(car.v) > RAM_SPEED) { ign.add(k); res.rammed.push(k); car.v *= 0.9; continue; }
          car.x += mtv[0]; car.y += mtv[1];
          const ml = Math.hypot(mtv[0], mtv[1]) || 1;
          const nx = mtv[0] / ml, ny = mtv[1] / ml;
          const vx = c * car.v + car.sx, vy = s * car.v + car.sy;
          const into = -(vx * nx + vy * ny);
          if (into > 0) {
            res.impact = Math.max(res.impact, into);
            car.v *= into > 4 ? 0.2 : 0.55;
            const sd = car.sx * nx + car.sy * ny;
            if (sd < 0) { car.sx -= nx * sd; car.sy -= ny * sd; }
          }
          hit = true;
        }
      }
      if (!hit) break;
    }
  }

  // Вытолкнуть машину из стен (например, после столкновения с другой машиной)
  function resolveCar(map, car, ignore) {
    const res = { impact: 0, rammed: [] };
    resolveCarTiles(map, car, res, ignore || new Set());
    return res;
  }

  // Управление «куда наклонил джойстик - туда и едем»: из направления (jx, jy) получаем газ и руль
  function steerToward(car, jx, jy) {
    const m = Math.hypot(jx, jy);
    if (m < 0.15) return [0, 0];
    const want = Math.atan2(jy, jx);
    const diff = Math.atan2(Math.sin(want - car.a), Math.cos(want - car.a));
    if (Math.abs(diff) < 1.75) return [1, Math.max(-1, Math.min(1, diff * 2.5))];
    if (car.v > 1) return [-1, 0];
    const back = Math.atan2(Math.sin(want + Math.PI - car.a), Math.cos(want + Math.PI - car.a));
    return [-1, -Math.max(-1, Math.min(1, back * 2.5))];
  }

  // 0 - целая, 1..3 - всё сильнее повреждена
  function damageStage(hp, max) {
    if (!(max < Infinity) || max <= 0) return 0;
    const f = hp / max;
    return f > 0.75 ? 0 : f > 0.5 ? 1 : f > 0.25 ? 2 : 3;
  }

  function rleEncode(arr) {
    const out = [];
    let prev = arr[0], n = 1;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === prev && n < 65535) n++;
      else { out.push(prev, n); prev = arr[i]; n = 1; }
    }
    out.push(prev, n);
    return out;
  }

  function rleDecode(list, len) {
    const a = new Uint8Array(len);
    let p = 0;
    for (let i = 0; i + 1 < list.length && p < len; i += 2) {
      const n = Math.min(list[i + 1], len - p);
      a.fill(list[i], p, p + n);
      p += n;
    }
    return a;
  }

  return {
    MAP_W, MAP_H, PLAYER_R, PLAYER_SPEED, SPRINT_SPEED, STAMINA, VIEW_RADIUS, TICK_RATE, RESPAWN_DELAY, SPAWN_PROTECT, MAX_HP, MAX_ARMOR,
    G, B, BLOCKS, W, WEAPONS, WEAPON_WEIGHTS, PK, TRIP, ROLL, emptyAmmo, CAR, CAR_BLAST, RAMMABLE, RAM_SPEED,
    isSolid, collideCircle, moveCircle, circleFree, segmentClear,
    obbTileMTV, obbObbMTV, pushOutOBB, distToOBB, carSolidAt, carHitsHard, carOverlapTiles, carOverlapsSolid, stepVehicle, resolveCar, steerToward,
    applyImpulse, carContactPoint, carCollide,
    damageStage, rleEncode, rleDecode
  };
});
