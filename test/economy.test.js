'use strict';
/* Деньги и чекпоинты (17.11.2026): карта 160x160 с больницей, оружейным магазином и двумя автомастерскими;
   за игрока $100 (бот $50), полицейского $50, спецназ $80, вертолёт $300; с прохожих выпадают пачки; погиб - половина
   денег пачкой на землю; на кругах: больница - здоровье до 100 ($50), оружейный - случайное оружие ($100), мастерская
   на машине - перекраска, ремонт, розыск снят ($1000); в мастерскую можно заехать с дороги. */
const assert = require('assert');
const KV = require('../public/shared.js');
const { Room } = require('../game/room');
const { K } = require('../game/npcs');
const { W, PK, CAR, WEAPONS, SHOP_PRICE } = KV;
const DT = 1 / KV.TICK_RATE;

class FakeWs { constructor() { this.readyState = 1; this.bufferedAmount = 0; this.shop = []; } send(s) { if (s.startsWith('{"t":"shop"')) this.shop.push(JSON.parse(s)); } }
const room = new Room('eco' + Math.random().toString(36).slice(2, 6));
room.botsOn = false;
const ws = new FakeWs();
const me = room.addHuman(ws, 'Богач');
room.fillBots();
const m = room.map, N = room.npcs;

// 1. карта и чекпоинты
const kinds = m.shops.map(s => s.kind).sort().join(',');
const reach = m.shops.every(s => m.reach[Math.floor(s.y) * m.w + Math.floor(s.x)]);
console.log(`карта ${m.w}x${m.h}, кварталов ${m.blocks.length}; чекпоинты: ${kinds}; все достижимы ${reach}`);
assert.ok(m.w === 160 && m.h === 160 && m.blocks.length === 25, 'карта 160x160, 5x5 кварталов');
assert.strictEqual(kinds, 'fix,fix,gun,med', 'больница, оружейный и две мастерские');
assert.ok(reach, 'к каждому кругу можно подойти');

// 2. деньги за убийства и с прохожих
const victim = room.addHuman(new FakeWs(), 'Жертва');
victim.money = 300;
room.kill(victim, me.id, W.PISTOL);
const afterKill = me.money;
const dropped = [...room.pickups.values()].find(pk => pk.kind === PK.MONEY && pk.amount === 150);
console.log(`убил игрока: у меня $${afterKill}; у погибшего осталось $${victim.money}, на земле пачка $${dropped ? dropped.amount : 0}`);
assert.ok(afterKill === 100 && victim.money === 150 && dropped, 'за игрока $100; погибший роняет половину денег');
me.money = 0;
const cop = N.create(K.COP, me.x + 3, me.y, { hp: 100 });
N.damage(cop, 500, me.id, W.PISTOL, cop.x, cop.y);
const swat = N.create(K.SWAT, me.x + 3, me.y, { hp: 130 });
N.damage(swat, 500, me.id, W.PISTOL, swat.x, swat.y);
console.log(`полицейский и спецназ: $${me.money}`);
assert.strictEqual(me.money, 130, 'полицейский $50, спецназ $80');
const h = N.spawnHeli(me);
N.heliDamage(h, 1000, me.id);
console.log(`сбил вертолёт: $${me.money}`);
assert.strictEqual(me.money, 430, 'сбитый вертолёт $300');
const p0 = [...room.pickups.values()].filter(pk => pk.kind === PK.MONEY).length;
for (let i = 0; i < 30; i++) { const c = N.create(K.CIV, me.x + 5, me.y + 5, { hp: 70 }); N.damage(c, 500, 0, -1, c.x, c.y); }
const drops = [...room.pickups.values()].filter(pk => pk.kind === PK.MONEY).length - p0;
console.log(`из 30 прохожих выпало пачек: ${drops}`);
assert.ok(drops >= 6 && drops <= 24, 'с прохожих иногда выпадают деньги');
const pk = room.addPickup(PK.MONEY, 0, me.x, me.y, 40);
const m0 = me.money;
assert.ok(room.tryPick(me, pk) && me.money === m0 + 40, 'пачку подбирают');

