/* «Квартал»: общие константы и физика движения - один файл для сервера (Node) и браузера. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KV = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAP_W = 128;            // метров (1 клетка = 1 м)
  const MAP_H = 128;
  const PLAYER_R = 0.42;        // радиус игрока, м
  const PLAYER_SPEED = 6;       // м/с
  const VIEW_RADIUS = 15;       // сколько метров видно вокруг игрока по короткой стороне экрана
  const TICK_RATE = 30;         // тиков сервера в секунду
  const RESPAWN_DELAY = 3;      // с
  const SPAWN_PROTECT = 1.5;    // с неуязвимости после появления
  const MAX_HP = 100;
  const MAX_ARMOR = 100;

  // Земля (по ней ходят)
  const G = { GRASS: 0, ROAD: 1, WALK: 2, FLOOR: 3, RUBBLE: 4, DIRT: 5, WATER: 6, LOT: 7, BURNT: 8 };
  // Препятствия (клетки 1x1 м, у каждой своя прочность)
  const B = { NONE: 0, BORDER: 1, BRICK: 2, CONCRETE: 3, GLASS: 4, FENCE: 5, CRATE: 6, TREE: 7, BARREL: 8, CAR: 9, BENCH: 10 };

  // hp - прочность; bullet / blast - какая доля урона от пули / взрыва доходит до клетки;
  // rubble - во что превращается земля после разрушения; explode - взрыв при разрушении;
  // low - низкое препятствие: сквозь него видно (боты замечают противника)
  const BLOCKS = [];
  BLOCKS[B.BORDER] = { name: 'граница', hp: Infinity, bullet: 0, blast: 0 };
  BLOCKS[B.BRICK] = { name: 'кирпич', hp: 300, bullet: 0.5, blast: 1, rubble: G.RUBBLE };
  BLOCKS[B.CONCRETE] = { name: 'бетон', hp: 650, bullet: 0.25, blast: 0.7, rubble: G.RUBBLE };
  BLOCKS[B.GLASS] = { name: 'стекло', hp: 8, bullet: 1, blast: 1, low: true };
  BLOCKS[B.FENCE] = { name: 'забор', hp: 45, bullet: 1, blast: 1, low: true };
  BLOCKS[B.CRATE] = { name: 'ящик', hp: 70, bullet: 1, blast: 1 };
  BLOCKS[B.TREE] = { name: 'дерево', hp: 130, bullet: 0.8, blast: 1 };
  BLOCKS[B.BARREL] = { name: 'бочка', hp: 25, bullet: 1, blast: 1, low: true, explode: { r: 3.2, dmg: 75, tile: 260 } };
  BLOCKS[B.CAR] = { name: 'машина', hp: 110, bullet: 0.7, blast: 0.8, explode: { r: 4, dmg: 95, tile: 320 }, rubble: G.BURNT };
  BLOCKS[B.BENCH] = { name: 'скамейка', hp: 35, bullet: 1, blast: 1, low: true };

  const W = { FISTS: 0, PISTOL: 1, RIFLE: 2, SHOTGUN: 3, SNIPER: 4, LAUNCHER: 5 };
  // rate - выстрелов в секунду; speed - м/с; spread - разброс, рад; range - дальность, м;
  // pick - патронов в подобранном оружии; box - в коробке патронов; max - сколько можно носить
  const WEAPONS = [
    { id: 0, name: 'Кулаки', melee: true, dmg: 20, rate: 2.5, range: 1.3, tileDmg: 9 },
    { id: 1, name: 'Пистолет', dmg: 22, rate: 4, speed: 50, spread: 0.035, pellets: 1, range: 32, pick: 24, box: 36, max: 120 },
    { id: 2, name: 'Автомат', dmg: 14, rate: 10, speed: 60, spread: 0.07, pellets: 1, range: 36, pick: 60, box: 90, max: 270 },
    { id: 3, name: 'Дробовик', dmg: 11, rate: 1.1, speed: 44, spread: 0.3, pellets: 8, range: 14, pick: 10, box: 16, max: 48 },
    { id: 4, name: 'Снайперка', dmg: 95, rate: 0.7, speed: 150, spread: 0, pellets: 1, range: 75, pick: 6, box: 10, max: 30, zoom: 1.7 },
    { id: 5, name: 'Гранатомёт', grenade: true, rate: 0.8, speed: 24, spread: 0.01, pellets: 1, range: 28, blast: { r: 3.6, dmg: 110, tile: 560 }, pick: 4, box: 6, max: 16 }
  ];
  // Что и как часто появляется на карте
  const WEAPON_WEIGHTS = [[W.PISTOL, 30], [W.RIFLE, 26], [W.SHOTGUN, 20], [W.SNIPER, 12], [W.LAUNCHER, 12]];
  const PK = { WEAPON: 0, AMMO: 1, HEALTH: 2, ARMOR: 3 };

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
            // центр внутри клетки - выталкиваем по ближайшей стороне
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
    MAP_W, MAP_H, PLAYER_R, PLAYER_SPEED, VIEW_RADIUS, TICK_RATE, RESPAWN_DELAY, SPAWN_PROTECT, MAX_HP, MAX_ARMOR,
    G, B, BLOCKS, W, WEAPONS, WEAPON_WEIGHTS, PK,
    isSolid, collideCircle, moveCircle, circleFree, segmentClear, damageStage, rleEncode, rleDecode
  };
});
