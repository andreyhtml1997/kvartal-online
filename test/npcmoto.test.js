'use strict';
/* Мотоциклы у жителей и полиции (18.11.2026): в потоке каждый пятый - мотоциклист; каждый третий выезд полиции -
   мотоцикл с одним копом, он стреляет на ходу; житель или коп слетает с мотоцикла от пули, сильного удара или взрывной
   волны (ранен или погиб), мотоцикл остаётся - его можно забрать; игрок с мотоцикла не слетает. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { K, NPC_ID, STAR_HEAT } = require('../game/npcs');
const { W, WEAPONS, CAR } = KV;
const DT = 1 / KV.TICK_RATE;

class FakeWs { constructor() { this.readyState = 1; this.bufferedAmount = 0; } send() {} }
const room = new Room('nmoto' + Math.random().toString(36).slice(2, 6));
room.botsOn = false;
const me = room.addHuman(new FakeWs(), 'Наблюдатель');
room.fillBots();
me.prot = 0; me.view = [30, 18];
const V = room.vehicles, N = room.npcs;

// 1. поток: каждый пятый - мотоцикл
for (const v of [...V.list.values()]) if (v.state === 'traffic') V.remove(v);
V.trafficN = 0;
let made = 0;
for (let i = 0; i < 40 && made < 15; i++) if (V.spawnTraffic(true)) made++;
const traffic = [...V.list.values()].filter(v => v.state === 'traffic');
const motos = traffic.filter(v => v.moto);
console.log(`поток: машин ${traffic.length}, из них мотоциклов ${motos.length}; снимок вида ${motos[0] ? V.snap(motos[0])[10] : '-'}`);
assert.ok(motos.length === Math.floor(traffic.length / 5) && motos.length >= 2 && V.snap(motos[0])[10] === 5, 'в потоке каждый пятый - мотоцикл');

// 2. пуля по мотоциклисту-жителю: слетает, мотоцикл остаётся и его можно угнать
const m1 = motos[0];
const civ0 = N.list.size;
// стрелок - на встречной полосе той же дороги, в 2.2 м сбоку (там точно нет стены)
room.teleport(me, m1.x + Math.sin(m1.a) * 2.2, m1.y - Math.cos(m1.a) * 2.2);
const ang = Math.atan2(m1.y - me.y, m1.x - me.x);
room.spawnShot(me.x, me.y, ang, WEAPONS[W.PISTOL], me.id, 0, 6);
for (let k = 0; k < 8; k++) { room.time += DT; room.updateBullets(); }
const fallen = [...N.list.values()].filter(n => n.kind === K.CIV && Math.hypot(n.x - m1.x, n.y - m1.y) < 4);
console.log(`выстрел по мотоциклисту: мотоцикл ${m1.state}, рядом жителей ${fallen.length} (живых ${fallen.filter(n => n.alive).length}), здоровье ${fallen.map(n => Math.round(n.hp)).join(',')}`);
assert.ok(m1.state === 'parked' && fallen.length >= 1 && fallen.some(n => n.hp < 70 || !n.alive), 'пуля сбивает жителя с мотоцикла и ранит');
room.teleport(me, m1.x + KV.MOTO_BOX.hw + 0.8, m1.y);
assert.ok(V.enter(me, m1.id), 'брошенный мотоцикл можно забрать');
V.exit(me, true);

// 3. сильный удар машиной: житель слетает
const m2 = motos[1];
const car = V.create(m2.x - Math.cos(m2.a) * 6, m2.y - Math.sin(m2.a) * 6, m2.a, 2, 'parked', null);
room.time += 1;
V.crash(car, m2, 14, 0);
console.log(`таран 14 м/с: мотоцикл ${m2.state}`);
assert.ok(m2.state === 'parked', 'от сильного удара житель слетает с мотоцикла');
V.remove(car);

// 4. полиция: каждый третий выезд - мотоцикл с одним копом
for (const v of [...V.list.values()]) if (v.state === 'traffic') V.remove(v);
N.crime(me, STAR_HEAT[2] + 1);
me.x = Math.round(room.map.w / 2) + 0.5; me.y = room.map.roads.y[2][0] + 2;
const seen = new Set();
for (let i = 0; i < 30; i++) {
  room.time += 1.5; N.dispatchPolice();
  for (const v of V.list.values()) if (v.state === 'npc' && v.role === 'police') seen.add(v);
  // освобождаем лимит: выехавших убираем, чтобы посчитать выезды
  for (const v of [...V.list.values()]) if (v.state === 'npc' && v.role === 'police') { for (const id of v.crew || []) { const n = N.list.get(id); if (n) N.remove(n); } V.remove(v); }
}
const units = [...seen];
const pm = units.filter(v => v.kind === 'pmoto');
console.log(`выездов полиции ${units.length}: мотоциклов ${pm.length}, в каждом копов ${pm.map(v => (v.crew || []).length).join(',')}; вид в снимке ${pm[0] ? V.snap(pm[0])[10] : '-'}`);
assert.ok(units.length >= 6 && Math.abs(pm.length - Math.floor(units.length / 3)) <= 1 && V.snap(pm[0])[10] === 6, 'каждый третий выезд - полицейский мотоцикл');

// 5. коп на мотоцикле стреляет на ходу
room.time += 1.5; N.dispatchPolice();
let cop = [...V.list.values()].find(v => v.kind === 'pmoto' && v.state === 'npc');
for (let i = 0; i < 6 && !cop; i++) {
  for (const v of [...V.list.values()]) if (v.state === 'npc' && v.role === 'police' && v.kind !== 'pmoto') { for (const id of v.crew || []) { const n = N.list.get(id); if (n) N.remove(n); } V.remove(v); }
  room.time += 1.5; N.dispatchPolice();
  cop = [...V.list.values()].find(v => v.kind === 'pmoto' && v.state === 'npc');
}
assert.ok(cop, 'полицейский мотоцикл выехал');
// ставим его в 14 м от игрока на открытой дороге, едет к нему
cop.x = me.x - 14; cop.y = me.y; cop.a = 0; cop.v = 6;
const shots = [];
const sp0 = room.spawnShot.bind(room);
room.spawnShot = (x, y, a, w, owner, ...rest) => { if (owner === NPC_ID - K.COP) shots.push(owner); return sp0(x, y, a, w, owner, ...rest); };
for (let i = 0; i < 2.5 * KV.TICK_RATE && cop.state === 'npc' && Math.hypot(cop.x - me.x, cop.y - me.y) > 11.5; i++) {
  room.time += DT; const c = N.pilot(cop, DT); if (cop.state === 'npc') V.physics(cop, c[0], c[1], DT, 0);
}
room.spawnShot = sp0;
console.log(`коп на мотоцикле: выстрелов на ходу ${shots.length}`);
assert.ok(shots.length >= 1, 'коп на мотоцикле стреляет на ходу');

// 6. взрывная волна сбрасывает копа
if (cop.state === 'npc') {
  room.explode(cop.x + 1.5, cop.y, KV.CAR_BLAST, me.id, W.LAUNCHER);
  console.log(`взрыв в 1.5 м: мотоцикл ${cop.state}`);
  assert.ok(cop.state !== 'npc', 'взрыв сбрасывает копа с мотоцикла');
}

console.log('npcmoto: OK');
