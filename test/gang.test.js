'use strict';
/* Режим «Банда» (17.11.2026): все люди в комнате заодно - друг друга не ранят ничем (пули пролетают сквозь своих,
   взрывы, огонь, кулак, наезд - без урона), розыск общий (натворил один - ищут всех; звезда погашения и мастерская -
   на всех; звёзды гаснут, только когда погибли все), погоня с теми же лимитами, что на одного, делится между всеми
   и переключается с погибшего на живого; погибший появляется рядом со своими. В «Все против всех» - как раньше. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { K, STAR_HEAT } = require('../game/npcs');
const { W, WEAPONS, CAR, CAR_BLAST, PK } = KV;
const DT = 1 / KV.TICK_RATE;

class FakeWs { constructor() { this.readyState = 1; this.bufferedAmount = 0; } send() {} }
function makeRoom(gang) {
  const room = new Room((gang ? 'gang' : 'ffa') + Math.random().toString(36).slice(2, 6), { gang });
  room.botsOn = false;
  const A = room.addHuman(new FakeWs(), 'Первый'), B = room.addHuman(new FakeWs(), 'Второй');
  room.fillBots();
  A.prot = 0; B.prot = 0;
  for (const v of [...room.vehicles.list.values()]) if (v.state === 'traffic') room.vehicles.remove(v);
  return { room, A, B };
}
// поставить двоих на свободную дорогу в 5 м друг от друга (стрелок справа)
function lineUp(room, A, B) {
  const r = room.map.roads.y[1], y = r[0] + 2, x = Math.round(room.map.w / 2) + 0.5;
  room.teleport(B, x, y); room.teleport(A, x + 5, y);
  A.a = Math.PI; A.hp = 100; B.hp = 100; B.ar = 0; A.ar = 0;
  return { x, y };
}
function volley(room, A, B, n) {
  for (let i = 0; i < n; i++) {
    room.spawnShot(A.x - 0.6, A.y, Math.PI, WEAPONS[W.PISTOL], A.id, 0, 5);
    for (let k = 0; k < 6; k++) { room.time += DT; room.updateBullets(); }
  }
}

// ---------- 1. свои друг друга не ранят ----------
const g = makeRoom(true), R = g.room, N = R.npcs, V = R.vehicles;
const pos = lineUp(R, g.A, g.B);
// за спиной у своего - прохожий: пуля пролетает сквозь своего и попадает в него
const civ = N.create(K.CIV, pos.x - 2.5, pos.y, { hp: 70 });
volley(R, g.A, g.B, 3);
const civHit = !civ.alive || civ.hp < 70;
console.log(`банда: 3 пули в своего - здоровье ${g.B.hp}; прохожий за ним ${civHit ? 'ранен' : 'цел'}`);
assert.ok(g.B.hp === 100 && civHit, 'пули пролетают сквозь своего и не ранят его');
N.remove(civ);
N.setGang(0, 0);

R.explode(g.B.x + 1, g.B.y, CAR_BLAST, g.A.id, W.LAUNCHER);
R.ignite(g.B, g.A.id, 3);
const burning = g.B.burnUntil > R.time;
R.teleport(g.A, g.B.x + 0.9, g.B.y); g.A.a = Math.PI;
R.melee(g.A, WEAPONS[W.FISTS]);
// наезд машиной своего
const car = V.create(g.B.x - 6, g.B.y, 0, 2, 'parked', null);
R.teleport(g.A, car.x, car.y + CAR.HW + 0.7);
assert.ok(V.enter(g.A, car.id), 'свой сел в машину');
car.x = g.B.x - 1.2; car.hvx = 12; car.hvy = 0; car.v = 12;
V.checkHits(car);
console.log(`банда: взрыв ракеты своего в 1 м, огнемёт, кулак, наезд на 12 м/с - здоровье ${g.B.hp}, горит ${burning}`);
assert.ok(g.B.hp === 100 && !burning, 'ни взрыв, ни огонь, ни кулак, ни наезд своего не ранят');
V.exit(g.A, true);
V.remove(car);

// для сравнения: «Все против всех» - пули ранят
const f = makeRoom(false);
lineUp(f.room, f.A, f.B);
volley(f.room, f.A, f.B, 3);
console.log(`все против всех: 3 пули - здоровье ${f.B.hp}`);
assert.ok(f.B.hp < 100, 'в «Все против всех» пули ранят');

// ---------- 2. розыск общий ----------
N.crime(g.A, STAR_HEAT[3] + 1);
console.log(`натворил первый: звёзды у первого ${g.A.stars}, у второго ${g.B.stars}`);
assert.ok(g.A.stars === 3 && g.B.stars === 3, 'натворил один - ищут всех');
R.addPickup(PK.STAR, 0, g.B.x, g.B.y, 1);
for (const pk of [...R.pickups.values()]) if (pk.kind === PK.STAR && R.tryPick(g.B, pk)) R.removePickup(pk.id);
assert.ok(g.A.stars === 2 && g.B.stars === 2, 'звезда погашения снимает звезду со всех');
const C = R.addHuman(new FakeWs(), 'Третий');
assert.strictEqual(C.stars, 2, 'новичок в банде сразу в розыске');
R.removePlayer(C.id);

// смерть: пока жив хоть один - розыск держится; погибли все - гаснет
R.kill(g.A, 0, 0);
const afterOne = [g.A.stars, g.B.stars];
R.spawn(g.A);
const nearMate = Math.hypot(g.A.x - g.B.x, g.A.y - g.B.y);
R.kill(g.B, 0, 0);
const afterTwoOneAlive = g.B.stars;
R.kill(g.A, 0, 0);
const afterAll = [g.A.stars, g.B.stars];
console.log(`погиб первый: звёзды ${afterOne}; возродился в ${nearMate.toFixed(1)} м от второго; погиб второй (первый жив): ${afterTwoOneAlive}; погибли оба: ${afterAll}`);
assert.ok(afterOne[0] === 2 && afterOne[1] === 2 && afterTwoOneAlive === 2 && afterAll[0] === 0 && afterAll[1] === 0, 'звёзды гаснут, только когда погибли все');
assert.ok(nearMate <= 17, 'погибший появляется рядом со своими');
R.spawn(g.A); R.spawn(g.B); g.A.prot = 0; g.B.prot = 0;

// мастерская снимает розыск со всех
N.crime(g.A, STAR_HEAT[3] + 1);
const fix = R.map.shops.find(s => s.kind === 'fix');
const fcar = V.create(fix.x, fix.y, Math.PI / 2, 3, 'parked', null);
R.teleport(g.A, fix.x + CAR.HW + 0.7, fix.y);
assert.ok(V.enter(g.A, fcar.id), 'заехал в мастерскую');
g.A.money = 1500;
for (let i = 0; i < Math.round(2.6 / (3 * DT)); i++) { R.time += 3 * DT; R.updateShops(); }
console.log(`мастерская: звёзды у первого ${g.A.stars}, у второго ${g.B.stars}, денег $${g.A.money}`);
assert.ok(g.A.stars === 0 && g.B.stars === 0 && g.A.money === 500, 'мастерская снимает розыск со всей банды');
V.exit(g.A, true); V.remove(fcar);

// ---------- 3. погоня: лимиты как на одного, делится, переключается на живого ----------
const C2 = R.addHuman(new FakeWs(), 'Третий'); C2.prot = 0;
N.crime(g.A, STAR_HEAT[3] + 1);
for (let i = 0; i < 12; i++) { R.time += 1.5; N.dispatchPolice(); }
const isMember = id => [g.A.id, g.B.id, C2.id].includes(id);
const cops = [...V.list.values()].filter(v => v.kind === 'police' && v.role === 'police' && !v.dead && isMember(v.target));
const swat = [...V.list.values()].filter(v => v.kind === 'swat' && !v.dead && isMember(v.target));
const targets = new Set([...cops, ...swat].map(v => v.target));
console.log(`банда из трёх на 3 звёздах: полицейских машин ${cops.length}, грузовиков спецназа ${swat.length}, ловят ${targets.size} из 3`);
assert.ok(cops.length >= 1 && cops.length <= 3 && swat.length === 1, 'погоня на банду - как на одного (3 машины и 1 грузовик на 3 звёздах)');
assert.ok(targets.size >= 2, 'погоня делится между всеми');
const chase = cops[0];
const victim = R.players.get(chase.target);
R.kill(victim, 0, 0);
N.pilot(chase, DT);
const newT = R.players.get(chase.target);
console.log(`цель погибла: машина переключилась на ${newT && newT.alive ? newT.name : '-'} (роль ${chase.role})`);
assert.ok(newT && newT.alive && newT !== victim && chase.role === 'police', 'погоня переключается на живого из банды');

// банда из двоих: погоня делится поровну (замер 17.11.2026: очередь сдвигалась дважды за вызов - все машины к одному)
{
  const d = makeRoom(true);
  d.room.npcs.crime(d.A, STAR_HEAT[4] + 1);
  for (let i = 0; i < 12; i++) { d.room.time += 1.5; d.room.npcs.dispatchPolice(); }
  // вся погоня: машины полиции, грузовик спецназа, вертолёт
  const units = [...d.room.vehicles.list.values()].filter(v => !v.dead && v.state === 'npc' && (v.role === 'police' || v.role === 'tank'))
    .map(v => v.target).concat([...d.room.npcs.helis.values()].map(h => h.target));
  const cars = [...d.room.vehicles.list.values()].filter(v => v.kind === 'police' && v.role === 'police').length;
  const onA = units.filter(t => t === d.A.id).length, onB = units.filter(t => t === d.B.id).length;
  console.log(`банда из двоих на 4 звёздах: машин полиции ${cars}, всего погони ${units.length} (за первым ${onA}, за вторым ${onB})`);
  assert.ok(cars <= 4 && onA >= 1 && onB >= 1 && Math.abs(onA - onB) <= 1, 'погоня делится поровну между двумя');
}

// все ушли из комнаты - розыск банды сброшен, вернувшийся начинает чисто
N.crime(g.A, STAR_HEAT[2] + 1);
for (const p of [...R.players.values()]) if (!p.isBot) R.removePlayer(p.id);
const back = R.addHuman(new FakeWs(), 'Вернулся');
console.log(`все ушли и один вернулся: звёзд ${back.stars}`);
assert.strictEqual(back.stars, 0, 'банда разошлась - розыск сброшен');

console.log('gang: OK');
