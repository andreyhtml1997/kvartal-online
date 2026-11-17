'use strict';
/*
 * Стрельба по нажатию. Браузер шлёт ввод каждые 50 мс: f - атака зажата, q - новое нажатие.
 * Короткое нажатие - ровно один выстрел (раньше каждое сообщение с зажатой атакой заново взводило
 * флаг нажатия, и через перезарядку вылетал второй выстрел). Зажатая атака - очередь по перезарядке.
 */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { W } = KV;
const TICK_MS = 1000 / KV.TICK_RATE;

// msgs: [[мс, {f, q}], ...] - когда какое сообщение приходит на сервер; возвращает число выстрелов за durMs
function play(weapon, msgs, durMs) {
  const room = new Room('fire' + Math.random().toString(36).slice(2, 6));
  room.botsOn = false;
  room.fillBots();
  const p = room.createPlayer('Стрелок', false);
  room.spawn(p);
  p.ammo[weapon] = 100;
  p.cur = weapon;
  let mi = 0;
  for (let t = 0; t <= durMs; t += TICK_MS) {
    while (mi < msgs.length && msgs[mi][0] <= t) room.onInput(p, Object.assign({ t: 'i', a: 0 }, msgs[mi++][1]));
    room.time += 1 / KV.TICK_RATE;
    room.updateFiring(p);
  }
  return 100 - p.ammo[weapon];
}

// зажал на ms миллисекунд: первое сообщение с q, дальше каждые 50 мс «зажато», в конце «отпустил»
function hold(at, ms) {
  const l = [[at, { f: 1, q: 1 }]];
  for (let t = 50; t < ms; t += 50) l.push([at + t, { f: 1 }]);
  l.push([at + ms, { f: 0 }]);
  return l;
}

const cases = [
  ['короткое нажатие 150 мс (три сообщения «зажато»)', W.PISTOL, hold(0, 150), 1200, 1],
  ['быстрый тап между двумя отправками', W.PISTOL, [[0, { f: 0, q: 1 }]], 1200, 1],
  ['зажал на 600 мс - очередь по перезарядке', W.PISTOL, hold(0, 600), 1200, 3],
  ['два нажатия подряд, второе во время перезарядки', W.PISTOL, hold(0, 100).concat(hold(150, 100)), 1200, 2],
  ['снайперка: нажатие задолго до конца перезарядки не стреляет с опозданием', W.SNIPER, hold(0, 50).concat(hold(300, 50)), 2500, 1],
  ['старый браузер без q: короткое нажатие - один выстрел', W.PISTOL, [[0, { f: 1 }], [50, { f: 1 }], [100, { f: 1 }], [150, { f: 0 }]], 1200, 1]
];
for (const [name, w, msgs, dur, want] of cases) {
  const got = play(w, msgs, dur);
  console.log(`${name}: выстрелов ${got}, ждём ${want}`);
  assert.strictEqual(got, want, name);
}
console.log('fire: OK');
