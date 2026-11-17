'use strict';
/* Пробки (17.11.2026): машина с водителем, упёршаяся в брошенную машину на своей полосе, гудит один раз и через ~4 с
   сама медленно толкает её и проезжает (раньше стояла и гудела каждые 2.5 с, пока препятствие не уберут). */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const DT = 1 / KV.TICK_RATE;

class FakeWs { constructor() { this.readyState = 1; this.bufferedAmount = 0; } send() {} }
let passed = 0, tries = 0, maxHonks = 0;
const results = [];
for (let trial = 0; trial < 6; trial++) {
  const room = new Room('jam' + Math.random().toString(36).slice(2, 6));
  room.botsOn = false;
  const me = room.addHuman(new FakeWs(), 'Смотрю');
  room.fillBots();
  const V = room.vehicles;
  for (const v of [...V.list.values()]) if (v.state === 'traffic') V.remove(v);
  V.nextTrafficAt = 1e9;
  const car = V.spawnTraffic(true);
  if (!car) continue;
  tries++;
  const c = Math.cos(car.a), s = Math.sin(car.a);
  const block = V.create(car.x + c * 7, car.y + s * 7, car.a, 3, 'parked', null);
  // человек рядом (иначе застрявшую машину убирают с глаз), но не на полосе
  room.teleport(me, car.x - s * 9, car.y + c * 9);
  const bx0 = block.x, by0 = block.y;
  let honks = 0, t = 0, through = -1, path = 0, px = car.x, py = car.y;
  for (; t < 14; t += DT) {
    room.time += DT; room.tickNo++;
    room.ev.hn.length = 0;
    V.update(DT);
    honks += room.ev.hn.filter(id => id === car.id).length;
    if (car.dead) break;
    path += Math.hypot(car.x - px, car.y - py); px = car.x; py = car.y;
    if (through < 0 && path > 16) through = t; // 7 м до брошенной + её длина + запас (путь, а не прямая - мог повернуть)
  }
  const moved = Math.hypot(block.x - bx0, block.y - by0);
  results.push(`проба ${trial + 1}: гудков ${honks}, проехал через ${through < 0 ? 'не проехал' : through.toFixed(1) + ' с'}, брошенную сдвинул на ${moved.toFixed(1)} м`);
  maxHonks = Math.max(maxHonks, honks);
  if (through > 3 && honks <= 2) passed++;
}
console.log(results.join('\n'));
assert.ok(tries >= 4 && passed >= tries - 1, 'машина в пробке гудит не больше раза и через ~4 с протискивается');
// раньше за 14 с стояния выходило 5 гудков (каждые 2.5 с); теперь - по одному на пробку (их бывает две, если
// спихнутая машина снова перегородила путь)
assert.ok(maxHonks <= 2, 'в пробке гудят по разу, а не каждые 2.5 с');
console.log('traffic: OK');
