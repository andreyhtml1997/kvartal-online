'use strict';
/* Проверка генератора: 60 разных карт - граница цела, всё проходимое достижимо, хватает точек появления. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { generateMap } = require('../game/mapgen');
const { G, B } = KV;

let worstReach = 1, totalMs = 0, minSpawns = Infinity, minBuildings = Infinity, cars = 0, waterMaps = 0;
for (let seed = 1; seed <= 60; seed++) {
  const t0 = process.hrtime.bigint();
  const m = generateMap(seed * 7919);
  totalMs += Number(process.hrtime.bigint() - t0) / 1e6;
  const { w, h } = m;
  for (let x = 0; x < w; x++) { assert.strictEqual(m.block[x], B.BORDER); assert.strictEqual(m.block[(h - 1) * w + x], B.BORDER); }
  for (let y = 0; y < h; y++) { assert.strictEqual(m.block[y * w], B.BORDER); assert.strictEqual(m.block[y * w + w - 1], B.BORDER); }
  let walk = 0, reach = 0, water = 0;
  for (let k = 0; k < w * h; k++) {
    if (m.ground[k] === G.WATER) water++;
    if (m.block[k] === B.NONE && m.ground[k] !== G.WATER) { walk++; if (m.reach[k]) reach++; }
    if (m.block[k] !== B.NONE) assert.ok(m.hp[k] > 0, 'у препятствия должна быть прочность');
  }
  if (water) waterMaps++;
  worstReach = Math.min(worstReach, reach / walk);
  minSpawns = Math.min(minSpawns, m.spawnTiles.length);
  minBuildings = Math.min(minBuildings, m.buildings.length);
  cars += m.carSpawns.length;
  for (const c of m.carSpawns) assert.ok(!KV.carHitsHard(m, c.x, c.y, c.a, 0.05), "машина на парковке стоит в стене");
  for (let k = 0; k < w * h; k++) if (m.ground[k] === G.ROAD) assert.strictEqual(m.block[k], B.NONE, "дорога свободна для машин");
  for (const k of m.spawnTiles) assert.notStrictEqual(m.ground[k], G.ROAD, "не появляемся на дороге");
  for (const b of m.buildings) {
    assert.ok(b.walls > 0, 'у дома есть стены');
    // в каждый дом можно зайти: хотя бы одна клетка пола внутри достижима
    let inside = 0;
    for (let j = b.y + 1; j < b.y + b.h - 1; j++) for (let i = b.x + 1; i < b.x + b.w - 1; i++) if (m.reach[j * w + i]) inside++;
    assert.ok(inside > 0, `в дом ${b.id} карты ${seed} нельзя зайти`);
  }
  for (const k of m.spawnTiles) assert.ok(KV.circleFree(m, (k % w) + 0.5, Math.floor(k / w) + 0.5, KV.PLAYER_R));
}
console.log(`карт: 60, средняя генерация ${(totalMs / 60).toFixed(1)} мс, худшая достижимость ${(worstReach * 100).toFixed(2)}%,` +
  ` мин. точек появления ${minSpawns}, мин. домов ${minBuildings}, машин в среднем ${(cars / 60).toFixed(1)}, карт с прудами ${waterMaps}`);
assert.ok(worstReach > 0.97, 'слишком много недостижимых мест');
assert.ok(minSpawns > 200, 'мало точек появления');
assert.ok(minBuildings >= 6, 'мало домов');
console.log('mapgen: OK');
