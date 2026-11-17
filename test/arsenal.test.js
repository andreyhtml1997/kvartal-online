'use strict';
/* Новое оружие 17.11.2026: миниган (раскрутка 0.25 с, потом 24 пули в секунду, поднял - 1000 патронов), автодробовик (3 веера в секунду),
   «тройка» (3 дробины, вдвое дальше дробовика), узи, гранаты (летят в точку прицела, отскакивают от стен, взрываются
   через 2 с), щит (спереди пули не проходят, атака - из пистолета; ботам не нужен, падает при смерти);
   розыск за полицию и скорую - строже. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { K } = require('../game/npcs');
const { W, B, G, PK, WEAPONS } = KV;
const DT = 1 / KV.TICK_RATE;

class FakeWs { constructor() { this.readyState = 1; this.bufferedAmount = 0; } send() {} }
const R = new Room('ars' + Math.random().toString(36).slice(2, 6));
for (const id of [...R.players.keys()]) R.players.delete(id);
for (const v of [...R.vehicles.list.values()]) R.vehicles.remove(v);
for (const n of [...R.npcs.list.values()]) R.npcs.remove(n);
R.map.block.fill(0); R.map.ground.fill(G.ROAD); R.map.owner.fill(-1);
R.vehicles.nextTrafficAt = 1e9;
const m = R.map, at = (x, y) => y * m.w + x;
const me = R.addHuman(new FakeWs(), 'Стрелок');
R.teleport(me, 30.5, 60.5);
me.prot = 0; me.a = 0;
const shots = [];
const spawn0 = R.spawnShot.bind(R);
R.spawnShot = (x, y, a, w, owner, ...rest) => { if (owner === me.id) shots.push({ t: R.time, w: w.id }); return spawn0(x, y, a, w, owner, ...rest); };
const tick = sec => { for (let i = 0; i < Math.round(sec / DT); i++) { R.time += DT; R.updateFiring(me); R.updateBullets(); R.updateGrenades(); R.updatePending(); } };
const arm = (w, n) => { me.ammo[w] = n === undefined ? WEAPONS[w].max : n; me.cur = w; me.nextShot = 0; me.spinT = 0; shots.length = 0; };

// 1. миниган: четверть секунды раскручивается, потом ~24 пули в секунду; запас - 1000, поднятый даёт сразу 1000
arm(W.MINIGUN); me.fire = true;
tick(0.2);
const early = shots.length;
tick(1.05);
me.fire = false;
const mini = shots.length - early;
console.log(`миниган: за первые 0.2 с ${early} пуль, за следующую секунду ${mini}; поднял - ${WEAPONS[W.MINIGUN].pick} патронов из ${WEAPONS[W.MINIGUN].max}`);
assert.ok(early === 0 && mini >= 21 && mini <= 26, 'миниган раскручивается за четверть секунды и строчит ~24 пули в секунду');
assert.ok(WEAPONS[W.MINIGUN].pick === 1000 && WEAPONS[W.MINIGUN].max === 1000, 'поднятый миниган - сразу 1000 патронов');

// 2. автодробовик: 3 веера по 7 дробин в секунду; узи - 14 пуль в секунду
arm(W.AUTOSHOT); me.fire = true; tick(1.0); me.fire = false;
const auto = shots.length;
arm(W.UZI); me.fire = true; tick(1.0); me.fire = false;
const uzi = shots.length;
console.log(`автодробовик: выстрелов за 1 с ${auto} (по ${WEAPONS[W.AUTOSHOT].pellets} дробин); узи: ${uzi}`);
assert.ok(auto >= 3 && auto <= 4 && WEAPONS[W.AUTOSHOT].pellets === 7, 'автодробовик: 3 веера в секунду');
assert.ok(uzi >= 13 && uzi <= 15, 'узи: ~14 пуль в секунду');

// 3. «тройка» достаёт на 20 м, обычный дробовик - нет
function hitsAt(w, dist) {
  const target = R.npcs.create(K.CIV, me.x + dist, me.y, { hp: 1000 });
  arm(w); me.fire = true; tick(1.2); me.fire = false; tick(1.0);
  const lost = 1000 - target.hp;
  R.npcs.remove(target);
  return lost;
}
const triple = hitsAt(W.TRIPLE, 20), shotgun = hitsAt(W.SHOTGUN, 20);
console.log(`на 20 м: тройка сняла ${triple.toFixed(0)}, дробовик ${shotgun.toFixed(0)}`);
assert.ok(triple > 0 && shotgun === 0 && WEAPONS[W.TRIPLE].pellets === 3, 'тройка бьёт вдвое дальше дробовика');

// 4. граната: летит в точку прицела и через 2 с взрывается там; от стены отскакивает назад
const booms = [];
const explode0 = R.explode.bind(R);
R.explode = (x, y, blast, owner, w, ...rest) => { booms.push({ x, y, t: R.time, w }); return explode0(x, y, blast, owner, w, ...rest); };
arm(W.GRENADE, 3); me.aimD = 8; me.fireLatch = true; me.latchAt = R.time;
const thrownAt = R.time;
tick(2.4);
const b1 = booms.find(b => b.w === W.GRENADE);
console.log(`граната: взорвалась через ${b1 ? (b1.t - thrownAt).toFixed(2) : '-'} с в ${b1 ? (b1.x - me.x).toFixed(1) : '-'} м (целился на 8 м)`);
assert.ok(b1 && Math.abs(b1.t - thrownAt - 2) < 0.15 && Math.abs(b1.x - me.x - 8) < 1, 'граната взрывается в точке прицела через 2 с');
for (let y = 55; y <= 66; y++) { m.block[at(34, y)] = B.CONCRETE; m.hp[at(34, y)] = 1e6; }
booms.length = 0;
me.aimD = 12; me.nextShot = 0; me.fireLatch = true; me.latchAt = R.time;
tick(2.4);
const b2 = booms.find(b => b.w === W.GRENADE);
console.log(`граната в стену в 3.5 м: взорвалась на ${b2 ? (b2.x).toFixed(1) : '-'} (стена на 34)`);
assert.ok(b2 && b2.x < 34, 'от стены граната отскакивает и остаётся по эту сторону');
for (let y = 55; y <= 66; y++) m.block[at(34, y)] = B.NONE;
R.explode = explode0;

// 5. щит: спереди пули не проходят, сзади - проходят; атака со щитом - из пистолета
me.ammo[W.SHIELD] = 0; me.cur = W.SHIELD; me.a = 0; me.hp = 100; me.ar = 0; me.prot = 0;
R.spawnShot(me.x + 8, me.y, Math.PI, WEAPONS[W.SNIPER], 0, 0, 0, 0);         // спереди
for (let i = 0; i < 10; i++) { R.time += DT; R.updateBullets(); }
const front = me.hp;
R.spawnShot(me.x - 8, me.y, 0, WEAPONS[W.PISTOL], 0, 0, 0, 0);               // сзади
for (let i = 0; i < 10; i++) { R.time += DT; R.updateBullets(); }
const back = me.hp;
console.log(`щит: пуля спереди - здоровье ${front}, пуля сзади - ${back}`);
assert.ok(front === 100 && back < 100, 'щит держит пули спереди, сзади - нет');
me.ammo[W.PISTOL] = 5; shots.length = 0; me.nextShot = 0; me.fire = true; tick(0.5); me.fire = false;
const withPistol = shots.length, left = me.ammo[W.PISTOL];
me.ammo[W.PISTOL] = 0; shots.length = 0; me.nextShot = 0; me.fire = true; tick(0.5); me.fire = false;
console.log(`со щитом: выстрелов из пистолета ${withPistol} (патронов осталось ${left}); без пистолета ${shots.length}; в руках ${WEAPONS[me.cur].name}`);
assert.ok(withPistol >= 1 && shots.every(s => s.w === W.PISTOL) && left === 5 - withPistol, 'со щитом стреляешь из пистолета');
assert.ok(shots.length === 0 && me.cur === W.SHIELD, 'без пистолета со щитом не стреляешь, щит остаётся в руках');

// 6. щит: бот не подбирает, человек подбирает; при смерти падает на землю
const bot = R.createPlayer('Бот', true);
R.spawn(bot);
const pk = { kind: PK.WEAPON, w: W.SHIELD, amount: 0 };
const botTook = R.tryPick(bot, pk);
const me2 = R.addHuman(new FakeWs(), 'Второй');
const humanTook = R.tryPick(me2, pk);
const pk0 = R.pickups.size;
me2.cur = W.SHIELD; R.kill(me2, 0, 0);
const dropped = [...R.pickups.values()].some(q => q.kind === PK.WEAPON && q.w === W.SHIELD);
console.log(`щит: бот взял ${botTook}, человек взял ${humanTook}; после смерти на земле ${dropped} (вещей ${pk0} -> ${R.pickups.size})`);
assert.ok(!botTook && humanTook && dropped, 'щит: ботам не нужен, у людей падает при смерти');

// 7. розыск строже: попадание в полицейского +30, в скорую +15
const cop = R.npcs.create(K.COP, me.x + 3, me.y, { hp: 100 });
me.heat = 0; me.stars = 0;
R.npcs.damage(cop, 5, me.id, W.PISTOL, cop.x, cop.y);
const copHeat = me.heat;
const amb = R.vehicles.create(me.x + 10, me.y + 10, 0, 5, 'parked', null); amb.kind = 'amb';
me.heat = 0;
R.vehicles.damage(amb, 5, me.id);
console.log(`розыск: за попадание в полицейского +${copHeat}, в скорую +${me.heat}`);
assert.ok(copHeat === 30 && me.heat === 15, 'за полицию и скорую розыск растёт быстрее');

console.log('arsenal: OK');
