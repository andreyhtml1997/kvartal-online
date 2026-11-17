'use strict';
/* Мелочи 17.11.2026: вооружённые жители не убегают, а отстреливаются; полицейская машина даёт дробовик и +50 брони,
   грузовик спецназа - автомат и броню до 100 (один раз на машину); в скорой лечит 3 здоровья в секунду; аптечек вдвое
   больше; огнемёт по людям вдвое сильнее; после гриба выносливость не кончается. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { K } = require('../game/npcs');
const { W, PK, CAR, WEAPONS, STAMINA } = KV;
const DT = 1 / KV.TICK_RATE;

class FakeWs { constructor() { this.readyState = 1; this.bufferedAmount = 0; this.msgs = []; } send(s) { if (s.startsWith('{"t":"loot"')) this.msgs.push(JSON.parse(s)); } }
const room = new Room('perk' + Math.random().toString(36).slice(2, 6));
room.botsOn = false;
const ws = new FakeWs();
const me = room.addHuman(ws, 'Проверка');
room.fillBots();
const N = room.npcs, V = room.vehicles;

// 1. вооружённый житель, в которого выстрелили, отвечает - ни разу не убегает; безоружный - убегает
let fights = 0, flees = 0;
for (let i = 0; i < 20; i++) {
  const n = N.create(K.CIV, me.x + 6, me.y, { w: W.PISTOL, hp: 70 });
  N.damage(n, 5, me.id, W.PISTOL, n.x, n.y);
  if (n.state === 'fight') fights++;
  N.remove(n);
  const u = N.create(K.CIV, me.x + 6, me.y, { w: 0, hp: 70 });
  N.damage(u, 5, me.id, W.PISTOL, u.x, u.y);
  if (u.state === 'flee') flees++;
  N.remove(u);
}
// стрельба рядом вооружённого не пугает
const calm = N.create(K.CIV, me.x + 4, me.y, { w: W.RIFLE, hp: 70 });
N.noise(me.x, me.y, 11);
console.log(`вооружённый ответил ${fights} из 20, безоружный убежал ${flees} из 20; от выстрелов рядом вооружённый: ${calm.state}`);
assert.ok(fights === 20 && flees === 20, 'вооружённый отстреливается, безоружный убегает');
assert.ok(calm.state !== 'flee', 'вооружённый от стрельбы рядом не убегает');
N.remove(calm);

// 2. вооружённый водитель после выстрела не уезжает в панике и не убегает: давит, стреляет из окна или выходит драться
const create0 = N.create.bind(N);
N.create = (kind, x, y, o) => create0(kind, x, y, Object.assign({}, o, o && o.state === 'incar' ? { w: W.PISTOL } : {}));
const acts = {};
for (let i = 0; i < 30; i++) {
  const v = V.create(me.x + 30, me.y + 30 + i * 0.01, 0, 1, 'traffic', null);
  N.driverReact(v, me.id, 'shot');
  const drv = [...N.list.values()].find(n => n.kind === K.CIV && (n.veh === v.id || (Math.hypot(n.x - v.x, n.y - v.y) < 4 && n.state === 'fight')));
  const act = v.state === 'npc' ? v.role : drv ? drv.state : 'нет';
  acts[act] = (acts[act] || 0) + 1;
  N.removeCar(v);
  if (drv) N.remove(drv);
  V.remove(v);
}
N.create = create0;
console.log('вооружённые водители:', JSON.stringify(acts));
assert.ok(!acts.flee && !acts.cruise && Object.keys(acts).every(a => a === 'ram' || a === 'driveby' || a === 'fight'), 'вооружённый водитель не убегает');

// 3. полицейская машина: дробовик с полным запасом и +50 брони, один раз; грузовик спецназа: автомат и броня 100
function carNear(kind) {
  const r = room.map.roads.x[1] || room.map.roads.x[0];
  for (let i = 0; i < 60; i++) {
    const x = r[0] + 2, y = 20 + i * 1.7;
    if (KV.carOverlapsSolid(room.map, x, y, Math.PI / 2, 0.05, null) || !KV.circleFree(room.map, x + CAR.HW + 0.7, y, KV.PLAYER_R)) continue;
    if ([...V.list.values()].some(o => !o.dead && Math.hypot(o.x - x, o.y - y) < 7)) continue;
    const v = V.create(x, y, Math.PI / 2, 6, 'parked', null);
    if (kind === 'swat') V.setKind(v, 'swat'); else v.kind = kind;
    room.teleport(me, x + CAR.HW + 0.7, y);
    return v;
  }
  return null;
}
me.ar = 0; me.ammo[W.SHOTGUN] = -1; me.ammo[W.RIFLE] = -1; me.cur = W.FISTS;
const pol = carNear('police');
assert.ok(V.enter(me, pol.id), 'в полицейскую машину можно сесть');
const got1 = { sg: me.ammo[W.SHOTGUN], ar: me.ar, cur: me.cur };
V.exit(me, true);
me.ar = 10;
V.enter(me, pol.id);
const again = me.ar;
V.exit(me, true);
console.log(`полицейская машина: дробовик ${got1.sg}/${WEAPONS[W.SHOTGUN].max}, броня ${got1.ar}, в руках ${WEAPONS[got1.cur].name}; второй раз броня ${again}; сообщений ${ws.msgs.length}`);
assert.ok(got1.sg === WEAPONS[W.SHOTGUN].max && got1.ar === 50 && got1.cur === W.SHOTGUN, 'полицейская машина: дробовик и +50 брони');
assert.ok(again === 10 && ws.msgs.length === 1, 'с одной машины - один раз');
me.ar = 30;
const swat = carNear('swat');
V.enter(me, swat.id);
console.log(`грузовик спецназа: автомат ${me.ammo[W.RIFLE]}/${WEAPONS[W.RIFLE].max}, броня ${me.ar}`);
assert.ok(me.ammo[W.RIFLE] === WEAPONS[W.RIFLE].max && me.ar === 100, 'грузовик спецназа: автомат и броня до 100');
V.exit(me, true);

// 4. скорая лечит 3 здоровья в секунду, пока сидишь
const amb = carNear('amb');
me.hp = 40;
V.enter(me, amb.id);
for (let i = 0; i < 5 * KV.TICK_RATE; i++) { room.time += DT; V.update(DT); }
const healed = me.hp;
V.exit(me, true);
console.log(`скорая: за 5 с здоровье 40 -> ${healed.toFixed(1)}`);
assert.ok(Math.abs(healed - 55) < 0.6, 'в скорой +3 здоровья в секунду');

// 5. аптечек вдвое больше: за 10 минут игры их появляется вдвое больше, чем раньше (~0.55 раза в 13 с)
let meds = 0;
const add0 = room.addPickup.bind(room);
room.addPickup = (kind, ...rest) => { if (kind === PK.HEALTH) meds++; return add0(kind, ...rest); };
const t0 = room.time;
for (let i = 0; i < 600 * KV.TICK_RATE; i++) { room.time += DT; room.updatePickups(); }
room.addPickup = add0;
const before = (600 / 13) * 0.55;
console.log(`аптечек за 10 минут: ${meds} (раньше было бы около ${before.toFixed(0)})`);
assert.ok(meds >= before * 1.6, 'аптечек примерно вдвое больше');
void t0;

// 6. огнемёт вдвое сильнее: горящий игрок теряет 6 здоровья за 0.25 с (было 3)
me.hp = 100; me.ar = 0; me.prot = 0; me.burnUntil = room.time + 1; me.burnT = 0; me.burnBy = 0;
for (let i = 0; i < KV.TICK_RATE; i++) { room.time += DT; room.updateBurning(); }
console.log(`горение за 1 с: здоровье 100 -> ${me.hp.toFixed(0)}; огнемёт: урон струи ${WEAPONS[W.FLAMER].dmg}, по машине ${WEAPONS[W.FLAMER].carDmg}`);
// за 1 с успевает 3-4 «тика» горения: раньше это 9-12 урона, теперь 18-24
assert.ok(100 - me.hp >= 17 && WEAPONS[W.FLAMER].dmg === 10, 'огнемёт и горение вдвое сильнее по людям');

// 7. после гриба выносливость не кончается
me.hp = 100; me.burnUntil = 0;
me.tripUntil = room.time + 10; me.sprint = true; me.stamina = 50;
for (let i = 0; i < 3 * KV.TICK_RATE; i++) { room.time += DT; me.lastMoveTime = room.time; room.updateStamina(); }
console.log(`гриб: выносливость за 3 с рывка ${me.stamina} из ${STAMINA.MAX}`);
assert.strictEqual(me.stamina, STAMINA.MAX, 'после гриба выносливость не кончается');

console.log('perks: OK');
