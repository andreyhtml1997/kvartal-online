'use strict';
/* Жители: прохожие на тротуарах, реакция на нападение, оружие убитого, водители, звёзды, полиция, звезда погашения, скорая, футболисты. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { K } = require('../game/npcs');
const { W, PK, G } = KV;
const DT = 1 / KV.TICK_RATE;

class FakeWs { constructor() { this.readyState = 1; this.bufferedAmount = 0; } send() {} }
const room = new Room('npc' + Math.random().toString(36).slice(2, 6));
room.botsOn = false;
const me = room.addHuman(new FakeWs(), 'Проверка');
room.fillBots();
me.prot = 1e9; // в тесте игрока не убить
const N = room.npcs;
let ticks = 0;
const t0 = process.hrtime.bigint();
function run(sec, each) { for (let i = 0, n = Math.round(sec / DT); i < n; i++) { room.tick(); ticks++; if (each) each(i); } }
const near = r => [...N.list.values()].filter(n => n.alive && n.state !== 'incar' && Math.hypot(n.x - me.x, n.y - me.y) < r);

// 1. прохожие появляются вокруг игрока, ходят по тротуарам и не застревают в стенах
let onWalk = 0, samples = 0, inWall = 0;
run(25, i => {
  if (i % 30) return;
  for (const n of N.list.values()) {
    if (!n.alive || n.state !== 'walk') continue;
    samples++;
    const g = room.map.ground[Math.floor(n.y) * room.map.w + Math.floor(n.x)];
    if (g === G.WALK) onWalk++;
    if (!KV.circleFree(room.map, n.x, n.y, KV.PLAYER_R * 0.8)) inWall++;
  }
});
const ped = near(40).filter(n => n.kind === K.CIV);
console.log(`прохожих в 40 м: ${ped.length}; по тротуару ${(100 * onWalk / Math.max(1, samples)).toFixed(0)}% времени; в стене ${inWall}`);
assert.ok(ped.length >= 6, 'вокруг игрока ходят прохожие');
assert.ok(onWalk / Math.max(1, samples) > 0.85, 'прохожие ходят по тротуарам');
assert.strictEqual(inWall, 0, 'прохожие не застревают в стенах');

// 2. нападение: раненый убегает или отстреливается; убитый вооружённый роняет оружие; звезда розыска
const victim = ped[0];
victim.w = W.PISTOL;
N.damage(victim, 10, me.id, W.PISTOL, victim.x, victim.y);
console.log(`раненый прохожий: ${victim.state}`);
assert.ok(victim.state === 'flee' || victim.state === 'fight', 'раненый убегает или отвечает');
const pk0 = room.pickups.size;
N.damage(victim, 200, me.id, W.PISTOL, victim.x, victim.y);
const dropped = [...room.pickups.values()].some(pk => pk.kind === PK.WEAPON && Math.hypot(pk.x - victim.x, pk.y - victim.y) < 1);
console.log(`убит: оружие выпало ${dropped}, вещей ${pk0} -> ${room.pickups.size}; звёзд ${me.stars}, мирных убито ${me.civKills}`);
assert.ok(!victim.alive && dropped, 'оружие убитого падает на землю');
assert.ok(me.stars >= 1 && me.civKills === 1, 'за убийство мирного - звезда розыска и строка в счёте');

// 3. водитель машины с водителем после выстрела не исчезает: реагирует (уезжает, выходит, давит, стреляет)
const car = [...room.vehicles.list.values()].find(v => v.state === 'traffic');
room.vehicles.damage(car, 5, me.id);
const drv = [...N.list.values()].find(n => n.veh === car.id || (n.kind === K.CIV && Math.hypot(n.x - car.x, n.y - car.y) < 4 && n.state !== 'walk'));
console.log(`обстрелянная машина: ${car.state}${car.role ? ' / ' + car.role : ''}; водитель: ${drv ? drv.state : 'нет'}`);
assert.ok(car.state !== 'traffic' && drv, 'водитель отвечает на нападение и остаётся жителем');

// 4. две звезды - полиция с мигалками едет к игроку и стреляет на поражение
N.crime(me, 80);
assert.ok(me.stars >= 2, 'вторая звезда');
let minD = 1e9, cops = 0, siren = false, offscreen = 0, atMe = 0;
// никто не стреляет по игроку из-за края его экрана («из пустоты»)
const spawnShot0 = room.spawnShot.bind(room);
room.spawnShot = (x, y, a, w, owner, veh, aimD, npcId) => {
  const toMe = Math.atan2(me.y - y, me.x - x);
  if (owner !== me.id && Math.abs(Math.atan2(Math.sin(a - toMe), Math.cos(a - toMe))) < 0.3 && Math.hypot(me.x - x, me.y - y) < 40) {
    atMe++;
    if (Math.abs(x - me.x) > me.view[0] || Math.abs(y - me.y) > me.view[1]) offscreen++;
  }
  return spawnShot0(x, y, a, w, owner, veh, aimD, npcId);
};
run(30, i => {
  if (i % 15) return;
  for (const v of room.vehicles.list.values()) if (v.kind === 'police' && !v.dead) { minD = Math.min(minD, Math.hypot(v.x - me.x, v.y - me.y)); if (v.siren) siren = true; }
  for (const n of N.list.values()) if (n.kind === K.COP && n.alive && n.state !== 'incar') minD = Math.min(minD, Math.hypot(n.x - me.x, n.y - me.y));
});
cops = [...N.list.values()].filter(n => n.kind === K.COP && n.alive && n.state === 'fight' && n.target === me.id).length;
const pcars = [...room.vehicles.list.values()].filter(v => v.kind === 'police' && !v.dead).length;
room.spawnShot = spawnShot0;
console.log(`полиция: машин ${pcars}, мигалки ${siren}, ближе всего ${minD.toFixed(1)} м, полицейских в бою ${cops}; выстрелов в игрока ${atMe}, из-за края экрана ${offscreen}`);
assert.strictEqual(offscreen, 0, 'по игроку не стреляют из-за края экрана');
assert.ok(pcars >= 1 && siren, 'приехала полиция с мигалками');
assert.ok(minD < 15, 'полиция добралась до игрока');

// 5. звезда погашения гасит одну звезду; смерть гасит все
const s0 = me.stars;
room.addPickup(PK.STAR, 0, me.x, me.y, 1);
room.updatePickups();
console.log(`звезда погашения: ${s0} -> ${me.stars}`);
assert.strictEqual(me.stars, s0 - 1, 'подобрал звезду - минус одна звезда');
room.kill(me, 0, 0);
assert.strictEqual(me.stars, 0, 'смерть гасит розыск');
run(4);
room.spawn(me); me.prot = 1e9;

// 6. скорая: к убитому мирному приезжает врач и поднимает его
// после возрождения в новом месте прохожие подходят не сразу (появляются за краем экрана)
let body = null;
for (let i = 0; i < 25 && !body; i++) { run(1); body = near(40).find(n => n.kind === K.CIV && n.ambient); }
assert.ok(body, 'есть прохожий для проверки скорой');
N.damage(body, 500, 0, -1, body.x, body.y);
let amb = false, revived = false;
run(120, () => { if (!amb) amb = [...room.vehicles.list.values()].some(v => v.kind === 'amb'); if (body.alive) revived = true; });
if (!revived) console.log('скорая не успела:', [...room.vehicles.list.values()].filter(v => v.kind === 'amb').map(v => v.state + '/' + v.role + ' ' + Math.hypot(v.x - body.x, v.y - body.y).toFixed(1)).join('; '),
  '| врачи:', [...N.list.values()].filter(n => n.kind === K.MEDIC).map(n => (n.alive ? n.state : 'dead') + '/' + (n.phase || '') + ' ' + Math.hypot(n.x - body.x, n.y - body.y).toFixed(1)).join('; '), '| тело amb', body.amb);
console.log(`скорая: выехала ${amb}, человек встал ${revived}`);
assert.ok(amb, 'к убитому выезжает скорая');
assert.ok(revived, 'врач поднимает убитого');

// 7. футболисты бегают вокруг парка; задели одного - разбегаются все
const park = N.loops.find(l => l.b.kind === 'park');
const spot = [[park.cx, park.y0 - 4], [park.cx, park.y1 + 4], [park.x0 - 4, park.cy], [park.x1 + 4, park.cy]].find(([x, y]) => KV.circleFree(room.map, x, y, KV.PLAYER_R));
me.x = spot[0]; me.y = spot[1];
me.view = [8, 6];
N.nextTeamAt = 0;
let team = null;
for (let i = 0; i < 20 && !N.team; i++) { N.nextTeamAt = 0; N.spawnTeam(); run(0.5); }
team = N.team;
assert.ok(team && team.members.length === 11, 'команда из 10 футболистов и тренера');
const first = N.list.get(team.members[3]);
const p0 = [first.x, first.y];
run(4);
const jog = Math.hypot(first.x - p0[0], first.y - p0[1]);
console.log(`футболисты: ${team.members.length} человек, за 4 с пробежали ${jog.toFixed(1)} м`);
assert.ok(jog > 8, 'команда бежит трусцой');
N.damage(first, 5, me.id, W.PISTOL, first.x, first.y);
const fled = team.members.map(id => N.list.get(id)).filter(n => n && n.alive && n.state === 'flee').length;
console.log(`задели футболиста: разбегаются ${fled} из ${team.members.length}, команда ${N.team ? 'осталась' : 'распалась'}`);
assert.ok(!N.team && fled >= 9, 'задели одного - разбегаются все');

const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`такт с жителями и полицией: ${(ms / ticks).toFixed(3)} мс; жителей в комнате ${N.list.size}`);
assert.ok(ms / ticks < 3, 'жители укладываются в бюджет такта');
console.log('npcs: OK');