// 3. оружейный (17.11.2026): встал на круг - выбираешь на панели, у каждого оружия своя цена; уже есть - пополнить;
// миниган - самый дорогой, +1000 патронов; без денег не продают; сошёл с круга - не продают
function stand(kind, sec) {
  const s = m.shops.find(q => q.kind === kind);
  if (me.vehicle) { const v = room.vehicles.list.get(me.vehicle); v.x = s.x; v.y = s.y; me.x = s.x; me.y = s.y; } else room.teleport(me, s.x, s.y);
  for (let i = 0; i < Math.round(sec / (3 * DT)); i++) { room.time += 3 * DT; room.updateShops(); }
}
function leaveShop() { room.teleport(me, me.x + 8, me.y + 8); room.updateShops(); }
const { GUN_PRICE } = KV;
me.money = 400; ws.shop.length = 0; me.ammo[W.SHOTGUN] = -1;
stand('gun', 0.3);
const standBuys = ws.shop.filter(x => x.k === 'gun' && x.ok).length;
room.buyGun(me, W.SHOTGUN);
const shotOk = me.ammo[W.SHOTGUN] === WEAPONS[W.SHOTGUN].max && me.money === 400 - GUN_PRICE[W.SHOTGUN] && me.cur === W.SHOTGUN;
room.buyGun(me, W.SHOTGUN);
const fullNoCharge = me.money === 400 - GUN_PRICE[W.SHOTGUN] && ws.shop.some(x => x.have && x.w === W.SHOTGUN);
room.buyGun(me, W.MINIGUN);
const tooPoor = me.ammo[W.MINIGUN] < 0 && ws.shop.some(x => x.need === GUN_PRICE[W.MINIGUN]);
me.money = 1000; me.ammo[W.MINIGUN] = 2500;
room.buyGun(me, W.MINIGUN);
const mini = me.ammo[W.MINIGUN];
console.log(`оружейный: стоя ничего не куплено (${standBuys}); дробовик за $${GUN_PRICE[W.SHOTGUN]} - ${shotOk ? 'да' : 'нет'}; полный повторно - без денег ${fullNoCharge}; миниган без денег - ${tooPoor ? 'не продали' : 'продали'}; миниган при 2500 - стало ${mini}, осталось $${me.money}`);
assert.ok(standBuys === 0 && shotOk && fullNoCharge && tooPoor, 'оружейный: выбор на панели, своя цена, полное не продаёт, без денег не продаёт');
assert.ok(mini === 3500 && me.money === 0 && GUN_PRICE[W.MINIGUN] === Math.max(...GUN_PRICE.filter(Boolean)), 'миниган - самый дорогой, +1000 патронов');
leaveShop();
me.money = 500; me.ammo[W.RIFLE] = -1;
room.buyGun(me, W.RIFLE);
assert.ok(me.ammo[W.RIFLE] < 0 && me.money === 500, 'сошёл с круга - не продают');
me.money = 150;

// 4. больница (17.11.2026): лечит сразу, как встал, по +10 здоровья каждые 0.1 с, $5 за каждые 10; без денег - не лечит
me.hp = 40;
stand('med', 0.35);
const hpFast = me.hp;
stand('med', 0.5);
console.log(`больница: через 0.3 с здоровье ${hpFast}, через 0.8 с ${me.hp}, осталось $${me.money}`);
assert.ok(hpFast >= 60 && hpFast < 100 && me.hp === 100 && me.money === 120, 'больница: быстро по +10, 60 здоровья за $30');
leaveShop();
me.hp = 30; me.money = 12; ws.shop.length = 0;
stand('med', 1);
console.log(`больница без денег ($12): здоровье ${me.hp}, осталось $${me.money}`);
assert.ok(me.hp === 50 && me.money === 2 && ws.shop.some(x => x.need === SHOP_PRICE.med), 'деньги кончились - лечение встаёт');
leaveShop();
me.money = 100;

// 5. автомастерская: заезд с дороги своим ходом, потом $1000 - новый цвет, ремонт, звёзды сняты
const g = m.shops.find(q => q.kind === 'fix');
const blk = m.blocks.find(b => g.x > b.x && g.x < b.x + b.w && g.y > b.y && g.y < b.y + b.h);
const car = room.vehicles.create(g.x, blk.y - 2.5, Math.PI / 2, 2, 'parked', null);
room.teleport(me, car.x + CAR.HW + 0.7, car.y);
assert.ok(room.vehicles.enter(me, car.id), 'сел в машину на дороге у мастерской');
let inside = false;
for (let i = 0; i < 4 * KV.TICK_RATE && !inside; i++) {
  room.time += DT;
  room.vehicles.physics(car, Math.hypot(car.x - g.x, car.y - g.y) > 1 ? 0.6 : -1, 0, DT, me.id);
  me.x = car.x; me.y = car.y;
  inside = Math.hypot(car.x - g.x, car.y - g.y) < g.r * 0.6;
}
console.log(`заезд в мастерскую с дороги: ${inside ? 'заехал' : 'не заехал'} (до круга ${Math.hypot(car.x - g.x, car.y - g.y).toFixed(1)} м)`);
assert.ok(inside, 'в мастерскую можно заехать с дороги');
car.v = 0;
N.crime(me, 210);
car.hp = 60; const color0 = car.color;
me.money = 1200; ws.shop.length = 0;
const stars0 = me.stars;
room.time += 0.1;
for (let i = 0; i < Math.round(2.5 / (3 * DT)); i++) { room.time += 3 * DT; room.updateShops(); }
console.log(`мастерская: звёзды ${stars0} -> ${me.stars}, прочность ${car.hp}/${car.maxHp || CAR.HP}, цвет ${color0} -> ${car.color}, осталось $${me.money}`);
assert.ok(stars0 > 0 && me.stars === 0 && car.hp === (car.maxHp || CAR.HP) && car.color !== color0 && me.money === 200, 'мастерская: перекраска, ремонт и снятие розыска за $1000');

console.log('economy: OK');
