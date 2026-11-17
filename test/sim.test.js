'use strict';
/* Прогон комнаты без сети: живой «игрок»-заглушка + боты, 3 минуты игрового времени. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');

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

// «игрок» стоит на месте и стреляет по ближайшему боту из пистолета
me.ammo[KV.W.PISTOL] = 500;
const stats = { kills: 0, tiles: 0, destroyed: 0, roofs: 0, cars: 0, pickups: 0, picked: 0, explosions: 0, bullets: 0 };
const T = 180 * KV.TICK_RATE;
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
    if (p.alive && p.isBot) assert.ok(KV.circleFree(room.map, p.x, p.y, KV.PLAYER_R * 0.8), `бот ${p.name} застрял в стене`);
  }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
for (const m of ws.msgs) {
  if (m.t !== 'e') continue;
  stats.kills += (m.k || []).length;
  stats.tiles += (m.tl || []).length;
  stats.destroyed += (m.tl || []).filter(e => e.length === 5).length;
  stats.roofs += (m.rf || []).length;
  stats.cars += (m.od || []).length;
  stats.pickups += (m.pa || []).length;
  stats.picked += (m.pu || []).length;
  stats.explosions += (m.x || []).length;
  stats.bullets += (m.b || []).length;
}
const snaps = ws.msgs.filter(m => m.t === 's').length;
console.log(`180 с игры за ${ms.toFixed(0)} мс (${(ms / T).toFixed(3)} мс на такт); стартовая карта ${(welcomeBytes / 1024).toFixed(1)} КБ;` +
  ` трафик ${(ws.bytes / 1024 / 180).toFixed(1)} КБ/с; снимков ${snaps}`);
console.log(JSON.stringify(stats));
assert.ok(snaps > 2500, 'снимки идут 15 раз в секунду');
assert.ok(stats.bullets > 100, 'стреляют');
assert.ok(stats.kills > 0, 'кто-то погиб');
assert.ok(stats.destroyed > 0, 'клетки разрушаются');
assert.ok(stats.pickups >= 10, 'оружие появляется примерно раз в 15 с');
assert.ok(stats.picked > 0, 'оружие подбирают');
assert.ok(ms / T < 3, 'такт укладывается в бюджет');

// удаление игрока убирает и ботов (комната засыпает)
room.removePlayer(me.id);
assert.strictEqual(room.humanCount(), 0);
assert.strictEqual(room.players.size, 0, 'без людей боты не нужны');
console.log('sim: OK');
