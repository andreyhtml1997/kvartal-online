'use strict';
/* Дома чинятся сами: через минуту без урона - по кирпичику раз в 0.3 с, окна тоже, трещины зарастают, крыша
   возвращается; там, где стоит игрок или лежит вещь, кирпич не встаёт; новый урон откладывает ремонт. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { B, BLOCKS, PK } = KV;
const DT = 1 / KV.TICK_RATE;

class FakeWs {
  constructor() { this.readyState = 1; this.bufferedAmount = 0; this.tl = []; this.rr = []; }
  send(s) {
    if (!s.startsWith('{"t":"e"')) return;
    const m = JSON.parse(s);
    if (m.tl) this.tl.push(...m.tl);
    if (m.rr) this.rr.push(...m.rr);
  }
}

const room = new Room('rb' + Math.random().toString(36).slice(2, 6));
room.botsOn = false;
const ws = new FakeWs();
const me = room.addHuman(ws, 'Строитель');
room.fillBots();
me.prot = 1e9;
const m = room.map;
const run = sec => { for (let i = 0, n = Math.round(sec / DT); i < n; i++) room.tick(); };
const missing = e => m.block[e[0]] !== e[1];
const cx = e => (e[0] % m.w) + 0.5, cy = e => ((e[0] / m.w) | 0) + 0.5;

// дом подальше от игрока, со стенами и окнами
const home = [me.x, me.y];
const b = m.buildings.filter(q => q.orig.length > 30 && q.orig.some(e => e[1] === B.GLASS))
  .sort((p, q) => Math.hypot(q.x - home[0], q.y - home[1]) - Math.hypot(p.x - home[0], p.y - home[1]))[0];
assert.ok(b, 'есть дом со стенами и окнами');
const bricks = b.orig.filter(e => e[1] === B.BRICK), glass = b.orig.filter(e => e[1] === B.GLASS);

// 1. ломаем: 8 кирпичей и 3 окна, ещё 3 кирпича в трещинах, крыша рушится
for (const e of [...bricks.slice(0, 8), ...glass.slice(0, 3)]) room.destroyTile(e[0], 0);
const cracked = bricks.slice(-3).map(e => e[0]);
for (const k of cracked) room.damageTile(k, BLOCKS[B.BRICK].hp * 0.6, 0);
room.collapseRoof(b);
const broken = b.orig.filter(missing).length;
const crackedN = cracked.filter(k => m.dmg[k] > 0).length;
console.log(`дом ${b.w}x${b.h}: стен и окон ${b.orig.length}, выбито ${broken}, в трещинах ${crackedN}, крыша ${b.roof ? 'есть' : 'рухнула'}`);
assert.ok(broken >= 11 && crackedN >= 1 && !b.roof, 'дом разрушен');

// на месте одного выбитого кирпича лежит аптечка, у другого стоит игрок - там кирпич не встаёт
const pkE = bricks[3], meE = bricks[6];
room.addPickup(PK.HEALTH, 0, cx(pkE), cy(pkE), 1);
const pk = [...room.pickups.values()].find(q => Math.abs(q.x - cx(pkE)) < 0.01 && Math.abs(q.y - cy(pkE)) < 0.01);
room.teleport(me, cx(meE), cy(meE));
const byMe = e => Math.abs(cx(e) - me.x) < 1.6 && Math.abs(cy(e) - me.y) < 1.6;
const byPk = e => Math.abs(cx(e) - pk.x) < 0.9 && Math.abs(cy(e) - pk.y) < 0.9;

// 2. первую минуту без урона дом не чинится
run(59);
const after59 = b.orig.filter(missing).length;
console.log(`через 59 с: выбито ${after59}`);
assert.strictEqual(after59, broken, 'первую минуту дом не чинится');

// 3. после минуты - по кирпичику раз в 0.3 с, трещины зарастают; у игрока и под аптечкой - ждёт
const t0 = room.time, tl0 = ws.tl.length, fixedAt = [];
let prev = after59;
// ждём, пока починится всё, что не заслонено игроком и аптечкой (мимо может пройти прохожий - тогда клетка подождёт)
for (let i = 0, n = Math.round(25 / DT); i < n; i++) {
  room.tick();
  const cur = b.orig.filter(missing);
  if (cur.length < prev) fixedAt.push(room.time);
  prev = cur.length;
  if (cur.every(e => byMe(e) || byPk(e)) && cracked.every(k => m.dmg[k] === 0)) break;
}
const left = b.orig.filter(missing);
const gaps = fixedAt.slice(1).map((t, i) => t - fixedAt[i]);
const back = ws.tl.slice(tl0).filter(e => (e[1] === B.BRICK || e[1] === B.GLASS) && e[2] === 0);
console.log(`ремонт: начался через ${(fixedAt[0] - t0 + 59).toFixed(1)} с после урона, клеток ${fixedAt.length} за ${(fixedAt[fixedAt.length - 1] - fixedAt[0]).toFixed(1)} с, ` +
  `шаг от ${Math.min(...gaps).toFixed(2)} с; осталось ${left.length} (у игрока ${left.filter(byMe).length}, под аптечкой ${left.filter(byPk).length}); ` +
  `трещин ${cracked.filter(k => m.dmg[k] > 0).length}; событий в браузер ${back.length}; крыша ${b.roof ? 'есть' : 'нет'}`);
assert.ok(fixedAt.length >= 3 && Math.min(...gaps) >= 0.29, 'дом чинится по кирпичику, раз в 0.3 с');
assert.ok(left.length >= 2 && left.every(e => byMe(e) || byPk(e)) && left.some(byMe) && left.some(byPk), 'игрока и вещь не замуровывает');
assert.ok(cracked.every(k => m.dmg[k] === 0 && m.hp[k] === BLOCKS[B.BRICK].hp), 'трещины заросли');
assert.ok(!b.roof, 'пока дом не целый, крыши нет');
assert.ok(back.length >= fixedAt.length, 'браузеры узнают о каждом кирпиче');

// 4. игрок отошёл, аптечку забрали - дыры заделываются, дом целый, крыша вернулась
room.teleport(me, home[0], home[1]);
room.removePickup(pk.id);
for (let i = 0; i < 15 / DT && !(b.orig.every(e => !missing(e)) && b.roof); i++) room.tick();
console.log(`отошёл и забрал аптечку: выбито ${b.orig.filter(missing).length}, крыша ${b.roof ? 'есть' : 'нет'}, событие крыши ${ws.rr.includes(b.id)}`);
assert.ok(b.orig.every(e => !missing(e)) && b.roof && ws.rr.includes(b.id), 'дом снова целый, крыша вернулась');

// 5. новый урон откладывает ремонт: выбили кирпич, через 40 с попали в дом снова - ремонт ещё через минуту
const e2 = bricks[Math.floor(bricks.length / 2)], e3 = bricks[Math.floor(bricks.length / 2) + 2];
room.destroyTile(e2[0], 0);
run(40);
room.damageTile(e3[0], 30, 0);
run(40);
const waits = missing(e2);
run(25);
console.log(`новый урон: через 40 с после второго попадания кирпич ${waits ? 'ещё ждёт' : 'уже на месте'}, через 65 с ${missing(e2) ? 'всё ещё нет' : 'на месте'}`);
assert.ok(waits && !missing(e2), 'новое попадание в дом откладывает ремонт');

console.log('rebuild: OK');
