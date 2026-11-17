'use strict';
/* Мотоциклы (17.11.2026): 4-6 на карте (у больницы, у оружейного, на стоянках); быстрее машины (27 м/с) и вертлявее,
   узкий - проезжает в проход шириной в клетку; водитель сидит открыто - его ранят пули и взрывы, но с мотоцикла
   он не вылетает и от аварий не ранится (решение владельца); бак взрывается слабее машины; взорванный мотоцикл
   со стоянки появляется снова. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { W, G, B, WEAPONS, CAR, VEH, CAR_BLAST } = KV;
const DT = 1 / KV.TICK_RATE;

// ---------- 1. физика на пустой площадке: скорость, разгон, руль, узкий проход ----------
function flat(w, h) {
  const m = { w, h, block: new Uint8Array(w * h), ground: new Uint8Array(w * h).fill(G.ROAD) };
  for (let x = 0; x < w; x++) { m.block[x] = B.BORDER; m.block[(h - 1) * w + x] = B.BORDER; }
  for (let y = 0; y < h; y++) { m.block[y * w] = B.BORDER; m.block[y * w + w - 1] = B.BORDER; }
  return m;
}
const mk = moto => Object.assign({ x: 20, y: 100, a: 0, v: 0, sx: 0, sy: 0, w: 0 }, moto ? { moto: true, maxV: VEH.moto.maxV, acc: VEH.moto.acc, steer: VEH.moto.steer } : {});
const field = flat(400, 200);
const car = mk(false), moto = mk(true);
let carTo20 = 0, motoTo20 = 0;
for (let t = 0; t < 6; t += DT) {
  KV.stepVehicle(field, car, 1, 0, DT, null); KV.stepVehicle(field, moto, 1, 0, DT, null);
  if (!carTo20 && car.v >= 20) carTo20 = t;
  if (!motoTo20 && moto.v >= 20) motoTo20 = t;
}
console.log(`скорость: машина ${car.v.toFixed(1)} м/с (до 20 за ${carTo20.toFixed(2)} с), мотоцикл ${moto.v.toFixed(1)} м/с (до 20 за ${motoTo20.toFixed(2)} с)`);
assert.ok(moto.v > 26 && moto.v <= 27.01 && car.v <= 21.01, 'мотоцикл разгоняется до 27 м/с, машина - до 21');
assert.ok(motoTo20 < carTo20 * 0.8, 'мотоцикл разгоняется заметно быстрее');
const turn = mo => { const c = mk(mo); c.v = 12; for (let t = 0; t < 0.5; t += DT) KV.stepVehicle(field, c, 0.3, 1, DT, null); return c.a; };
const tc = turn(false), tm = turn(true);
console.log(`поворот за 0.5 с на 12 м/с: машина ${tc.toFixed(2)} рад, мотоцикл ${tm.toFixed(2)} рад`);
assert.ok(tm > tc * 1.3, 'мотоцикл поворачивает круче машины');
// стена с проходом в одну клетку: мотоцикл проезжает, машина - нет
const gap = flat(60, 60);
for (let x = 1; x < 59; x++) if (x !== 30) gap.block[30 * 60 + x] = B.BRICK;
const pass = mo => { const c = Object.assign(mk(mo), { x: 30.5, y: 40, a: -Math.PI / 2 }); for (let t = 0; t < 3; t += DT) KV.stepVehicle(gap, c, 0.5, 0, DT, null); return c.y; };
const yc = pass(false), ym = pass(true);
console.log(`проход шириной в клетку: машина остановилась у y=${yc.toFixed(1)}, мотоцикл доехал до y=${ym.toFixed(1)}`);
assert.ok(ym < 27 && yc > 31, 'мотоцикл проезжает в узкий проход, машина в него не помещается');

// ---------- 2. живая комната ----------
class FakeWs { constructor() { this.readyState = 1; this.bufferedAmount = 0; this.msgs = []; } send(s) { if (/^\{"t":"(car|fall|ctp)"/.test(s)) this.msgs.push(JSON.parse(s)); } }
const room = new Room('moto' + Math.random().toString(36).slice(2, 6));
room.botsOn = false;
const ws = new FakeWs();
const me = room.addHuman(ws, 'Байкер');
const att = room.addHuman(new FakeWs(), 'Стрелок');
room.fillBots();
const V = room.vehicles, m = room.map;
me.prot = 0; att.prot = 0;
const spawns = m.carSpawns.filter(c => c.moto);
const motos = [...V.list.values()].filter(v => v.moto && v.spawn); // стоящие на стоянках (в потоке тоже ездят мотоциклисты)
console.log(`на карте мотоциклов: ${motos.length} (у больницы и оружейного ${spawns.filter(s => m.shops.some(q => (q.kind === 'med' || q.kind === 'gun') && Math.hypot(q.x - s.x, q.y - s.y) < 9)).length})`);
assert.ok(motos.length >= 4 && motos.length <= 6 && motos.every(v => v.kind === 'moto'), 'на карте 4-6 мотоциклов');
assert.ok(motos.every(v => V.snap(v)[10] === 5 && v.maxHp === VEH.moto.hp), 'в снимке вид 5, своя прочность');
// убираем поток машин - не мешают пулям и проверкам
for (const v of [...V.list.values()]) if (v.state === 'traffic') V.remove(v);

// мотоцикл поперёк горизонтальной дороги
const road = m.roads.y[1];
const x0 = Math.round(m.w / 2) + 0.5, y0 = road[0] + 2;
const bike = V.setKind(V.create(x0, y0, Math.PI / 2, 3, 'parked', null), 'moto');
const board = () => { room.teleport(me, x0 + 1.2, y0); ws.msgs.length = 0; return V.enter(me, bike.id); };
assert.ok(board(), 'сел на мотоцикл');
assert.ok(ws.msgs.some(q => q.t === 'car' && q.kind === 5), 'браузер узнал, что это мотоцикл');

// пули: мотоциклиста ранят, водителя в машине - нет (там кузов)
function volley(target) {
  room.teleport(att, target.x + 5, target.y);
  const hp0 = me.hp;
  for (let i = 0; i < 3; i++) {
    room.spawnShot(att.x - 0.6, att.y, Math.PI, WEAPONS[W.PISTOL], att.id, 0, 5);
    for (let k = 0; k < 6; k++) { room.time += DT; room.updateBullets(); }
  }
  return hp0 - me.hp;
}
const lostOnBike = volley(bike);
V.exit(me, true); me.hp = 100;
const carV = V.create(x0, y0, Math.PI / 2, 2, 'parked', null);
V.remove(bike);
room.teleport(me, x0 + 1.6, y0);
assert.ok(V.enter(me, carV.id), 'сел в машину');
const carHp0 = carV.hp;
const lostInCar = volley(carV);
console.log(`3 пули сбоку: мотоциклист потерял ${lostOnBike.toFixed(0)} здоровья, водитель машины ${lostInCar.toFixed(0)} (машине досталось ${(carHp0 - carV.hp).toFixed(0)})`);
assert.ok(lostOnBike >= 2 * WEAPONS[W.PISTOL].dmg && lostInCar === 0 && carV.hp < carHp0, 'на мотоцикле водителя видно и ранят, в машине прикрывает кузов');
V.exit(me, true); V.remove(carV);

// удары: о стену на полном ходу и таран машиной - игрок не вылетает и от аварии не ранится, ломается только мотоцикл
// (решение владельца 17.11.2026: «игроки не вылетают из машины при столкновении»)
const bike2 = V.setKind(V.create(x0, y0, Math.PI / 2, 4, 'parked', null), 'moto');
room.teleport(me, x0 + 1.2, y0); me.hp = 100;
assert.ok(V.enter(me, bike2.id), 'сел на второй мотоцикл');
const bikeHp0 = bike2.hp;
room.time += 1; V.onCrash(me, { s: 25 });
const ram = V.create(x0 + 30, y0, 0, 1, 'parked', null);
ram.driver = att.id;
room.time += 1; V.crash(ram, bike2, 14, att.id);
ram.driver = 0; V.remove(ram);
console.log(`удар о стену 25 м/с и таран машиной 14 м/с: ${me.vehicle === bike2.id ? 'остался на мотоцикле' : 'вылетел'}, здоровье ${me.hp}, мотоцикл ${bike2.hp.toFixed(0)}/${bikeHp0}`);
assert.ok(me.vehicle === bike2.id && me.hp === 100 && bike2.hp < bikeHp0, 'от ударов не вылетает и не ранится, ломается только мотоцикл');

// взрыв рядом: мотоциклиста ранит (он сидит открыто), но с мотоцикла не сбрасывает
room.explode(bike2.x + 2.2, bike2.y, CAR_BLAST, att.id, -1);
const blastLost = 100 - me.hp;
console.log(`взрыв в 2.2 м: мотоциклист потерял ${blastLost.toFixed(0)} здоровья, ${me.vehicle === bike2.id ? 'остался на мотоцикле' : 'сброшен'}`);
assert.ok(blastLost > 10 && me.vehicle === bike2.id, 'взрыв ранит мотоциклиста, но не сбрасывает');
V.exit(me, true);

// своя скорость 26 м/с: сервер не откатывает мотоцикл
me.hp = 100;
const bike3 = V.setKind(V.create(30.5, y0, 0, 5, 'parked', null), 'moto');
room.teleport(me, bike3.x, bike3.y + 1.2);
assert.ok(V.enter(me, bike3.id), 'сел на третий мотоцикл');
ws.msgs.length = 0;
let bx = bike3.x;
for (let i = 0; i < 45; i++) { room.time += DT; bx += 26 * DT; V.onDrive(me, [bx, y0, 0, 26, bike3.tp, 26, 0]); }
const rolledBack = ws.msgs.filter(q => q.t === 'ctp').length;
console.log(`26 м/с полторы секунды: проехал ${(bike3.x - 30.5).toFixed(1)} м, откатов ${rolledBack}`);
assert.ok(rolledBack === 0 && bike3.x > 30.5 + 37, 'сервер принимает скорость мотоцикла');
V.exit(me, true);

// бак: взрыв слабее машины; со стоянки мотоцикл появляется снова
const parked = [...V.list.values()].find(v => v.moto && v.spawn);
const sp = parked.spawn;
room.ev.x.length = 0;
V.explodeVehicle(parked);
const r = room.ev.x.length ? room.ev.x[0][2] : 0;
room.teleport(me, sp.x > m.w / 2 ? 8 : m.w - 8, sp.y > m.h / 2 ? 8 : m.h - 8);
room.teleport(att, me.x, me.y);
for (let i = 0; i < 70 * KV.TICK_RATE && !back(); i++) { room.time += DT; room.tickNo++; V.update(DT); }
function back() { return [...V.list.values()].some(v => v.moto && v.spawn === sp && !v.dead); }
console.log(`взрыв мотоцикла: радиус ${r} м (у машины ${CAR_BLAST.r}); на стоянке снова мотоцикл: ${back() ? 'да' : 'нет'}`);
assert.ok(r === 3 && back(), 'мотоцикл взрывается слабее машины и появляется на стоянке снова');

console.log('moto: OK');
