'use strict';
/* Физика машин на сервере: удар, толкание с газом, разворот от удара в угол, водитель-NPC выскакивает от сильного удара. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { CAR } = KV;

// ровная площадка без препятствий, чтобы считать чистую физику
function flatRoom() {
  const room = new Room('phys' + Math.random().toString(36).slice(2, 6));
  for (const id of [...room.players.keys()]) room.players.delete(id);
  for (const v of [...room.vehicles.list.values()]) room.vehicles.remove(v);
  room.map.block.fill(0);
  room.map.ground.fill(KV.G.ROAD);
  for (let x = 0; x < room.map.w; x++) { room.map.block[x] = KV.B.BORDER; room.map.block[(room.map.h - 1) * room.map.w + x] = KV.B.BORDER; }
  for (let y = 0; y < room.map.h; y++) { room.map.block[y * room.map.w] = KV.B.BORDER; room.map.block[y * room.map.w + room.map.w - 1] = KV.B.BORDER; }
  room.vehicles.nextTrafficAt = 1e9; // без новых машин с водителями
  return room;
}
const DT = 1 / KV.TICK_RATE;
const step = (room, n) => { for (let i = 0; i < n; i++) { room.time += DT; room.vehicles.update(DT); } };

// 1. удар в лоб: стоящая машина отлетает, ударившая замедляется
{
  const room = flatRoom();
  const a = room.vehicles.create(40, 60, 0, 1, 'parked', null);
  const b = room.vehicles.create(45, 60, 0, 2, 'parked', null);
  a.v = 12;
  step(room, 20);
  console.log(`удар 12 м/с: ударившая ${a.v.toFixed(1)} м/с, стоявшая сдвинулась на ${(b.x - 45).toFixed(1)} м`);
  assert.ok(b.x - 45 > 2, 'стоящая машина отлетела');
  assert.ok(a.v < 8, 'ударившая потеряла скорость');
  assert.ok(b.hp < CAR.HP, 'от сильного удара есть урон');
}

// 2. толкание с газом: бот упирается и продолжает толкать
{
  const room = flatRoom();
  const bot = room.createPlayer('Толкач (бот)', true);
  bot.alive = true; bot.hp = 100;
  const a = room.vehicles.create(40, 60, 0, 1, 'parked', null);
  const b = room.vehicles.create(44.2, 60, 0, 2, 'parked', null);
  a.state = 'bot'; a.driver = bot.id; bot.vehicle = a.id; bot.ai = room.bots.initAi(bot);
  room.bots.driveControl = () => [1, 0]; // газ в пол, прямо
  step(room, 90);
  console.log(`3 с газа в упор: толкаемая машина уехала на ${(b.x - 44.2).toFixed(1)} м, толкающая на ${(a.x - 40).toFixed(1)} м`);
  assert.ok(b.x - 44.2 > 5, 'машина с газом толкает другую');
  assert.ok(Math.abs(b.y - 60) < 1.5, 'толкает по прямой');
}

// 3. удар в угол - разворот
{
  const room = flatRoom();
  const a = room.vehicles.create(40, 60, 0, 1, 'parked', null);
  const b = room.vehicles.create(44.3, 61.6, Math.PI / 2, 2, 'parked', null);
  a.v = 12;
  const a0 = b.a;
  step(room, 15);
  console.log(`удар в угол: стоявшую развернуло на ${((b.a - a0) * 180 / Math.PI).toFixed(0)}°`);
  assert.ok(Math.abs(b.a - a0) > 0.2, 'от удара не по центру машину разворачивает');
}

// 4. машина с водителем-NPC: лёгкий толчок - едет дальше, сильный - водитель выскакивает
{
  const room = flatRoom();
  const t = room.vehicles.create(60, 60, 0, 3, 'traffic', null);
  t.ai = null;
  room.vehicles.updateTraffic = () => {}; // в тесте NPC стоит на месте
  const soft = room.vehicles.create(60, 63.2, -Math.PI / 2, 1, 'parked', null);
  soft.v = 2; // лёгкий толчок
  step(room, 15);
  assert.strictEqual(t.state, 'traffic', 'от лёгкого толчка водитель остаётся');
  const hard = room.vehicles.create(60, 56.0, Math.PI / 2, 1, 'parked', null);
  hard.v = 12; // сильный удар
  let fled = false;
  for (let i = 0; i < 15; i++) { step(room, 1); if (t.state !== 'traffic') fled = true; }
  console.log(`водитель-NPC после сильного удара: ${fled ? 'выскочил' : 'остался'}, машину сдвинуло на ${Math.hypot(t.x - 60, t.y - 60).toFixed(1)} м`);
  assert.ok(fled, 'от сильного удара водитель выскакивает');
}

// 5. никакая машина после ударов не стоит в стене
{
  const room = new Room('phys-walls');
  for (const id of [...room.players.keys()]) room.players.delete(id);
  const cars = [...room.vehicles.list.values()].filter(v => v.state === 'parked');
  for (const v of cars) { v.v = 10 * (Math.random() - 0.5) * 2; v.sx = 6 * (Math.random() - 0.5); v.sy = 6 * (Math.random() - 0.5); }
  step(room, 150);
  let bad = 0;
  for (const v of room.vehicles.list.values()) if (v.state !== 'traffic' && KV.carHitsHard(room.map, v.x, v.y, v.a, 0.2)) bad++;
  console.log(`разогнали ${cars.length} стоящих машин в случайные стороны: в стене ${bad}`);
  assert.strictEqual(bad, 0, 'машины не влезают в стены');
}
// ручник (18.11.2026): на ходу с поворотом - машина тормозит, кузов разворачивает круче, появляется боковой занос
{
  const open = { w: 300, h: 300, block: new Uint8Array(300 * 300), ground: new Uint8Array(300 * 300) };
  const run = hand => { const c = { x: 150, y: 150, a: 0, v: 15, sx: 0, sy: 0, w: 0 }; for (let t = 0; t < 0.6; t += 1 / 30) KV.stepVehicle(open, c, 0, 1, 1 / 30, null, hand); return c; };
  const plain = run(false), hb = run(true);
  const slide = Math.hypot(hb.sx, hb.sy);
  console.log(`ручник: курс ${hb.a.toFixed(2)} против ${plain.a.toFixed(2)}, скорость ${hb.v.toFixed(1)} против ${plain.v.toFixed(1)}, занос ${slide.toFixed(1)} м/с`);
  assert.ok(hb.a > plain.a * 1.3 && Math.abs(hb.v) < Math.abs(plain.v) - 3 && slide > 2, 'ручник: тормозит, разворачивает круче, уводит в занос');
}

console.log('carphys: OK');
