'use strict';
/*
 * Огнемёт, бензопила, бочки, машины (ракета поджигает, горящая под огнём взрывается быстрее, взрывная волна
 * отбрасывает машины, лут из машин, сидящего внутри пулей не убить, давить проще), гриб, кувырок.
 */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { W, B, PK, CAR } = KV;
const DT = 1 / KV.TICK_RATE;

// ровная площадка без людей и машин
function flatRoom() {
  const room = new Room('wpn' + Math.random().toString(36).slice(2, 6));
  room.botsOn = false;
  for (const id of [...room.players.keys()]) room.players.delete(id);
  for (const v of [...room.vehicles.list.values()]) room.vehicles.remove(v);
  for (const id of [...room.pickups.keys()]) room.pickups.delete(id);
  const m = room.map;
  m.block.fill(0); m.ground.fill(KV.G.ROAD); m.hp.fill(0);
  for (let x = 0; x < m.w; x++) { m.block[x] = B.BORDER; m.block[(m.h - 1) * m.w + x] = B.BORDER; }
  for (let y = 0; y < m.h; y++) { m.block[y * m.w] = B.BORDER; m.block[y * m.w + m.w - 1] = B.BORDER; }
  room.vehicles.nextTrafficAt = 1e9;
  room.nextWeaponAt = room.nextSupplyAt = room.nextShroomAt = room.nextCrateAt = 1e9;
  return room;
}
function person(room, name, bot, x, y, a) {
  const p = room.createPlayer(name, bot);
  Object.assign(p, { x, y, a: a || 0, alive: true, hp: 100, ar: 0, prot: 0 });
  return p;
}
function setTile(room, tx, ty, t) {
  const k = ty * room.map.w + tx;
  room.map.block[k] = t; room.map.hp[k] = KV.BLOCKS[t].hp;
  return k;
}
// такт без ИИ ботов: стрельба, пули, огонь, машины, отложенные взрывы, вещи
function step(room, sec) {
  const n = Math.round(sec / DT);
  for (let i = 0; i < n; i++) {
    room.time += DT;
    for (const p of room.players.values()) room.updateFiring(p);
    room.updateBullets(); room.updateBurning(); room.updateTileFires();
    room.vehicles.update(DT); room.updatePending(); room.updatePickups();
  }
}
const arm = (p, w) => { p.ammo[w] = KV.WEAPONS[w].max || 1; p.cur = w; };

assert.strictEqual(KV.emptyAmmo().length, KV.WEAPONS.length, 'набор оружия на все виды');
assert.strictEqual(KV.WEAPONS.length, 14, 'четырнадцать видов оружия: с огнемётом, пилой, миниганом, дробовиками, узи, гранатами и щитом');

// 1. огнемёт: человек загорается и горит дальше
{
  const room = flatRoom();
  const s = person(room, 'Поджигатель', false, 40, 60, 0), t = person(room, 'Цель', true, 43, 60);
  arm(s, W.FLAMER); s.fire = true;
  step(room, 0.5);
  s.fire = false;
  const hp1 = t.hp, burning = t.burnUntil > room.time;
  step(room, 2);
  console.log(`огнемёт: за 0.5 с струи здоровье ${hp1.toFixed(0)}, горит: ${burning}, через 2 с горения ${t.alive ? t.hp.toFixed(0) : 'погиб'}`);
  assert.ok(hp1 < 85 && burning, 'струя огнемёта бьёт и поджигает');
  assert.ok(!t.alive || t.hp < hp1 - 15, 'горящий теряет здоровье и без струи');
}

// 2. огнемёт: забор загорается и сгорает
{
  const room = flatRoom();
  const s = person(room, 'Поджигатель', false, 40.5, 50.5, 0);
  const k = setTile(room, 42, 50, B.FENCE);
  arm(s, W.FLAMER); s.fire = true;
  step(room, 0.3);
  s.fire = false;
  const lit = room.tileFires.has(k) || room.map.block[k] === 0;
  step(room, 3);
  console.log(`огнемёт по забору: загорелся ${lit}, сгорел ${room.map.block[k] === 0}`);
  assert.ok(lit && room.map.block[k] === 0, 'деревянное сгорает');
}

