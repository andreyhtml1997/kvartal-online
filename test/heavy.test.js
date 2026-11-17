'use strict';
/* Тяжёлая техника по звёздам розыска: 3 - грузовик спецназа (шестеро с автоматами), 4 - полицейский вертолёт
   (кружит, бьёт очередями сверху, сбивается пулями и ракетами), 5 - танки (машины от них взрываются, давят кирпич
   и людей, бьют снарядами). Грузовик и танк угоняются; из танка игрок стреляет снарядами из башни. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { K, NPC_ID, STAR_HEAT } = require('../game/npcs');
const { W, B, G, WEAPONS } = KV;
const DT = 1 / KV.TICK_RATE;

// браузер-заглушка: запоминает только нужные сообщения (радар, посадку в машину, события вертолёта)
class FakeWs {
  constructor() { this.readyState = 1; this.bufferedAmount = 0; this.keep = []; }
  send(s) {
    if (s.startsWith('{"t":"mm"') || s.startsWith('{"t":"car"') || (s.startsWith('{"t":"e"') && /"h[fx]"/.test(s))) this.keep.push(JSON.parse(s));
  }
}

// ======================================================================
// А. Живая комната: кто и когда приезжает по звёздам
// ======================================================================
const room = new Room('heavy' + Math.random().toString(36).slice(2, 6));
room.botsOn = false;
const ws = new FakeWs();
const me = room.addHuman(ws, 'Проверка');
room.fillBots();
const N = room.npcs;
const m = room.map;
// игрок неуязвим: здесь проверяем, кто, когда и откуда стреляет, а не выживание
const hitsOnMe = new Map();
const damage0 = room.damage.bind(room);
room.damage = function (t, amount, att, ...rest) {
  if (t === me) { hitsOnMe.set(att, (hitsOnMe.get(att) || 0) + 1); return; }
  return damage0(t, amount, att, ...rest);
};
const shots = [];
const spawnShot0 = room.spawnShot.bind(room);
room.spawnShot = function (x, y, a, w, owner, veh, aimD, npcId, air) {
  shots.push({ owner, w: w.id, air: air || 0, off: Math.abs(x - me.x) > me.view[0] || Math.abs(y - me.y) > me.view[1] });
  return spawnShot0(x, y, a, w, owner, veh, aimD, npcId, air);
};
let ticks = 0;
const t0 = process.hrtime.bigint();
function run(sec, each) { for (let i = 0, n = Math.round(sec / DT); i < n; i++) { room.tick(); ticks++; if (each && each(i) === false) break; } }
const aim = (x, y) => { me.a = Math.atan2(y - me.y, x - me.x); me.aimD = Math.hypot(x - me.x, y - me.y); };

// игрок стоит на открытом перекрёстке посередине карты
const rx = m.roads.x[Math.floor(m.roads.x.length / 2)], ry = m.roads.y[Math.floor(m.roads.y.length / 2)];
room.teleport(me, rx[0] + rx[1] / 2, ry[0] + ry[1] / 2);

// 1. три звезды - бронированный грузовик спецназа, шестеро выходят и ловят
N.crime(me, STAR_HEAT[3] + 1);
assert.strictEqual(me.stars, 3, 'три звезды');
let truck = null, crew0 = [], siren0 = false, onFoot = 0, truckMinD = 1e9;
run(50, () => {
  for (const v of room.vehicles.list.values()) {
    if (v.kind !== 'swat' || v.dead) continue;
    if (!truck) { truck = v; crew0 = v.crew.map(id => N.list.get(id)); siren0 = v.siren; }
    truckMinD = Math.min(truckMinD, Math.hypot(v.x - me.x, v.y - me.y));
  }
  onFoot = [...N.list.values()].filter(n => n.kind === K.SWAT && n.alive && n.state === 'fight' && n.target === me.id).length;
  if (onFoot >= 4) return false;
});
const swatShots = shots.filter(s => s.owner === NPC_ID - K.SWAT);
console.log(`спецназ: грузовик ${truck ? 'приехал' : 'нет'} (прочность ${truck && truck.maxHp}, бойцов ${crew0.length}), ближе всего ${truckMinD.toFixed(1)} м, ` +
  `в бою ${onFoot}; выстрелов ${swatShots.length}, из-за края экрана ${swatShots.filter(s => s.off).length}`);
assert.ok(truck && truck.maxHp === KV.VEH.swat.hp && siren0, 'на 3 звёздах едет бронированный грузовик спецназа с мигалками');
assert.ok(crew0.length === 6 && crew0.every(n => n.kind === K.SWAT && n.w === W.RIFLE), 'в грузовике шестеро с автоматами');
assert.ok(onFoot >= 4, 'спецназ выходит и ловит игрока');
assert.strictEqual(swatShots.filter(s => s.off).length, 0, 'спецназ не стреляет из-за края экрана');

// 2. четыре звезды - вертолёт кружит и бьёт очередями сверху, только с экрана
N.crime(me, STAR_HEAT[4] - me.heat + 1);
assert.strictEqual(me.stars, 4, 'четыре звезды');
let heliMinD = 1e9;
const s2 = shots.length;
run(30, () => {
  for (const h of N.helis.values()) heliMinD = Math.min(heliMinD, Math.hypot(h.x - me.x, h.y - me.y));
  if (shots.slice(s2).filter(s => s.owner === NPC_ID - K.HELI).length >= 12) return false;
});
const heliShots = shots.slice(s2).filter(s => s.owner === NPC_ID - K.HELI);
console.log(`вертолёт: в воздухе ${N.helis.size}, ближе всего ${heliMinD.toFixed(1)} м; выстрелов ${heliShots.length} ` +
  `(сверху ${heliShots.filter(s => s.air === 1).length}, из-за края экрана ${heliShots.filter(s => s.off).length}), попаданий ${hitsOnMe.get(NPC_ID - K.HELI) || 0}`);
assert.ok(N.helis.size >= 1 && heliMinD < 12, 'на 4 звёздах прилетает вертолёт и кружит над игроком');
assert.ok(heliShots.length >= 6 && heliShots.every(s => s.air === 1 && !s.off), 'вертолёт бьёт очередями сверху и только с экрана');
const mm = ws.keep.filter(x => x.t === 'mm').pop();
assert.ok(mm && mm.hl && mm.hl.length >= 1, 'вертолёт виден на радаре');

// 3. под крышей вертолёт не достаёт: игрок в доме - очередей нет
let roofSpot = null;
for (const b of m.buildings) {
  if (!b.roof || roofSpot) continue;
  for (let y = b.y + 1; y < b.y + b.h - 1 && !roofSpot; y++) {
    for (let x = b.x + 1; x < b.x + b.w - 1; x++) {
      const k = y * m.w + x;
      if (m.owner[k] === b.id && m.block[k] === B.NONE && KV.circleFree(m, x + 0.5, y + 0.5, KV.PLAYER_R)) { roofSpot = [x + 0.5, y + 0.5]; break; }
    }
  }
}
const outside = [me.x, me.y];
room.teleport(me, roofSpot[0], roofSpot[1]);
for (const h of N.helis.values()) { h.x = me.x + 6; h.y = me.y; h.burst = 0; h.nextBurst = 0; }
const s3 = shots.length;
run(8);
const roofShots = shots.slice(s3).filter(s => s.owner === NPC_ID - K.HELI).length;
console.log(`игрок под крышей: очередей с вертолёта за 8 с ${roofShots}`);
assert.strictEqual(roofShots, 0, 'под крышей вертолёт не стреляет');
room.teleport(me, outside[0], outside[1]);

// 4. сбить вертолёт пулями: целишься в него - стреляешь вверх, стены не мешают
me.ammo[W.RIFLE] = 270; me.cur = W.RIFLE;
const heli = [...N.helis.values()].find(h => h.state === 'fly');
assert.ok(heli, 'есть вертолёт, который можно сбить');
const cops0 = me.copKills || 0;
let fell = false;
const s4 = shots.length;
run(25, () => {
  if (heli.state !== 'fly') { fell = true; return false; }
  aim(heli.x, heli.y); me.fire = true;
});
me.fire = false;
const upShots = shots.slice(s4).filter(s => s.owner === me.id);
run(2);
const hEv = ws.keep.filter(x => x.t === 'e');
console.log(`сбиваем пулями: выстрелов ${upShots.length} (вверх ${upShots.filter(s => s.air === 2).length}), упал ${fell}, ` +
  `исчез ${!N.helis.has(heli.id)}, событий падения ${hEv.filter(x => x.hf).length}, полиции в счёте +${(me.copKills || 0) - cops0}`);
assert.ok(fell && upShots.length > 0 && upShots.every(s => s.air === 2), 'вертолёт сбивают пулями, стреляя вверх');
assert.ok(!N.helis.has(heli.id) && hEv.some(x => x.hf) && hEv.some(x => x.hx), 'сбитый вертолёт падает и разбивается');
assert.ok((me.copKills || 0) > cops0, 'сбитый вертолёт идёт в колонку «Полиция»');

// 5. сбить вертолёт ракетами: 2-3 штуки
const h2 = N.spawnHeli(me);
h2.x = me.x + 8; h2.y = me.y;
me.ammo[W.LAUNCHER] = 16; me.cur = W.LAUNCHER;
const s5 = shots.length;
run(15, () => {
  if (h2.state !== 'fly') return false;
  aim(h2.x, h2.y); me.fire = true;
});
me.fire = false;
const rockets = shots.slice(s5).filter(s => s.owner === me.id && s.w === W.LAUNCHER).length;
console.log(`сбиваем ракетами: ракет ${rockets}, вертолёт ${h2.state === 'fall' || !N.helis.has(h2.id) ? 'сбит' : 'летает, прочность ' + h2.hp.toFixed(0)}`);
assert.ok((h2.state === 'fall' || !N.helis.has(h2.id)) && rockets <= 3, 'вертолёт сбивают 2-3 ракеты');
run(2);

// 6. пять звёзд - танки: едут к игроку, бьют снарядами только с экрана, не больше двух на игрока
N.crime(me, STAR_HEAT[5] - me.heat + 1);
assert.strictEqual(me.stars, 5, 'пять звёзд');
let tank = null, tankMinD = 1e9, tanksMax = 0;
const s6 = shots.length;
run(60, () => {
  let n = 0;
  for (const v of room.vehicles.list.values()) {
    if (v.kind !== 'tank' || v.dead) continue;
    if (v.role === 'tank') n++;
    tank = tank || v;
    tankMinD = Math.min(tankMinD, Math.hypot(v.x - me.x, v.y - me.y));
  }
  tanksMax = Math.max(tanksMax, n);
  if (shots.slice(s6).filter(s => s.owner === NPC_ID - K.ARMY && s.w === W.LAUNCHER).length >= 2) return false;
});
const shells = shots.slice(s6).filter(s => s.owner === NPC_ID - K.ARMY && s.w === W.LAUNCHER);
const mm6 = ws.keep.filter(x => x.t === 'mm').pop();
console.log(`танки: приехал ${!!tank} (прочность ${tank && tank.maxHp}), ближе всего ${tankMinD.toFixed(1)} м, одновременно ${tanksMax}; ` +
  `снарядов ${shells.length}, из-за края экрана ${shells.filter(s => s.off).length}; на радаре ${mm6 && mm6.tk ? mm6.tk.length : 0}`);
assert.ok(tank && tank.maxHp === KV.VEH.tank.hp && tank.crush, 'на 5 звёздах едет танк');
assert.ok(shells.length >= 1 && shells.every(s => !s.off), 'танк бьёт снарядами и только с экрана');
assert.ok(tanksMax <= 2, 'не больше двух танков на одного игрока');
assert.ok(mm6 && mm6.tk && mm6.tk.length >= 1, 'танк виден на радаре');

const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`такт с техникой: ${(ms / ticks).toFixed(3)} мс; жителей ${N.list.size}, машин ${room.vehicles.list.size}`);
assert.ok(ms / ticks < 3, 'техника укладывается в бюджет такта');

// ======================================================================
// Б. Ровная площадка: физика танка, броня, угон, снаряды игрока, пули вертолёта
// ======================================================================
function flatRoom() {
  const r = new Room('flat' + Math.random().toString(36).slice(2, 6));
  for (const id of [...r.players.keys()]) r.players.delete(id);
  for (const v of [...r.vehicles.list.values()]) r.vehicles.remove(v);
  r.map.block.fill(0);
  r.map.ground.fill(G.ROAD);
  r.map.owner.fill(-1);
  for (let x = 0; x < r.map.w; x++) { r.map.block[x] = B.BORDER; r.map.block[(r.map.h - 1) * r.map.w + x] = B.BORDER; }
  for (let y = 0; y < r.map.h; y++) { r.map.block[y * r.map.w] = B.BORDER; r.map.block[y * r.map.w + r.map.w - 1] = B.BORDER; }
  r.vehicles.nextTrafficAt = 1e9;
  return r;
}
const R = flatRoom();
const V = R.vehicles;
const at = (x, y) => y * R.map.w + x;
const stepCars = n => { for (let i = 0; i < n; i++) { R.time += DT; V.update(DT); R.updatePending(); } };

// 7. машина въехала в танк - взрывается; танку от этого взрыва ничего
{
  const t = V.setKind(V.create(40, 60, 0, 6, 'parked', null), 'tank');
  const c = V.create(44.4, 60, 0, 1, 'parked', null);
  c.v = -4;
  stepCars(15);
  console.log(`машина въехала в танк: машина ${c.dead ? 'взорвалась' : 'цела'}, танк ${t.hp}/${t.maxHp}`);
  assert.ok(c.dead && !t.dead && t.hp === t.maxHp, 'от столкновения с танком машина взрывается, танк цел');
  V.remove(t);
}

// 8. танк давит кирпич и лёгкое, бетон держит; обычная машина в кирпичную стену упирается
{
  for (let y = 50; y <= 70; y++) { R.map.block[at(48, y)] = B.BRICK; R.map.hp[at(48, y)] = 110; R.map.block[at(52, y)] = B.FENCE; R.map.hp[at(52, y)] = 28; }
  for (let y = 50; y <= 70; y++) { R.map.block[at(70, y)] = B.CONCRETE; R.map.hp[at(70, y)] = 240; }
  const t = V.setKind(V.create(42, 60, 0, 6, 'parked', null), 'tank');
  for (let i = 0; i < 6 * KV.TICK_RATE; i++) { R.time += DT; V.physics(t, 1, 0, DT, 0); R.updatePending(); }
  const brickGone = R.map.block[at(48, 60)] === B.NONE, fenceGone = R.map.block[at(52, 60)] === B.NONE;
  console.log(`танк: кирпич ${brickGone ? 'раздавлен' : 'цел'}, забор ${fenceGone ? 'раздавлен' : 'цел'}, остановился у бетона на x=${t.x.toFixed(1)}, ` +
    `бетон ${R.map.block[at(70, 60)] === B.CONCRETE ? 'цел' : 'снесён'}, скорость до ${t.maxV} м/с`);
  assert.ok(brickGone && fenceGone, 'танк давит кирпич и заборы');
  assert.ok(t.x > 55 && t.x < 70 - KV.CAR.HL + 0.2 && R.map.block[at(70, 60)] === B.CONCRETE, 'бетон танк не берёт');
  V.remove(t);
  for (let y = 50; y <= 70; y++) { R.map.block[at(48, y)] = B.BRICK; R.map.hp[at(48, y)] = 110; }
  const c = V.create(42, 60, 0, 1, 'parked', null);
  for (let i = 0; i < 3 * KV.TICK_RATE; i++) { R.time += DT; V.physics(c, 1, 0, DT, 0); }
  console.log(`обычная машина у кирпичной стены: x=${c.x.toFixed(1)}, стена ${R.map.block[at(48, 60)] === B.BRICK ? 'цела' : 'снесена'}`);
  assert.ok(c.x < 48 - KV.CAR.HL + 0.1 && R.map.block[at(48, 60)] === B.BRICK, 'обычная машина кирпич не проламывает');
  V.remove(c);
  for (let y = 50; y <= 70; y++) for (const x of [48, 52, 70]) R.map.block[at(x, y)] = B.NONE;
}

// 9. броня: пули почти не берут танк, грузовик спецназа держит втрое лучше машины; танку нужно 5 ракет
{
  const t = V.setKind(V.create(40, 40, 0, 6, 'parked', null), 'tank');
  const s = V.setKind(V.create(40, 50, 0, 6, 'parked', null), 'swat');
  const c = V.create(40, 60, 0, 1, 'parked', null);
  const hp = [t.hp, s.hp, c.hp];
  for (const v of [t, s, c]) R.spawnShot(v.x - 6, v.y, 0, WEAPONS[W.PISTOL], 0, 0, 0, 0);
  for (let i = 0; i < 10; i++) { R.time += DT; R.updateBullets(); }
  const lost = [hp[0] - t.hp, hp[1] - s.hp, hp[2] - c.hp];
  console.log(`пуля пистолета: танк -${lost[0].toFixed(2)}, спецназ -${lost[1].toFixed(2)}, машина -${lost[2].toFixed(2)}`);
  assert.ok(lost[2] > 10 && Math.abs(lost[1] - lost[2] * 0.35) < 0.01 && Math.abs(lost[0] - lost[2] * 0.05) < 0.01, 'броня: пули почти не берут танк');
  V.remove(s); V.remove(c);
  t.hp = t.maxHp;
  const blast = WEAPONS[W.LAUNCHER].blast;
  for (let i = 0; i < 4; i++) R.explode(t.x, t.y, blast, 0, W.LAUNCHER);
  const after4 = t.hp, burn4 = t.burn > 0;
  R.explode(t.x, t.y, blast, 0, W.LAUNCHER);
  console.log(`ракеты по танку: после 4 прочность ${after4.toFixed(0)} (горит ${burn4}), после 5-й горит ${t.burn > 0}`);
  assert.ok(after4 > 0 && !burn4 && t.burn > 0, 'танк выдерживает 4 ракеты и загорается от 5-й');
  V.remove(t);
}

// 10. танк давит человека насмерть и на малой скорости (обычная машина так - нет)
{
  const t = V.setKind(V.create(40, 30, 0, 6, 'parked', null), 'tank');
  const c = V.create(40, 36, 0, 1, 'parked', null);
  const a = R.npcs.create(K.CIV, 42.4, 30, {}), b = R.npcs.create(K.CIV, 42.4, 36, {});
  t.v = 1.5; c.v = 1.5;
  V.checkHits(t); V.checkHits(c);
  console.log(`наезд на 1.5 м/с: танк - житель ${a.alive ? 'жив' : 'погиб'}; машина - житель ${b.alive ? 'жив' : 'погиб'}`);
  assert.ok(!a.alive && b.alive, 'танк давит насмерть и медленно');
  V.remove(t); V.remove(c);
}

// 11. угон танка: в браузер уходит вид техники; атака - снаряд из башни раз в 1.6 с, оружие в руках не тратится
const ws2 = new FakeWs();
const p = R.addHuman(ws2, 'Танкист');
R.dmgPlayers = true;
{
  const t = V.setKind(V.create(60, 60, 0, 6, 'parked', null), 'tank');
  R.teleport(p, 60, 60 + KV.CAR.HW + 0.7);
  assert.ok(V.enter(p, t.id), 'в стоящий танк можно сесть');
  const carMsg = ws2.keep.filter(x => x.t === 'car').pop();
  p.ammo[W.PISTOL] = 30; p.cur = W.PISTOL;
  p.a = 0.5; p.aimD = 15; p.fire = true;
  const b0 = R.nextBullet;
  const fired = [];
  const spawn0 = R.spawnShot.bind(R);
  R.spawnShot = (x, y, a, w, owner, veh, aimD, npcId, air) => { if (owner === p.id) fired.push(w.id); return spawn0(x, y, a, w, owner, veh, aimD, npcId, air); };
  for (let i = 0; i < 2 * KV.TICK_RATE; i++) { R.time += DT; R.updateFiring(p); }
  p.fire = false;
  R.spawnShot = spawn0;
  const snap = V.snap(t);
  console.log(`танк игрока: вид в браузер ${carMsg && carMsg.kind}, снарядов за 2 с ${fired.length} (${fired.join(',')}), патронов пистолета ${p.ammo[W.PISTOL]}, ` +
    `башня ${t.turret}, снимок: прочность ${snap[9]}%, вид ${snap[10]}, башня ${snap[11]}; пуль создано ${R.nextBullet - b0}`);
  assert.ok(carMsg && carMsg.kind === 4, 'браузер знает, что сел в танк');
  assert.ok(fired.length === 2 && fired.every(w => w === W.LAUNCHER) && p.ammo[W.PISTOL] === 30, 'из танка - снаряды раз в 1.6 с, патроны не тратятся');
  assert.ok(t.turret === 0.5 && snap[9] === 100 && snap[10] === 4 && snap[11] === 0.5, 'башня смотрит туда, куда целишься; в снимке вид и башня');
  V.exit(p, true);
  V.remove(t);
}

// 12. пули с вертолёта летят над стенами, но у цели стена закрывает; выстрел вверх по вертолёту - над стенами
{
  p.prot = 0; p.hp = 100; p.ar = 0;
  R.teleport(p, 80.5, 60.5);
  R.map.block[at(84, 60)] = B.CONCRETE; R.map.hp[at(84, 60)] = 1e6;
  R.spawnShot(89.5, 60.5, Math.PI, WEAPONS[W.SNIPER], NPC_ID - K.HELI, 0, 9, 0, 1);
  for (let i = 0; i < 10; i++) { R.time += DT; R.updateBullets(); }
  const hit1 = p.hp < 100;
  p.hp = 100;
  R.map.block[at(82, 60)] = B.CONCRETE; R.map.hp[at(82, 60)] = 1e6;
  R.spawnShot(89.5, 60.5, Math.PI, WEAPONS[W.SNIPER], NPC_ID - K.HELI, 0, 9, 0, 1);
  for (let i = 0; i < 10; i++) { R.time += DT; R.updateBullets(); }
  const hit2 = p.hp < 100;
  console.log(`пуля с вертолёта: стена на полпути ${hit1 ? 'не мешает' : 'закрыла'}; стена рядом с целью ${hit2 ? 'не закрыла' : 'закрывает'}`);
  assert.ok(hit1 && !hit2, 'с вертолёта бьют поверх домов, а у самой цели стена прикрывает');
  // игрок целится в вертолёт за стеной - пуля уходит вверх и попадает; целится в стену - попадает в стену
  const h = R.npcs.spawnHeli(p);
  h.x = 92.5; h.y = 60.5; p.stars = 4;
  R.map.block[at(86, 60)] = B.CONCRETE; R.map.hp[at(86, 60)] = 1e6;
  R.teleport(p, 80.5, 60.5);
  R.map.block[at(82, 60)] = B.NONE; R.map.block[at(84, 60)] = B.NONE;
  p.ammo[W.SNIPER] = 10; p.cur = W.SNIPER; p.a = 0; p.aimD = 12; p.fire = true; p.nextShot = 0;
  R.time += DT; R.updateFiring(p); p.fire = false;
  for (let i = 0; i < 10; i++) { R.time += DT; R.updateBullets(); }
  const up = h.hp < h.maxHp;
  const hp1 = h.hp;
  p.aimD = 5; p.fire = true; p.nextShot = 0;
  R.time += DT; R.updateFiring(p); p.fire = false;
  for (let i = 0; i < 10; i++) { R.time += DT; R.updateBullets(); }
  console.log(`выстрел по вертолёту за стеной: целился в него - ${up ? 'попал' : 'мимо'}; целился в стену - ${h.hp < hp1 ? 'попал в вертолёт' : 'попал в стену'}`);
  assert.ok(up && h.hp === hp1, 'целишься в вертолёт - пуля летит вверх через стены; в стену - бьёт в стену');
}

console.log('heavy: OK');
