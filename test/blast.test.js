'use strict';
/* Взрыв убивает жителей рядом: до 3 м (у взорвавшейся машины - от кузова) насмерть, за стеной - только ранит,
   дальше - ранит; игрока ранит, как раньше. Так от любого взрыва: машина, ракета, бочка. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { K } = require('../game/npcs');
const { B, G, W, WEAPONS } = KV;
const DT = 1 / KV.TICK_RATE;

class FakeWs { constructor() { this.readyState = 1; this.bufferedAmount = 0; } send() {} }
// ровная площадка без препятствий
const R = new Room('blast' + Math.random().toString(36).slice(2, 6));
for (const id of [...R.players.keys()]) R.players.delete(id);
for (const v of [...R.vehicles.list.values()]) R.vehicles.remove(v);
for (const n of [...R.npcs.list.values()]) R.npcs.remove(n);
R.map.block.fill(0);
R.map.ground.fill(G.ROAD);
R.map.owner.fill(-1);
R.vehicles.nextTrafficAt = 1e9;
const N = R.npcs, V = R.vehicles, m = R.map;
const at = (x, y) => y * m.w + x;
const npc = (kind, x, y) => N.create(kind, x, y, { hp: kind === K.SWAT ? 130 : kind === K.ARMY ? 120 : kind === K.COP ? 100 : 70 });

// 1. машина взорвалась (кузов 4x1.9 м, центр 40,60): полиция, спецназ, армия, прохожий в 3 м от кузова погибают
const car = V.create(40, 60, 0, 1, 'parked', null);
const cop = npc(K.COP, 43.5, 60);       // 1.5 м от переднего бампера
const swat = npc(K.SWAT, 40, 62.5);     // 1.55 м от борта
const army = npc(K.ARMY, 36, 60);       // 2 м от заднего бампера
const civ = npc(K.CIV, 44.8, 60);       // 2.8 м от бампера (до центра 4.8 м - дальше радиуса урона)
const far = npc(K.COP, 40, 64.35);      // 3.4 м от борта - не насмерть, только задело
for (let x = 37; x <= 43; x++) { m.block[at(x, 57)] = B.CONCRETE; m.hp[at(x, 57)] = 1e6; }
const hidden = npc(K.COP, 40, 56.4);    // 2.65 м от борта, но за бетонной стеной
const p = R.addHuman(new FakeWs(), 'Игрок');
R.teleport(p, 38, 62.7);                // игрок в 1.75 м от борта
p.prot = 0; p.hp = 100; p.ar = 0;
car.lastAttacker = p.id;
V.explodeVehicle(car);
const st = n => (n.alive ? `жив ${Math.ceil(n.hp)}/${n.maxHp}` : 'погиб');
console.log(`машина: полиция ${st(cop)}, спецназ ${st(swat)}, армия ${st(army)}, прохожий ${st(civ)}; в 3.4 м ${st(far)}; за стеной ${st(hidden)}; игрок ${Math.ceil(p.hp)}`);
assert.ok(!cop.alive && !swat.alive && !army.alive && !civ.alive, 'все NPC в 3 м от взорвавшейся машины погибают');
assert.ok(far.alive && hidden.alive && hidden.hp < hidden.maxHp, 'дальше 3 м и за стеной - живы (за стеной ранен)');
assert.ok(p.alive && p.hp < 100 && p.hp > 30, 'игрока взрыв машины ранит, как раньше');
assert.ok(p.copKills >= 3, 'погибшие от взорванной игроком машины полицейские идут в его счёт');

// 2. ракета: в 2.5 м - насмерть, в 3.3 м (внутри радиуса 3.6) - ранен
const c2 = npc(K.COP, 72.5, 60), c3 = npc(K.COP, 73.3, 60);
R.explode(70, 60, WEAPONS[W.LAUNCHER].blast, 0, W.LAUNCHER);
console.log(`ракета: в 2.5 м ${st(c2)}, в 3.3 м ${st(c3)}`);
assert.ok(!c2.alive && c3.alive && c3.hp < c3.maxHp, 'ракета: в 3 м насмерть, дальше ранит');

// 3. бочка: взрывается от выстрела, спецназ в 1.6 м погибает
m.block[at(90, 60)] = B.BARREL; m.hp[at(90, 60)] = 25;
const s2 = npc(K.SWAT, 92, 60.5);
R.destroyTile(at(90, 60), 0);
for (let i = 0; i < 10; i++) { R.time += DT; R.updatePending(); }
console.log(`бочка: спецназ в 1.6 м ${st(s2)}`);
assert.ok(!s2.alive, 'взрыв бочки убивает NPC рядом');

console.log('blast: OK');