// 3. бензопила режет бетон и кирпич почти мгновенно
{
  const room = flatRoom();
  const s = person(room, 'Пильщик', false, 40.5, 70.5, 0);
  const kc = setTile(room, 41, 70, B.CONCRETE);
  arm(s, W.SAW); s.fire = true;
  let t = 0;
  while (room.map.block[kc] && t < 2) { step(room, DT); t += DT; }
  console.log(`пила: бетон распилен за ${t.toFixed(2)} с`);
  assert.ok(room.map.block[kc] === 0 && t < 1, 'пила режет бетон');
  const kb = setTile(room, 41, 70, B.BRICK);
  t = 0;
  while (room.map.block[kb] && t < 2) { step(room, DT); t += DT; }
  console.log(`пила: кирпич распилен за ${t.toFixed(2)} с`);
  assert.ok(room.map.block[kb] === 0 && t < 1, 'пила режет кирпич');
}

// 4. бензопила по человеку
{
  const room = flatRoom();
  const s = person(room, 'Пильщик', false, 40.5, 72.5, 0), t = person(room, 'Цель', true, 41.5, 72.5);
  arm(s, W.SAW); s.fire = true;
  step(room, 1);
  console.log(`пила по человеку за 1 с: ${t.alive ? 'здоровье ' + t.hp.toFixed(0) : 'погиб'}`);
  assert.ok(!t.alive, 'пила убивает в упор за секунду');
}

// 5. один выстрел по бочке - взрыв
{
  const room = flatRoom();
  const s = person(room, 'Стрелок', false, 40.5, 80.5, 0);
  const k = setTile(room, 46, 80, B.BARREL);
  arm(s, W.RIFLE); s.fireLatch = true; s.latchAt = room.time;
  step(room, 0.6);
  const shots = KV.WEAPONS[W.RIFLE].max - s.ammo[W.RIFLE];
  console.log(`бочка: выстрелов ${shots}, бочка цела: ${room.map.block[k] === B.BARREL}, взрывов ${room.ev.x.length}`);
  assert.ok(shots === 1 && room.map.block[k] === 0 && room.ev.x.length >= 1, 'бочка взрывается от одного выстрела');
}

// 6. ракета по машине: сильный урон, но машина прочная, как раньше - сразу не загорается
{
  const room = flatRoom();
  const car = room.vehicles.create(60, 30, 0, 1, 'parked', null);
  const s = person(room, 'Гранатомётчик', false, 52, 30, 0);
  arm(s, W.LAUNCHER); s.fireLatch = true; s.latchAt = room.time;
  step(room, 0.6);
  console.log(`ракета по машине: прочность ${Math.round(car.hp)} из ${CAR.HP}, горит ${car.burn > 0}`);
  assert.ok(car.hp < CAR.HP * 0.4 && car.burn <= 0 && !car.dead, 'ракета сильно бьёт, но с одного попадания машина не горит');
}

// 7. по горящей машине стреляют - взрывается быстрее; 8. сидящего внутри пулей не убить
{
  const room = flatRoom();
  const a = room.vehicles.create(80, 30, 0, 1, 'parked', null);
  const b = room.vehicles.create(80, 60, 0, 1, 'parked', null);
  const drv = person(room, 'Водитель', false, 80, 31.6);
  assert.ok(room.vehicles.enter(drv, a.id), 'водитель сел');
  const s = person(room, 'Стрелок', false, 72, 30, 0);
  arm(s, W.RIFLE); s.fire = true;
  step(room, 0.8);
  const hpInside = drv.hp;
  room.vehicles.ignite(a, s.id); room.vehicles.ignite(b, 0);
  let ta = null, tb = null, t = 0;
  while ((ta === null || tb === null) && t < 8) { step(room, DT); t += DT; if (ta === null && a.dead) ta = t; if (tb === null && b.dead) tb = t; }
  console.log(`сидящий внутри после очереди по машине: здоровье ${hpInside}; горящая под огнём взорвалась за ${ta && ta.toFixed(2)} с, без огня за ${tb && tb.toFixed(2)} с; водитель ${drv.alive ? 'жив' : 'погиб при взрыве'}`);
  assert.strictEqual(hpInside, 100, 'пули по машине не ранят сидящего внутри');
  assert.ok(ta !== null && ta < 2.5 && tb !== null && tb > 3.5, 'горящая машина под огнём взрывается быстрее');
  assert.ok(!drv.alive, 'взрыв машины убивает сидящего внутри');
}

