'use strict';
/* Лучи по клеткам карты (пули, видимость) и пересечение луча с кругом (попадание в игрока). */
const KV = require('../public/shared.js');
const { B, BLOCKS } = KV;

// Первая клетка с препятствием на луче из (x0,y0) в направлении (dx,dy) (единичный вектор) не дальше maxT.
// skip(blockType) -> true, если клетку надо пропустить (например, сквозь стекло видно).
function raycast(map, x0, y0, dx, dy, maxT, skip) {
  let tx = Math.floor(x0), ty = Math.floor(y0);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = dx > 0 ? (tx + 1 - x0) * tDeltaX : dx < 0 ? (x0 - tx) * tDeltaX : Infinity;
  let tMaxY = dy > 0 ? (ty + 1 - y0) * tDeltaY : dy < 0 ? (y0 - ty) * tDeltaY : Infinity;
  for (let guard = 0; guard < 4096; guard++) {
    let t;
    if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; tx += stepX; }
    else { t = tMaxY; tMaxY += tDeltaY; ty += stepY; }
    if (t > maxT) return null;
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return { t, k: -1 };
    const k = ty * map.w + tx;
    const b = map.block[k];
    if (b !== B.NONE && !(skip && skip(b))) return { t, k };
  }
  return null;
}

// Расстояние вдоль луча до круга или -1
function rayCircle(x0, y0, dx, dy, cx, cy, r) {
  const fx = x0 - cx, fy = y0 - cy;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

// Расстояние вдоль луча до повёрнутого прямоугольника (машины) или -1. Начало луча внутри - 0.
function rayOBB(x0, y0, dx, dy, cx, cy, a, hl, hw) {
  const c = Math.cos(a), s = Math.sin(a);
  const ox = x0 - cx, oy = y0 - cy;
  const l = [ox * c + oy * s, -ox * s + oy * c];
  const d = [dx * c + dy * s, -dx * s + dy * c];
  const h = [hl, hw];
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 2; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (Math.abs(l[i]) > h[i]) return -1; continue; }
    let t1 = (-h[i] - l[i]) / d[i], t2 = (h[i] - l[i]) / d[i];
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  return tmin >= 0 ? tmin : 0;
}

const seeThrough = b => !!(BLOCKS[b] && BLOCKS[b].low);

// Есть ли прямая видимость. lowTransparent - сквозь низкие препятствия и стекло видно.
function losClear(map, x0, y0, x1, y1, lowTransparent) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  if (d < 1e-6) return true;
  return !raycast(map, x0, y0, (x1 - x0) / d, (y1 - y0) / d, d, lowTransparent ? seeThrough : null);
}

module.exports = { raycast, rayCircle, rayOBB, losClear };
