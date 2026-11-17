'use strict';
/* Меткость: полиция, спецназ и армия мажут сильнее прохожих (решение владельца 17.11.2026 - были слишком меткими).
   Доля выстрелов, которые с 7 м летят в силуэт игрока (радиус 0.5 м), у закона меньше 15%. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { K } = require('../game/npcs');
const { W } = KV;

const R = new Room('aim' + Math.random().toString(36).slice(2, 6));
const N = R.npcs;
const angles = [];
R.spawnShot = (x, y, a) => { angles.push(a); };
const half = Math.atan2(0.5, 7);
function onTarget(kind, w) {
  angles.length = 0;
  const n = N.create(kind, 50, 50, { w });
  for (let i = 0; i < 4000; i++) { n.nextShot = 0; N.shoot(n, 57, 50, 7, 0); }
  N.remove(n);
  return angles.filter(a => Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) <= half).length / angles.length;
}
const cop = onTarget(K.COP, W.PISTOL), swat = onTarget(K.SWAT, W.RIFLE), army = onTarget(K.ARMY, W.RIFLE), civ = onTarget(K.CIV, W.PISTOL);
const pc = v => (v * 100).toFixed(1) + '%';
console.log(`с 7 м в силуэт игрока: полиция ${pc(cop)}, спецназ ${pc(swat)}, армия ${pc(army)}, прохожий с пистолетом ${pc(civ)}`);
assert.ok(cop < 0.15 && swat < 0.15 && army < 0.15, 'полиция, спецназ и армия мажут');
assert.ok(civ > cop * 1.5, 'вооружённые прохожие стреляют как раньше');
console.log('aim: OK');