// 9. взрывная волна отбрасывает машины (и с водителем-NPC), из взорванных машин выпадает лут
{
  const room = flatRoom();
  const boom = room.vehicles.create(60, 90, 0, 1, 'parked', null);
  const near = room.vehicles.create(65, 90, 0, 2, 'parked', null);
  const npc = room.vehicles.create(60, 95.5, 0, 3, 'traffic', null);
  npc.ai = null; room.vehicles.updateTraffic = () => {};
  const n0 = { x: near.x, y: near.y }, c0 = { x: npc.x, y: npc.y };
  room.vehicles.explodeVehicle(boom);
  step(room, 1.5);
  const dNear = Math.hypot(near.x - n0.x, near.y - n0.y), dNpc = Math.hypot(npc.x - c0.x, npc.y - c0.y);
  console.log(`взрыв машины: соседнюю отбросило на ${dNear.toFixed(1)} м, машину с водителем на ${dNpc.toFixed(1)} м (${npc.state})`);
  assert.ok(dNear > 1.5, 'взрывная волна отбрасывает стоящую машину');
  assert.ok(dNpc > 1 && npc.state !== 'traffic', 'и машину с водителем');
  let loot = 0;
  for (let i = 0; i < 10; i++) {
    const before = room.pickups.size;
    room.vehicles.explodeVehicle(room.vehicles.create(20 + i * 9, 20, 0, 1, 'parked', null));
    loot += room.pickups.size - before;
  }
  console.log(`из 10 взорванных машин выпало вещей: ${loot}`);
  assert.ok(loot >= 6, 'из взорванных машин выпадает лут');
}

// 10. машина сбила человека: урон по скорости, как раньше (4 м/с - 24, на 15 м/с - 90)
{
  const room = flatRoom();
  const car = room.vehicles.create(40, 100, 0, 1, 'parked', null);
  const t = person(room, 'Пешеход', true, 42.6, 100);
  car.v = 4;
  step(room, 0.3);
  console.log(`машина 4 м/с сбила человека: здоровье ${t.alive ? t.hp.toFixed(0) : 'погиб'}`);
  assert.ok(t.alive && t.hp >= 70 && t.hp <= 80, 'урон от машины как раньше');
}

// 11. гриб: 10 секунд эффекта
{
  const room = flatRoom();
  const p = person(room, 'Грибник', false, 30, 30);
  room.addPickup(PK.SHROOM, 0, 30.3, 30, 1);
  room.updatePickups();
  console.log(`гриб: эффект до ${(p.tripUntil - room.time).toFixed(1)} с`);
  assert.ok(Math.abs(p.tripUntil - room.time - KV.TRIP) < 0.01, 'съеденный гриб действует 10 секунд');
}

// 12. кувырок: выпрыгнул на скорости - около секунды катится и не стреляет
{
  const room = flatRoom();
  const car = room.vehicles.create(30, 110, 0, 1, 'parked', null);
  const p = person(room, 'Каскадёр', false, 30, 111.6);
  assert.ok(room.vehicles.enter(p, car.id), 'сел');
  car.v = 14;
  room.vehicles.exit(p, false);
  arm(p, W.PISTOL); p.fire = true;
  const rolling = p.rollUntil - room.time;
  step(room, 0.5);
  const shotsInRoll = KV.WEAPONS[W.PISTOL].max - p.ammo[W.PISTOL];
  step(room, 0.8);
  const shotsAfter = KV.WEAPONS[W.PISTOL].max - p.ammo[W.PISTOL];
  console.log(`кувырок: ${rolling.toFixed(1)} с, выстрелов во время кувырка ${shotsInRoll}, после ${shotsAfter}`);
  assert.ok(Math.abs(rolling - KV.ROLL.TIME) < 0.01 && shotsInRoll === 0 && shotsAfter > 0, 'катится секунду, потом встаёт и стреляет');
  const car2 = room.vehicles.create(30, 120, 0, 1, 'parked', null);
  const q = person(room, 'Тихоход', false, 30, 121.6);
  room.vehicles.enter(q, car2.id);
  car2.v = 5;
  room.vehicles.exit(q, false);
  assert.ok(q.rollUntil <= room.time, 'на малой скорости не катится');
}
console.log('weapons: OK');
