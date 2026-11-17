'use strict';
/* Прогон комнаты без сети: живой «игрок»-заглушка + боты + машины, 3 минуты игрового времени. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { TRAFFIC_TARGET } = require('../game/vehicles');
const { G, CAR } = KV;

class FakeWs {
  constructor() { this.readyState = 1; this.bufferedAmount = 0; this.msgs = []; this.bytes = 0; }
  send(s) { this.bytes += s.length; this.msgs.push(JSON.parse(s)); }
}

const room = new Room('test1');
const ws = new FakeWs();
const me = room.addHuman(ws, 'Тест');
assert.ok(me, 'игрок добавлен');
assert.strictEqual(ws.msgs[0].t, 'welcome');
const welcomeBytes = JSON.stringify(ws.msgs[0]).length;
assert.strictEqual(room.humanCount(), 1);
assert.strictEqual(room.players.size, 4, 'боты добрали до 4');
const traffic0 = [...room.vehicles.list.values()].filter(v => v.state === 'traffic');
assert.ok(traffic0.length >= TRAFFIC_TARGET - 2, `машины с водителями на месте (${traffic0.length})`);
const parked0 = [...room.vehicles.list.values()].filter(v => v.state === 'parked').length;

// «игрок» стоит на месте и стреляет по ближайшему боту из пистолета
me.ammo[KV.W.PISTOL] = 500;
const travel = new Map();
const last = new Map();
const stats = { kills: 0, tiles: 0, destroyed: 0, roofs: 0, carsBlown: 0, carHits: 0, horns: 0, entered: 0, pickups: 0, picked: 0, explosions: 0, bullets: 0, cratesNew: 0 };
const T = 180 * KV.TICK_RATE;
let offRoad = 0, trafficSamples = 0, overlapsHard = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < T; i++) {
  if (me.alive) {
    let best = null, bd = 1e9;
    for (const p of room.players.values()) if (p !== me && p.alive) { const d = Math.hypot(p.x - me.x, p.y - me.y); if (d < bd) { bd = d; best = p; } }
    if (best) { me.a = Math.atan2(best.y - me.y, best.x - me.x); me.cur = me.ammo[KV.W.PISTOL] > 0 ? KV.W.PISTOL : 0; me.fire = bd < 25; }
  }
  room.tick();
  for (const p of room.players.values()) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'координаты конечны');
    if (p.alive && p.isBot && !p.vehicle) assert.ok(KV.circleFree(room.map, p.x, p.y, KV.PLAYER_R * 0.8), `бот ${p.name} застрял в стене`);
  }
  for (const v of room.vehicles.list.values()) {
    assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.a), 'машина: координаты конечны');
    const l = last.get(v.id);
    if (l) travel.set(v.id, (travel.get(v.id) || 0) + Math.hypot(v.x - l[0], v.y - l[1]));
    last.set(v.id, [v.x, v.y]);
    if (v.state === 'traffic') {
      trafficSamples++;
      const g = room.map.ground[Math.floor(v.y) * room.map.w + Math.floor(v.x)];
      if (g !== G.ROAD) offRoad++;
    }
    if (v.state !== 'traffic' && KV.carHitsHard(room.map, v.x, v.y, v.a, 0.2)) overlapsHard++;
  }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
for (const m of ws.msgs) {
  if (m.t !== 'e') continue;
  stats.kills += (m.k || []).length;
  stats.tiles += (m.tl || []).length;
  stats.destroyed += (m.tl || []).filter(e => e.length === 5).length;
  stats.cratesNew += (m.tl || []).filter(e => e.length === 4 && e[1] === KV.B.CRATE && e[2] === 0).length;
  stats.roofs += (m.rf || []).length;
  stats.carsBlown += (m.vx || []).length;
  stats.carHits += (m.ck || []).length;
  stats.horns += (m.hn || []).length;
  stats.entered += (m.en || []).length;
  stats.pickups += (m.pa || []).length;
  stats.picked += (m.pu || []).length;
  stats.explosions += (m.x || []).length;
  stats.bullets += (m.b || []).length;
}
const snaps = ws.msgs.filter(m => m.t === 's');
const trafficTravel = [...travel.entries()].filter(([id]) => traffic0.some(v => v.id === id)).map(([, d]) => d);
const avgTravel = trafficTravel.reduce((a, b) => a + b, 0) / Math.max(1, trafficTravel.length);
console.log(`180 с игры за ${ms.toFixed(0)} мс (${(ms / T).toFixed(3)} мс на такт); стартовая карта ${(welcomeBytes / 1024).toFixed(1)} КБ;` +
  ` трафик ${(ws.bytes / 1024 / 180).toFixed(1)} КБ/с; снимков ${snaps.length}`);
console.log(`машин на парковках ${parked0}, с водителями ${TRAFFIC_TARGET}; средний пробег машины с водителем ${avgTravel.toFixed(0)} м;` +
  ` вне дороги ${(100 * offRoad / Math.max(1, trafficSamples)).toFixed(2)}%; машин в стене ${overlapsHard}`);
console.log(JSON.stringify(stats));
const trafficEnd = [...room.vehicles.list.values()].filter(v => v.state === 'traffic').length;
console.log(`машин с водителями в конце: ${trafficEnd} из ${TRAFFIC_TARGET}`);
assert.ok(trafficEnd >= TRAFFIC_TARGET - 3, 'машины с водителями появляются снова');
assert.ok(snaps.length > 2500, 'снимки идут 15 раз в секунду');
assert.ok(snaps.some(s => s.c && s.c.length > 0), 'в снимках есть машины');
assert.ok(stats.bullets > 30, 'стреляют');
assert.ok(stats.kills > 0, 'кто-то погиб');
assert.ok(stats.destroyed > 0, 'клетки разрушаются');
assert.ok(stats.pickups >= 10, 'оружие появляется');
assert.ok(stats.picked > 0, 'оружие подбирают');
assert.ok(avgTravel > 300, 'машины с водителями ездят, а не стоят');
assert.ok(offRoad / Math.max(1, trafficSamples) < 0.01, 'машины с водителями едут по дорогам');
assert.strictEqual(overlapsHard, 0, 'ни одна машина не въехала в стену');
assert.ok(ms / T < 3, 'такт укладывается в бюджет');

// посадка в машину и выход
// берём карту, где есть хотя бы одна машина на парковке (бывают карты совсем без парковок)
let room2, car;
for (let i = 0; i < 20 && !car; i++) { room2 = new Room('test2-' + i); car = [...room2.vehicles.list.values()].find(v => v.state === 'parked'); }
assert.ok(car, 'нашлась карта с машиной на парковке');
const ws2 = new FakeWs();
const p2 = room2.addHuman(ws2, 'Водитель');
const side = KV.pushOutOBB(car.x + Math.sin(car.a) * 1.4, car.y - Math.cos(car.a) * 1.4, KV.PLAYER_R, car.x, car.y, car.a, CAR.HL, CAR.HW) || [car.x + Math.sin(car.a) * 1.4, car.y - Math.cos(car.a) * 1.4];
p2.x = side[0]; p2.y = side[1]; p2.prot = 0;
assert.ok(room2.vehicles.enter(p2, car.id), 'сел в машину на парковке');
assert.strictEqual(p2.vehicle, car.id);
assert.ok(ws2.msgs.some(m => m.t === 'car' && m.id === car.id), 'браузер узнал, что он за рулём');
// едем 1 метр вперёд - сервер принимает
room2.tick();
const nx = car.x + Math.cos(car.a) * 0.3, ny = car.y + Math.sin(car.a) * 0.3;
room2.onMessage(p2, { t: 'i', a: 0, f: 0, c: [nx, ny, car.a, 9, car.tp] });
assert.ok(Math.hypot(car.x - nx, car.y - ny) < 1e-6, 'сервер принял положение машины');
// попытка «телепортироваться» машиной - откат
room2.tick();
room2.onMessage(p2, { t: 'i', a: 0, f: 0, c: [car.x + 30, car.y, car.a, 9, car.tp] });
assert.ok(ws2.msgs.some(m => m.t === 'ctp'), 'обман со скоростью машины откатывается');
assert.ok(room2.vehicles.exit(p2, true), 'вышел из машины');
assert.strictEqual(p2.vehicle, 0);

// удаление игрока убирает и ботов (комната засыпает)
room.removePlayer(me.id);
assert.strictEqual(room.humanCount(), 0);
assert.strictEqual(room.players.size, 0, 'без людей боты не нужны');
console.log('sim: OK');
