'use strict';
/*
 * Комната = отдельная карта и партия «все против всех» с возрождением.
 * Сервер главный во всём, кроме шагов игрока и руля его машины: их присылает браузер,
 * а сервер проверяет скорость и стены и при обмане возвращает назад. Пули, взрывы, урон,
 * разрушение клеток, оружие и ящики на карте, машины с водителями и боты считаются только на сервере.
 */
const KV = require('../public/shared.js');
const { generateMap } = require('./mapgen');
const geom = require('./geom');
const { Bots } = require('./bots');
const { Vehicles } = require('./vehicles');
const { Npcs, LAW_SHOT } = require('./npcs');
const LAW_CAR = { police: true, swat: true, tank: true }; // машины закона: пули полиции, спецназа и армии их не портят
const { G, B, BLOCKS, W, WEAPONS, WEAPON_WEIGHTS, PK, CAR, STAMINA } = KV;

const DT = 1 / KV.TICK_RATE;
const MAX_HUMANS = 16;
const MIN_PLAYERS = 10;         // боты добирают до этого числа
const MAX_PICKUPS = 48;
const CAR_BULLET = 0.6;         // пули по машине - доля урона по человеку (как было до 17.11: сильнее - машины слишком хрупкие)
const HELI_BULLET = 1;          // пули по вертолёту - доля урона по человеку (сбить: ~25 попаданий из автомата)
const TANK_RELOAD = 1.6;        // с между снарядами танка игрока
const BURN_DMG = 6;             // урон горящему игроку за 0.25 с (огнемёт вдвое сильнее - 17.11.2026; было 3)
const MED_EVERY = [20, 28];     // с: отдельные аптечки сверх обычных припасов - аптечек вдвое больше (17.11.2026)
const SHOP_TIME = { fix: 2 };   // с: сколько постоять в мастерской; больница лечит сразу, оружейный - по выбору на панели
const MED_STEP = 10;            // больница: столько здоровья за одну порцию (каждые 0.1 с)
const GRENADE_DRAG = 2.2;       // 1/с: брошенная граната тормозит и за ~2 с долетает до точки прицела
const SHROOM_DMG = 0.5;         // какая доля урона доходит, пока действует гриб (решение владельца 17.11.2026)
const REBUILD_DELAY = 60;       // с без урона - и разрушенный дом начинает чиниться сам
const REBUILD_EVERY = 9;        // тактов между кирпичами одного дома (0.3 с)
const PICKUP_LIFE = 120;        // с
const PRESS_LATCH = 0.3;        // с: нажатие во время перезарядки стреляет, только если она кончится за это время
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45',
  '#fabed4', '#469990', '#dcbeff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#ffd8b1', '#a9a9a9', '#ffe119'];
const BOT_NAMES = ['Шустрый', 'Бородач', 'Кепка', 'Гвоздь', 'Сова', 'Тихий', 'Мотор', 'Лапша', 'Пиксель', 'Сухарь', 'Ёжик', 'Бублик', 'Жук', 'Кабан'];
// деревянное: загорается от огнемёта и сгорает
const WOOD = [];
[B.FENCE, B.CRATE, B.BENCH, B.TREE].forEach(t => { WOOD[t] = true; });

const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;

function emptyEvents() {
  // b - пули, be - конец пули, x - взрывы, tl - клетки, rf - обрушение крыш, k - убийства, hu - попадания,
  // pa/pr/pu - вещи на карте (появилась/исчезла/подобрана), pj/pl - вход/выход игроков, sp - возрождения,
  // m - удары кулаком; машины: en/ex - сел/вышел, hn - гудок, ck - сбила человека, cr - удар, vf - загорелась,
  // vx - взорвалась, fl - водитель убегает; tf/tfx - деревянная клетка загорелась/погасла
  return {
    b: [], be: [], x: [], tl: [], rf: [], k: [], hu: [], pa: [], pr: [], pu: [], pj: [], pl: [], sp: [], m: [],
    en: [], ex: [], hn: [], ck: [], cr: [], vf: [], vx: [], fl: [], bo: [], tf: [], tfx: [], vc: [],
    nh: [], nk: [], rv: [], ws: [], // жители: попадание, смерть, вылечен; звёзды розыска игрока
    hf: [], hx: [], // вертолёт сбит (падает); вертолёт исчез (разбился или улетел)
    rr: [], // дом снова целый - вернулась крыша
    gt: [] // брошена граната (звук)
  };
}

class Room {
  constructor(id, opts) {
    this.id = id;
    // режим «Банда» (17.11.2026): все люди в комнате - одна банда: друг друга не ранят, розыск общий (npcs.gang*);
    // боты, если их включить, - чужие. Режим задаётся при создании комнаты и не меняется
    this.gang = !!(opts && opts.gang);
    this.seed = (Math.random() * 4294967296) >>> 0;
    this.map = generateMap(this.seed);
    this.players = new Map();
    this.nextId = 1;
    this.bullets = [];
    this.nextBullet = 1;
    this.pickups = new Map();
    this.nextPickup = 1;
    this.pending = [];            // отложенные взрывы (цепные реакции)
    this.grenades = [];           // брошенные гранаты: летят, отскакивают от стен, взрываются
    this.nextGrenade = 1;
    this.recentShots = [];        // куда идут боты на звук
    this.time = 0;
    this.tickNo = 0;
    this.nextWeaponAt = 3;
    this.nextSupplyAt = 15;
    this.nextCrateAt = 6;
    this.nextShroomAt = 12;
    this.nextMedAt = 8;
    this.tileFires = new Map();   // горящие деревянные клетки: k -> { until, by, next }
    this.crates = this.map.crates;
    this.initRebuild();
    this.ev = emptyEvents();
    this.emptySince = Date.now();
    this.sbDirty = true;
    this.botsOn = false;          // переключатель «Боты» под шестерёнкой, на всю комнату; по умолчанию выключены (решение владельца 17.11.2026)
    this.bots = new Bots(this);
    this.vehicles = new Vehicles(this);
    this.npcs = new Npcs(this);
    this.nextStarAt = 4;
    this.fillBots();
  }

  // ---------- игроки ----------
  humanCount() { let n = 0; for (const p of this.players.values()) if (!p.isBot) n++; return n; }

  pickColor() {
    const used = new Set([...this.players.values()].map(p => p.color));
    return COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
  }

  createPlayer(name, isBot) {
    const p = {
      id: this.nextId++, name, isBot, ws: null, color: this.pickColor(),
      x: 0, y: 0, a: 0, hp: 0, ar: 0, alive: false, respawnAt: 0,
      ammo: KV.emptyAmmo(), cur: 0, fire: false, fireLatch: false, latchAt: 0, nextShot: 0,
      kills: 0, deaths: 0, prot: 0, tp: 0, budget: 0, lastMoveTime: 0, shotAt: -10,
      view: [24, 16], ai: null, vehicle: 0, stamina: STAMINA.MAX, staminaT: 0, sprint: false, hornAt: -10,
      rollUntil: 0, rollVx: 0, rollVy: 0, burnUntil: 0, burnBy: 0, burnT: 0, tripUntil: 0,
      voice: false, talkUntil: 0, vWin: 0, vCount: 0, heat: 0, stars: 0, civKills: 0, copKills: 0,
      money: 0, shopAt: -1, shopT: 0, shopDone: false
    };
    this.players.set(p.id, p);
    return p;
  }

  publicInfo(p) { return [p.id, p.name, p.color, p.isBot ? 1 : 0, p.kills, p.deaths, p.civKills || 0, p.copKills || 0]; }

  addHuman(ws, name) {
    if (this.humanCount() >= MAX_HUMANS) return null;
    const p = this.createPlayer(name, false);
    p.ws = ws;
    this.emptySince = null;
    this.fillBots();
    this.send(p, this.welcome(p));
    this.ev.pj.push(this.publicInfo(p));
    if (this.gang) this.npcs.gangJoin(p);
    this.spawn(p);
    this.sbDirty = true;
    return p;
  }

  removePlayer(id, fromFill) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.vehicle) {
      const v = this.vehicles.list.get(p.vehicle);
      if (v) { v.state = 'parked'; v.driver = 0; v.tp++; }
      p.vehicle = 0;
    }
    this.players.delete(id);
    this.ev.pl.push(id);
    if (!p.isBot && this.humanCount() === 0) {
      this.emptySince = Date.now();
      if (this.gang) this.npcs.setGang(0, 0); // банда разошлась - розыск не дожидается вернувшихся
    }
    if (!fromFill) this.fillBots();
    this.sbDirty = true;
  }

  fillBots() {
    const humans = this.humanCount();
    const bots = [...this.players.values()].filter(p => p.isBot);
    const want = !this.botsOn || (humans === 0 && this.tickNo > 0) ? 0 : Math.max(0, MIN_PLAYERS - humans);
    let n = bots.length;
    while (n < want) {
      const used = new Set(bots.map(b => b.name));
      const name = (BOT_NAMES.find(nm => !used.has(nm + ' (бот)')) || 'Бот') + ' (бот)';
      const b = this.createPlayer(name, true);
      bots.push(b);
      this.ev.pj.push(this.publicInfo(b));
      this.spawn(b);
      n++;
    }
    while (n > want) {
      const b = bots.sort((a, c) => (a.alive - c.alive) || (a.kills - c.kills)).shift();
      this.removePlayer(b.id, true);
      n--;
    }
  }

  spawn(p) {
    const m = this.map;
    const tiles = m.spawnTiles;
    let best = tiles[Math.floor(Math.random() * tiles.length)], bestScore = -1;
    const near = this.gang && !p.isBot ? this.spawnNearMate(p) : -1;
    if (near >= 0) { best = near; bestScore = 1e9; }
    for (let i = 0; i < 28 && near < 0; i++) {
      const k = tiles[Math.floor(Math.random() * tiles.length)];
      const x = (k % m.w) + 0.5, y = Math.floor(k / m.w) + 0.5;
      if (!KV.circleFree(m, x, y, KV.PLAYER_R) || this.vehicles && this.vehicles.personBlocked(x, y, null)) continue;
      let dmin = 60;
      for (const o of this.players.values()) if (o !== p && o.alive) dmin = Math.min(dmin, Math.hypot(o.x - x, o.y - y));
      if (dmin > bestScore) { bestScore = dmin; best = k; }
    }
    p.x = (best % m.w) + 0.5;
    p.y = Math.floor(best / m.w) + 0.5;
    p.hp = KV.MAX_HP; p.ar = 0; p.alive = true; p.vehicle = 0;
    p.ammo = KV.emptyAmmo(); p.cur = W.FISTS;
    p.rollUntil = 0; p.burnUntil = 0; p.tripUntil = 0;
    p.fire = false; p.fireLatch = false; p.sprint = false; p.stamina = STAMINA.MAX;
    p.prot = this.time + KV.SPAWN_PROTECT;
    p.budget = 0; p.lastMoveTime = this.time;
    p.tp++;
    if (p.ai) { p.ai.path = null; p.ai.target = null; p.ai.carGoal = 0; }
    this.ev.sp.push([p.id, r2(p.x), r2(p.y)]);
    this.send(p, { t: 'tp', x: p.x, y: p.y, tp: p.tp, sp: 1, veh: 0 });
  }

  // Банда: возрождаемся в 6-16 м от живого товарища, на месте для появления (не на дороге, не в стене, не под машиной),
  // чтобы сразу вернуться в бой вместе. Нет живых товарищей или места - -1 (обычное появление вдали от всех)
  spawnNearMate(p) {
    const m = this.map;
    if (!this.spawnMask) { this.spawnMask = new Uint8Array(m.w * m.h); for (const k of m.spawnTiles) this.spawnMask[k] = 1; }
    const mates = [...this.players.values()].filter(o => o !== p && o.alive && !o.isBot);
    if (!mates.length) return -1;
    const mate = mates[Math.floor(Math.random() * mates.length)];
    for (let i = 0; i < 80; i++) {
      const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 10;
      const tx = Math.floor(mate.x + Math.cos(a) * r), ty = Math.floor(mate.y + Math.sin(a) * r);
      if (tx < 1 || ty < 1 || tx >= m.w - 1 || ty >= m.h - 1) continue;
      const k = ty * m.w + tx;
      if (!this.spawnMask[k] || !KV.circleFree(m, tx + 0.5, ty + 0.5, KV.PLAYER_R) || this.vehicles.personBlocked(tx + 0.5, ty + 0.5, null)) continue;
      return k;
    }
    return -1;
  }

  // свои в банде: оба - люди (боты всегда чужие), разные игроки, режим «Банда»
  allies(a, b) { return this.gang && !!a && !!b && a !== b && !a.isBot && !b.isBot; }
  allyHit(t, attackerId) { return this.gang && attackerId > 0 && attackerId !== t.id && this.allies(t, this.players.get(attackerId)); }

  // Стрелок (бот, житель) виден на экране у живого игрока? Из-за края экрана по игроку не стреляют -
  // иначе пули «вылетают из пустоты». По ботам и жителям - без ограничения.
  onScreenOf(t, x, y, margin = 1) {
    if (!t || t.isBot || !t.view || t.isNpc) return true;
    return Math.abs(x - t.x) < t.view[0] - margin && Math.abs(y - t.y) < t.view[1] - margin;
  }

  teleport(p, x, y) {
    p.x = x; p.y = y; p.tp++; p.budget = 0; p.lastMoveTime = this.time;
    this.send(p, { t: 'tp', x: r2(x), y: r2(y), tp: p.tp, veh: p.vehicle || 0 });
  }

  send(p, msg) {
    const ws = p.ws;
    if (ws && ws.readyState === 1 && ws.bufferedAmount < 1e6) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  welcome(p) {
    const m = this.map;
    const d = [];
    for (let k = 0; k < m.dmg.length; k++) if (m.dmg[k]) d.push(k, m.dmg[k]);
    return {
      t: 'welcome', id: p.id, room: this.id,
      map: {
        w: m.w, h: m.h, g: KV.rleEncode(m.ground), b: KV.rleEncode(m.block), d,
        bld: m.buildings.map(b => [b.x, b.y, b.w, b.h, b.roof ? 1 : 0]),
        roads: m.roads,
        shops: (m.shops || []).map(s => [s.kind, r2(s.x), r2(s.y), s.r])
      },
      players: [...this.players.values()].map(o => this.publicInfo(o)),
      pickups: [...this.pickups.values()].map(pk => [pk.id, pk.kind, pk.w, r2(pk.x), r2(pk.y)]),
      bots: this.botsOn,
      mode: this.gang ? 'gang' : 'ffa'
    };
  }

  // ---------- сообщения клиента ----------
  onMessage(p, msg) {
    switch (msg.t) {
      case 'i': this.onInput(p, msg); break;
      case 'w': {
        const i = msg.i | 0;
        if (i >= 0 && i < WEAPONS.length && (i === W.FISTS || p.ammo[i] > 0 || (WEAPONS[i].noAmmo && p.ammo[i] >= 0))) { p.cur = i; p.spinT = 0; }
        break;
      }
      case 'enter': if (p.alive && !p.vehicle) this.vehicles.enter(p, msg.id | 0); break;
      case 'buy': if (!p.isBot) this.buyGun(p, msg.w | 0); break;
      case 'exit': if (p.vehicle) this.vehicles.exit(p, false); break;
      case 'horn':
        if (p.vehicle && this.time - p.hornAt > 0.5) { p.hornAt = this.time; this.ev.hn.push(p.vehicle); }
        break;
      case 'ram': if (p.vehicle) this.vehicles.onRam(p, msg); break;
      case 'push': if (p.vehicle) this.vehicles.onPush(p, msg.l); break;
      case 'bots': {
        const on = !!msg.on;
        if (on === this.botsOn || this.time - (this.botsAt || -10) < 1) break;
        this.botsOn = on;
        this.botsAt = this.time;
        this.fillBots();
        this.ev.bo.push([on ? 1 : 0, p.name]);
        break;
      }
      case 'crash': if (p.vehicle) this.vehicles.onCrash(p, msg); break;
      case 'voice': {
        // подключился к голосовому чату или вышел из него
        const on = !!msg.on;
        if (on === p.voice || p.isBot) break;
        p.voice = on;
        if (!on) p.talkUntil = 0;
        this.ev.vc.push([p.id, on ? 1 : 0]);
        break;
      }
      case 'dbg':
        // только для автотестов на своём компьютере: на хостинге переменная KV_DEBUG не задана
        if (process.env.KV_DEBUG !== '1') break;
        if (msg.give) { for (const w of WEAPONS) if (w.max) p.ammo[w.id] = w.max; else if (w.noAmmo) p.ammo[w.id] = 0; }
        if (msg.god) p.prot = this.time + 600;
        if (msg.immortal) p.godUntil = this.time + 600; // не снимается стрельбой (для проверок под огнём)
        if (msg.money !== undefined) p.money = Math.max(0, Number(msg.money) || 0);
        if (msg.hp !== undefined) p.hp = Math.max(1, Math.min(KV.MAX_HP, Number(msg.hp) || 1));
        if (Array.isArray(msg.tpTo) && !p.vehicle) { const q = KV.collideCircle(this.map, Number(msg.tpTo[0]) || p.x, Number(msg.tpTo[1]) || p.y, KV.PLAYER_R); this.teleport(p, q[0], q[1]); }
        if (msg.wanted) this.npcs.crime(p, Number(msg.wanted) || 30);
        if (msg.shroom) {
          const spot = [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2], [0, 0]].find(([dx, dy]) => KV.circleFree(this.map, p.x + dx, p.y + dy, KV.PLAYER_R));
          this.addPickup(PK.SHROOM, 0, p.x + spot[0], p.y + spot[1], 1);
        }
        if (msg.weapon !== undefined && WEAPONS[msg.weapon | 0]) { const w = WEAPONS[msg.weapon | 0]; if (w.max) p.ammo[w.id] = w.max; p.cur = w.id; }
        if (msg.carAhead && p.vehicle) {
          // стоящая машина прямо перед своей - для проверки толкания
          const v = this.vehicles.list.get(p.vehicle);
          if (v) {
            const x = v.x + Math.cos(v.a) * 4.6, y = v.y + Math.sin(v.a) * 4.6;
            if (!KV.carHitsHard(this.map, x, y, v.a, 0.05)) this.vehicles.create(x, y, v.a, 5, 'parked', null);
          }
        }
        if (msg.nearCar) {
          // к ближайшей целой стоящей машине, у которой свободна дверь; если таких нет - ставим машину на дорогу
          const cars = [...this.vehicles.list.values()].filter(v => !v.dead && v.state === 'parked' && v.burn <= 0 && v.hp > CAR.HP * 0.5)
            .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
          let done = false;
          for (const v of cars.slice(0, 12)) {
            const c = Math.cos(v.a), s = Math.sin(v.a);
            for (const side of [1, -1]) {
              const x = v.x + s * side * (CAR.HW + 0.7), y = v.y - c * side * (CAR.HW + 0.7);
              if (KV.circleFree(this.map, x, y, KV.PLAYER_R) && !this.vehicles.personBlocked(x, y, null)) { this.teleport(p, x, y); done = true; break; }
            }
            if (done) break;
          }
          if (!done) {
            const r = this.map.roads.x[1] || this.map.roads.x[0];
            const x = r[0] + 2, y = 30 + Math.random() * 60;
            if (!KV.carHitsHard(this.map, x, y, Math.PI / 2, 0.05)) { this.vehicles.create(x, y, Math.PI / 2, 5, 'parked', null); this.teleport(p, x + CAR.HW + 0.7, y); }
          }
        }
        if (msg.veh === 'tank' || msg.veh === 'swat' || msg.veh === 'moto') {
          // стоящая техника на дороге и игрок у её двери - для проверки угона и стрельбы из танка
          const r = this.map.roads.x[1] || this.map.roads.x[0];
          for (let i = 0; i < 40; i++) {
            // мотоцикл - в верхней части дороги: впереди (на юг) хватает места разогнаться
            const x = r[0] + 2, y = msg.veh === 'moto' ? 14 + Math.random() * 26 : 20 + Math.random() * (this.map.h - 40);
            if (KV.carOverlapsSolid(this.map, x, y, Math.PI / 2, 0.05, null) || !KV.circleFree(this.map, x + CAR.HW + 0.7, y, KV.PLAYER_R)) continue;
            if ([...this.vehicles.list.values()].some(o => !o.dead && Math.hypot(o.x - x, o.y - y) < 7)) continue;
            this.vehicles.setKind(this.vehicles.create(x, y, Math.PI / 2, 6, 'parked', null), msg.veh);
            this.teleport(p, x + CAR.HW + 0.7, y);
            break;
          }
        }
        if (msg.wall) {
          // ближайший дом: выбить 6 кирпичей и разрешить ремонт сразу (без минуты ожидания) - проверка в браузере
          const mp = this.map;
          let hb = null, hd = 1e9;
          for (const q of mp.buildings) { const d = Math.hypot(q.x + q.w / 2 - p.x, q.y + q.h / 2 - p.y); if (d < hd && q.orig && q.orig.length > 12) { hd = d; hb = q; } }
          if (hb) {
            for (const e of hb.orig.filter(q => q[1] === B.BRICK && mp.block[q[0]] === B.BRICK).slice(0, 6)) this.destroyTile(e[0], 0);
            hb.hitAt = this.time - REBUILD_DELAY;
          }
        }
        if (msg.heli) {
          // вертолёт сразу рядом (для проверки); без розыска от 4 звёзд он улетит
          const h = this.npcs.spawnHeli(p);
          h.x = p.x + 7; h.y = p.y - 3;
        }
        if (Array.isArray(msg.tp)) {
          const x = Number(msg.tp[0]), y = Number(msg.tp[1]);
          if (Number.isFinite(x) && Number.isFinite(y) && KV.circleFree(this.map, x, y, KV.PLAYER_R)) this.teleport(p, x, y);
        }
        break;
    }
  }

  onInput(p, m) {
    const a = Number(m.a);
    if (Number.isFinite(a)) p.a = a;
    // f - атака зажата; q - новое нажатие: один выстрел, даже если кнопку уже отпустили.
    // Раньше флаг нажатия заново ставило каждое сообщение с зажатой атакой, и после выстрела он
    // взводился повторно - короткое нажатие давало второй выстрел через перезарядку.
    p.fire = !!m.f;
    if (m.q) { p.fireLatch = true; p.latchAt = this.time; }
    p.sprint = !!m.s && !p.vehicle;
    const d = Number(m.d);
    p.aimD = Number.isFinite(d) && d > 0 ? Math.min(100, d) : 0; // до какой точки целится (граната взрывается там)
    if (Array.isArray(m.v)) {
      const vw = Number(m.v[0]), vh = Number(m.v[1]);
      if (Number.isFinite(vw) && Number.isFinite(vh)) p.view = [Math.max(8, Math.min(70, vw)), Math.max(8, Math.min(70, vh))];
    }
    if (!p.alive) return;
    if (p.vehicle) {
      const v = this.vehicles.list.get(p.vehicle);
      if (v && v.kind === 'tank') v.turret = p.a; // башня танка смотрит туда, куда целится водитель
      this.vehicles.onDrive(p, m.c);
      return;
    }
    if (m.tp !== p.tp) return;
    const x = Number(m.x), y = Number(m.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const dist = Math.hypot(x - p.x, y - p.y);
    if (dist < 1e-4) return;
    const speed = p.sprint && p.stamina > 0 ? KV.SPRINT_SPEED : KV.PLAYER_SPEED;
    p.budget = Math.min(p.budget + (this.time - p.lastMoveTime) * speed * 1.3, KV.SPRINT_SPEED * 1.0);
    p.lastMoveTime = this.time;
    if (dist <= p.budget + 0.08 &&
        KV.circleFree(this.map, x, y, KV.PLAYER_R * 0.85) &&
        KV.segmentClear(this.map, p.x, p.y, x, y, KV.PLAYER_R * 0.7)) {
      p.x = x; p.y = y; p.budget -= dist;
    } else {
      this.teleport(p, p.x, p.y);
    }
  }

  // Голос: кадр от игрока (двоичный, ~320 байт на 40 мс) - всем остальным, кто в голосовом чате.
  // Сервер звук не разбирает, только пересылает с номером говорящего и помечает, что тот говорит.
  onVoice(p, buf) {
    if (!p.voice || p.isBot || !Buffer.isBuffer(buf) || buf.length < 6 || buf.length > 600 || buf[0] !== 1) return;
    const now = Date.now();
    if (now - p.vWin > 1000) { p.vWin = now; p.vCount = 0; }
    if (++p.vCount > 40) return; // не больше 40 кадров в секунду
    p.talkUntil = this.time + 0.35;
    const out = Buffer.allocUnsafe(buf.length + 2);
    out[0] = 1;
    out.writeUInt16LE(p.id & 0xffff, 1);
    buf.copy(out, 3, 1);
    for (const o of this.players.values()) {
      if (o === p || !o.voice || !o.ws || o.ws.readyState !== 1 || o.ws.bufferedAmount > 256e3) continue;
      o.ws.send(out, { binary: true });
    }
  }

  // ---------- такт ----------
  tick() {
    this.time += DT;
    this.tickNo++;
    for (const p of this.players.values()) if (p.isBot && !p.vehicle) this.bots.update(p, DT);
    this.vehicles.update(DT);
    this.npcs.update(DT);
    this.updateStamina();
    for (const p of this.players.values()) this.updateFiring(p);
    this.updateBullets();
    this.updateGrenades();
    this.updateBurning();
    this.updateTileFires();
    this.updatePending();
    if (this.tickNo % REBUILD_EVERY === 0) this.updateRebuild();
    this.updatePickups();
    if (this.tickNo % 3 === 0) this.updateShops();
    this.updateCrates();
    for (const p of this.players.values()) if (!p.alive && this.time >= p.respawnAt) this.spawn(p);
    if (this.recentShots.length && this.time - this.recentShots[0].t > 5) this.recentShots = this.recentShots.filter(s => this.time - s.t <= 5);
    this.flushEvents();
    if (this.tickNo % 2 === 0) this.sendSnapshots();
    if (this.tickNo % 15 === 0) this.sendPings();
    if (this.tickNo % 30 === 0 && this.sbDirty) this.sendScoreboard();
  }

  updateStamina() {
    for (const p of this.players.values()) {
      if (!p.alive || p.vehicle) continue;
      if (this.time < p.tripUntil) { p.stamina = STAMINA.MAX; continue; } // после гриба выносливость не кончается
      const moving = this.time - p.lastMoveTime < 0.25;
      if (p.sprint && moving && p.stamina > 0) {
        p.stamina = Math.max(0, p.stamina - STAMINA.DRAIN * DT);
        p.staminaT = this.time;
      } else if (this.time - p.staminaT > STAMINA.DELAY) {
        p.stamina = Math.min(STAMINA.MAX, p.stamina + STAMINA.REGEN * DT);
      }
    }
  }

  // ---------- стрельба ----------
  bestWeapon(p) {
    for (const w of [W.MINIGUN, W.RIFLE, W.AUTOSHOT, W.SHOTGUN, W.TRIPLE, W.UZI, W.FLAMER, W.SNIPER, W.PISTOL, W.LAUNCHER, W.GRENADE, W.SAW]) if (p.ammo[w] > 0) return w;
    return W.FISTS;
  }

  updateFiring(p) {
    if (p.fireLatch && this.time - p.latchAt > PRESS_LATCH) p.fireLatch = false; // нажатие давнее - не стреляем с опозданием
    // миниган раскручивается, пока зажата атака; отпустил - стволы останавливаются
    if (WEAPONS[p.cur].spin) p.spinT = p.alive && p.fire ? Math.min(1, (p.spinT || 0) + DT) : Math.max(0, (p.spinT || 0) - 2 * DT);
    if (!p.alive || !(p.fire || p.fireLatch)) return;
    if (this.time < p.nextShot) return;
    if (this.time < p.rollUntil) { p.fireLatch = false; return; } // катится после прыжка из машины
    // на рывке не стреляют - кроме как под грибом (решение владельца 17.11.2026)
    if (p.sprint && !p.vehicle && this.time - p.lastMoveTime < 0.25 && p.stamina > 0 && !(p.tripUntil > this.time)) { p.fireLatch = false; return; }
    if (p.cur !== W.FISTS && !WEAPONS[p.cur].noAmmo && !(p.ammo[p.cur] > 0)) { p.cur = this.bestWeapon(p); p.fireLatch = false; return; }
    // в танке атака - снаряд из башни туда, куда целишься; оружие в руках при этом не тратится
    const tank = p.vehicle ? this.vehicles.list.get(p.vehicle) : null;
    if (tank && tank.kind === 'tank') {
      p.fireLatch = false;
      if (p.isBot) return; // из танка стреляют только игроки
      p.nextShot = this.time + TANK_RELOAD;
      p.prot = 0;
      p.shotAt = this.time;
      if (!p.isBot) this.recentShots.push({ x: p.x, y: p.y, t: this.time });
      tank.turret = p.a;
      this.spawnShot(tank.x + Math.cos(p.a) * 2.6, tank.y + Math.sin(p.a) * 2.6, p.a, WEAPONS[W.LAUNCHER], p.id, tank.id,
        Math.max(0, (p.aimD || 20) - 2.6), 0, this.npcs.aimHeli(p) ? 2 : 0);
      this.npcs.noise(p.x, p.y, 16);
      return;
    }
    // со щитом стреляешь только из пистолета, если он есть (wi - чьи патроны тратятся)
    let wi = p.cur;
    if (WEAPONS[p.cur].shield) { if (!(p.ammo[W.PISTOL] > 0)) { p.fireLatch = false; return; } wi = W.PISTOL; }
    const w = WEAPONS[wi];
    if (w.spin && (p.spinT || 0) < w.spin) return; // миниган ещё раскручивается
    if (w.melee && p.vehicle) { p.fireLatch = false; return; } // из машины кулаками не бьют
    p.fireLatch = false;
    // при непрерывной стрельбе перезарядка считается от прошлого выстрела: иначе темп обрезается тактами
    // (30 в секунду - быстрее 15 выстрелов в секунду не выходило: миниган 20 -> 15, узи 14 -> 10)
    p.nextShot = (this.time - p.nextShot < DT ? p.nextShot : this.time) + 1 / w.rate;
    p.prot = 0; // стрельба снимает защиту после появления
    p.shotAt = this.time;
    if (!p.isBot && w.id !== W.FISTS) this.recentShots.push({ x: p.x, y: p.y, t: this.time });
    // выстрел пугает прохожих рядом
    if (w.id !== W.FISTS && this.time - (p.noiseAt || 0) > 0.4) { p.noiseAt = this.time; this.npcs.noise(p.x, p.y, w.melee ? 5 : 11); }
    if (w.melee) {
      if (w.saw) { p.ammo[p.cur]--; if (p.ammo[p.cur] <= 0) p.cur = this.bestWeapon(p); } // пила тратит бензин
      this.melee(p, w);
      return;
    }
    if (w.throw) {
      p.ammo[wi]--;
      this.throwGrenade(p, w);
      if (p.ammo[wi] <= 0) p.cur = this.bestWeapon(p);
      return;
    }
    p.ammo[wi]--;
    // из машины пуля вылетает из окна, огонь - из сопла огнемёта
    const off = p.vehicle ? 0.6 : w.flame ? 0.75 : 0;
    // целится в вертолёт - стреляет вверх: стены и люди внизу пуле не мешают
    const up = !w.flame && this.npcs.aimHeli(p) ? 2 : 0;
    this.spawnShot(p.x + Math.cos(p.a) * off, p.y + Math.sin(p.a) * off, p.a, w, p.id, p.vehicle || 0, p.aimD, 0, up);
    if (wi === p.cur && p.ammo[wi] <= 0) p.cur = this.bestWeapon(p);
  }

  // Граната: летит в точку прицела (не дальше 18 м), отскакивает от стен, через 2 с взрывается
  throwGrenade(p, w) {
    const d = Math.max(2, Math.min(w.range, p.aimD || 10)), c = Math.cos(p.a), s = Math.sin(p.a);
    const g = { id: this.nextGrenade++, x: p.x + c * 0.5, y: p.y + s * 0.5, vx: c * d * GRENADE_DRAG, vy: s * d * GRENADE_DRAG, t: w.fuse, owner: p.id };
    if (!this.grenadeFree(g.x, g.y)) { g.x = p.x; g.y = p.y; }
    this.grenades.push(g);
    this.ev.gt.push([g.id, r2(g.x), r2(g.y), p.id]);
  }
  // граната пролетает над низким (заборы, скамейки), о стены отскакивает
  grenadeFree(x, y) {
    const m = this.map, r = 0.15;
    for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
      for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
        if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
        const t = m.block[ty * m.w + tx];
        if (t !== B.NONE && !(BLOCKS[t] && BLOCKS[t].low)) return false;
      }
    }
    return true;
  }
  updateGrenades() {
    if (!this.grenades.length) return;
    const damp = Math.exp(-GRENADE_DRAG * DT);
    for (const g of this.grenades) {
      const n = Math.max(1, Math.ceil((Math.hypot(g.vx, g.vy) * DT) / 0.2));
      for (let i = 0; i < n; i++) {
        const nx = g.x + (g.vx * DT) / n, ny = g.y + (g.vy * DT) / n;
        if (this.grenadeFree(nx, ny)) { g.x = nx; g.y = ny; continue; }
        // упёрлась - отскок по той оси, по которой упёрлась, с потерей скорости
        if (this.grenadeFree(nx, g.y)) { g.x = nx; g.vy = -g.vy * 0.5; }
        else if (this.grenadeFree(g.x, ny)) { g.y = ny; g.vx = -g.vx * 0.5; }
        else { g.vx = -g.vx * 0.5; g.vy = -g.vy * 0.5; }
      }
      g.vx *= damp; g.vy *= damp;
      g.t -= DT;
      if (g.t <= 0) { g.dead = true; this.explode(g.x, g.y, WEAPONS[W.GRENADE].blast, g.owner, W.GRENADE); }
    }
    this.grenades = this.grenades.filter(g => !g.dead);
  }
  // открыт ли человек для пуль, огня и взрывов: пеший или на мотоцикле (в машине его прикрывает кузов)
  exposed(p) {
    if (!p.vehicle) return true;
    const v = this.vehicles.list.get(p.vehicle);
    return !!(v && v.moto);
  }

  // щит: пуля спереди (±60° от взгляда) в него упирается; сзади и сбоку - попадает
  shieldBlocks(p, b) {
    if (p.vehicle || !WEAPONS[p.cur].shield) return false;
    const from = Math.atan2(-b.dy, -b.dx);
    return Math.abs(Math.atan2(Math.sin(from - p.a), Math.cos(from - p.a))) < Math.PI / 3;
  }

  // Пули одного выстрела (у дробовика - веер). ownerId - игрок; у жителей - отрицательный (-100 - вид), npcId - кто именно.
  // air: 1 - очередь с вертолёта (первые 70% пути пуля над домами и людьми, дальше как обычная), 2 - выстрел вверх по вертолёту
  spawnShot(x, y, a, w, ownerId, vehId, aimD, npcId, air) {
    const n = w.pellets || 1;
    for (let i = 0; i < n; i++) {
      const ang = n > 1 ? a + (i / (n - 1) - 0.5) * w.spread + (Math.random() - 0.5) * 0.05 : a + (Math.random() - 0.5) * 2 * w.spread;
      // граната летит до прицела (не ближе 2.5 м), пули - на всю дальность
      const reach = w.grenade && aimD > 1 ? Math.max(2.5, Math.min(w.range, aimD)) : w.range;
      const b = {
        id: this.nextBullet++, owner: ownerId, npc: npcId || 0, veh: vehId || 0, w: w.id, x, y,
        dx: Math.cos(ang), dy: Math.sin(ang), speed: w.speed, left: reach, range: reach, dead: false, flame: !!w.flame, hit: null,
        air: air || 0, airD: air === 1 ? (aimD || reach) * 0.7 : 0
      };
      this.bullets.push(b);
      this.ev.b.push([b.id, w.id, r2(x), r2(y), r3(ang), ownerId]);
    }
  }

  melee(p, w) {
    this.ev.m.push(p.id);
    const ax = Math.cos(p.a), ay = Math.sin(p.a);
    let target = null, bestD = w.range + 0.5;
    for (const o of this.players.values()) {
      if (o === p || !o.alive || !this.exposed(o) || this.allies(o, p)) continue;
      const dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy);
      if (d > w.range + 0.5 || d >= bestD) continue;
      if ((dx * ax + dy * ay) / (d || 1) < 0.45) continue; // примерно ±63° перед собой
      if (!geom.losClear(this.map, p.x, p.y, o.x, o.y, false)) continue;
      target = o; bestD = d;
    }
    if (target) { this.damage(target, w.dmg, p.id, w.id, target.x, target.y); return; }
    const nt = this.npcs.meleeTarget(p, w.range);
    if (nt) { this.npcs.damage(nt, w.dmg, p.id, w.id, nt.x, nt.y); return; }
    const reach = KV.PLAYER_R + (w.saw ? 0.75 : 0.45);
    // пила режет и машины
    if (w.saw) {
      const sx = p.x + ax * reach, sy = p.y + ay * reach;
      for (const v of this.vehicles.list.values()) {
        if (v.dead || Math.abs(v.x - sx) > 3 || Math.abs(v.y - sy) > 3) continue;
        if (KV.distToOBB(sx, sy, v.x, v.y, v.a, KV.boxOf(v).hl, KV.boxOf(v).hw) > 0.3) continue;
        this.vehicles.damage(v, w.carDmg * (v.bulletK || 1), p.id);
        if (Math.random() < 0.35) this.ev.cr.push([r2(sx), r2(sy), 3]);
        return;
      }
    }
    const tx = Math.floor(p.x + ax * reach), ty = Math.floor(p.y + ay * reach);
    if (tx > 0 && ty > 0 && tx < this.map.w - 1 && ty < this.map.h - 1) this.damageTile(ty * this.map.w + tx, w.tileDmg, p.id);
  }

  updateBullets() {
    const m = this.map;
    for (const b of this.bullets) {
      let step = Math.min(b.speed * DT, b.left);
      // очередь с вертолёта: пока пуля высоко, она пролетает над домами и людьми; остаток шага - как у обычной
      // (иначе быстрая пуля за один такт перелетает цель целиком «по воздуху»)
      if (b.air === 1 && b.range - b.left < b.airD) {
        const adv = Math.min(step, b.airD - (b.range - b.left));
        b.x += b.dx * adv; b.y += b.dy * adv; b.left -= adv; step -= adv;
        if (step <= 1e-6) {
          if (b.left <= 1e-6) { b.dead = true; this.ev.be.push([b.id, r2(b.x), r2(b.y), 0]); }
          continue;
        }
      }
      // выстрел вверх по вертолёту летит над домами и людьми
      const high = b.air === 2;
      const hitT = high ? null : geom.raycast(m, b.x, b.y, b.dx, b.dy, step);
      if (b.flame) { this.stepFlame(b, step, hitT); continue; }
      let tBest = hitT ? hitT.t : Infinity, target = null, car = null, npcT = null, heli = null;
      if (!high) {
        for (const p of this.players.values()) {
          if (!p.alive || p.id === b.owner || !this.exposed(p) || this.allyHit(p, b.owner)) continue; // мотоциклиста пуля находит, своих в банде - нет
          const t = geom.rayCircle(b.x, b.y, b.dx, b.dy, p.x, p.y, 0.5);
          if (t >= 0 && t <= step && t < tBest) { tBest = t; target = p; }
        }
        // жители города
        const nh = this.npcs.rayHit(b, step, tBest);
        if (nh) { tBest = nh.t; npcT = nh.n; target = null; }
        for (const v of this.vehicles.list.values()) {
          if (v.dead || v.id === b.veh) continue;
          if (Math.abs(v.x - b.x) > step + 3 || Math.abs(v.y - b.y) > step + 3) continue;
          const t = geom.rayOBB(b.x, b.y, b.dx, b.dy, v.x, v.y, v.a, KV.boxOf(v).hl, KV.boxOf(v).hw);
          if (t >= 0 && t <= step && t < tBest) { tBest = t; car = v; target = null; npcT = null; }
        }
      }
      // полицейский вертолёт: в него попадают пули игроков и ботов
      if (b.owner > 0 && b.air !== 1) {
        const hh = this.npcs.heliHit(b, step, tBest);
        if (hh) { tBest = hh.t; heli = hh.h; target = null; npcT = null; car = null; }
      }
      const w = WEAPONS[b.w];
      if (target || car || npcT || heli || (hitT && hitT.t <= step)) {
        const back = w.grenade ? 0.08 : 0;
        const hx = b.x + b.dx * Math.max(0, tBest - back), hy = b.y + b.dy * Math.max(0, tBest - back);
        b.dead = true;
        if (w.grenade) { this.ev.be.push([b.id, r2(hx), r2(hy), 3]); this.explode(hx, hy, w.blast, b.owner, w.id); continue; }
        const travelled = b.range - b.left + tBest;
        const fall = WEAPONS[b.w].falloff ? 1 - 0.5 * Math.min(1, travelled / b.range) : 1;
        if (target && this.shieldBlocks(target, b)) {
          this.ev.be.push([b.id, r2(hx), r2(hy), 4]); // пуля звякнула о щит
        } else if (target) {
          this.ev.be.push([b.id, r2(hx), r2(hy), 2]);
          this.damage(target, w.dmg * fall, b.owner, w.id, hx, hy);
        } else if (npcT) {
          this.ev.be.push([b.id, r2(hx), r2(hy), 2]);
          this.npcs.damage(npcT, w.dmg * fall, b.owner, w.id, hx, hy);
        } else if (heli) {
          this.ev.be.push([b.id, r2(hx), r2(hy), 4]);
          this.npcs.heliDamage(heli, w.dmg * fall * HELI_BULLET, b.owner);
        } else if (car) {
          // по машине пули бьют сильно; сидящего внутри пулей не убить - только взорвав машину; у техники броня.
          // Свои машины полиция не портит: пуля бьётся о них, как об укрытие (иначе в перестрелке полиция
          // взрывала свои же машины - замер 17.11: к концу боя не оставалось ни одной)
          this.ev.be.push([b.id, r2(hx), r2(hy), 4]);
          if (!(LAW_SHOT.has(b.owner) && LAW_CAR[car.kind])) this.vehicles.damage(car, w.dmg * fall * CAR_BULLET * (car.bulletK || 1), b.owner);
        } else {
          this.ev.be.push([b.id, r2(hx), r2(hy), 1]);
          if (hitT.k >= 0 && m.block[hitT.k] === B.BARREL) this.destroyTile(hitT.k, b.owner); // бочка взрывается от любого попадания
          else if (hitT.k >= 0) this.damageTile(hitT.k, w.dmg * fall, b.owner, BLOCKS[m.block[hitT.k]] ? BLOCKS[m.block[hitT.k]].bullet : 1);
        }
        continue;
      }
      b.x += b.dx * step; b.y += b.dy * step; b.left -= step;
      if (b.left <= 1e-6) {
        b.dead = true;
        if (w.grenade) { this.ev.be.push([b.id, r2(b.x), r2(b.y), 3]); this.explode(b.x, b.y, w.blast, b.owner, w.id); }
        else this.ev.be.push([b.id, r2(b.x), r2(b.y), 0]);
      }
    }
    if (this.bullets.some(b => b.dead)) this.bullets = this.bullets.filter(b => !b.dead);
  }

  // Струя огнемёта: летит недалеко и проходит сквозь людей (поджигает), деревянное загорается, машины горят
  stepFlame(b, step, hitT) {
    const w = WEAPONS[b.w];
    const tWall = hitT ? hitT.t : Infinity;
    for (const p of this.players.values()) {
      if (!p.alive || p.id === b.owner || !this.exposed(p) || this.allyHit(p, b.owner) || (b.hit && b.hit.has(p.id))) continue;
      if (Math.abs(p.x - b.x) > step + 1 || Math.abs(p.y - b.y) > step + 1) continue;
      const t = geom.rayCircle(b.x, b.y, b.dx, b.dy, p.x, p.y, 0.65);
      if (t < 0 || t > step || t > tWall) continue;
      (b.hit || (b.hit = new Set())).add(p.id);
      this.damage(p, w.dmg, b.owner, w.id, p.x, p.y, 0.6, true);
      this.ignite(p, b.owner, w.burn);
    }
    for (const n of this.npcs.list.values()) {
      if (!n.alive || n.veh || n.id === b.npc || (b.hitN && b.hitN.has(n.id))) continue;
      if (Math.abs(n.x - b.x) > step + 1 || Math.abs(n.y - b.y) > step + 1) continue;
      const t = geom.rayCircle(b.x, b.y, b.dx, b.dy, n.x, n.y, 0.65);
      if (t < 0 || t > step || t > tWall) continue;
      (b.hitN || (b.hitN = new Set())).add(n.id);
      this.npcs.damage(n, w.dmg, b.owner, w.id, n.x, n.y, { silent: true });
      this.npcs.ignite(n, b.owner, w.burn);
    }
    let car = null, tCar = Infinity;
    for (const v of this.vehicles.list.values()) {
      if (v.dead || v.id === b.veh || Math.abs(v.x - b.x) > step + 3 || Math.abs(v.y - b.y) > step + 3) continue;
      const t = geom.rayOBB(b.x, b.y, b.dx, b.dy, v.x, v.y, v.a, KV.boxOf(v).hl, KV.boxOf(v).hw);
      if (t >= 0 && t <= step && t < tCar && t < tWall) { tCar = t; car = v; }
    }
    if (car) {
      b.dead = true;
      this.ev.be.push([b.id, r2(b.x + b.dx * tCar), r2(b.y + b.dy * tCar), 5]);
      this.vehicles.damage(car, (w.carDmg || w.dmg * 4) * (car.bulletK || 1), b.owner);
      return;
    }
    if (hitT && hitT.t <= step) {
      b.dead = true;
      this.ev.be.push([b.id, r2(b.x + b.dx * hitT.t), r2(b.y + b.dy * hitT.t), 5]);
      if (hitT.k >= 0) this.burnTile(hitT.k, b.owner, w.fireTile || w.dmg);
      return;
    }
    b.x += b.dx * step; b.y += b.dy * step; b.left -= step;
    if (b.left <= 1e-6) { b.dead = true; this.ev.be.push([b.id, r2(b.x), r2(b.y), 5]); }
  }

  // Огонь по клетке: деревянное загорается и сгорает, бочка взрывается, камень лишь чуть страдает
  burnTile(k, ownerId, dmg) {
    const m = this.map, t = m.block[k];
    if (t === B.NONE || t === B.BORDER) return;
    if (t === B.BARREL) { this.destroyTile(k, ownerId); return; }
    if (!WOOD[t]) { this.damageTile(k, dmg * 0.3, ownerId, BLOCKS[t].bullet); return; }
    if (this.tileFires.has(k)) return;
    this.tileFires.set(k, { until: this.time + 8, by: ownerId, next: this.time + 1 });
    this.ev.tf.push(k);
  }

  updateTileFires() {
    if (!this.tileFires.size) return;
    const m = this.map;
    for (const [k, f] of this.tileFires) {
      if (!WOOD[m.block[k]] || this.time > f.until) { this.tileFires.delete(k); this.ev.tfx.push(k); continue; }
      this.damageTile(k, 24 * DT, f.by);
      if (this.time < f.next) continue;
      f.next = this.time + 1;
      // огонь перекидывается на соседнее деревянное: забор горит полосой, но не бесконечно
      const x = k % m.w, y = (k / m.w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = (y + dy) * m.w + x + dx;
        if (WOOD[m.block[nk]] && !this.tileFires.has(nk) && Math.random() < 0.22) {
          this.tileFires.set(nk, { until: this.time + 8, by: f.by, next: this.time + 1 });
          this.ev.tf.push(nk);
        }
      }
    }
  }

  // ---------- урон ----------
  // armorK - какую долю урона может взять броня (от машины броня почти не спасает); silent - без брызг (горение)
  damage(t, amount, attackerId, weaponId, hx, hy, armorK = 0.6, silent = false) {
    if (!t.alive || amount <= 0 || this.time < t.prot || t.godUntil > this.time) return;
    if (this.allyHit(t, attackerId)) return; // банда: свои друг друга не ранят ничем
    if (t.tripUntil > this.time) amount *= SHROOM_DMG; // под грибом урона вдвое меньше (броня - поверх)
    const absorbed = Math.min(t.ar, amount * armorK);
    t.ar -= absorbed;
    t.hp -= amount - absorbed;
    if (!silent) this.ev.hu.push([t.id, r2(hx), r2(hy), attackerId || 0]);
    if (t.hp <= 0) this.kill(t, attackerId, weaponId);
  }

  // Человек загорелся от огнемёта: горит secs секунд, урон засчитывается тому, кто поджёг
  ignite(p, by, secs) {
    if (!p.alive || !this.exposed(p) || this.time < p.prot || this.allyHit(p, by)) return;
    p.burnUntil = Math.max(p.burnUntil, this.time + secs);
    p.burnBy = by;
  }

  updateBurning() {
    for (const p of this.players.values()) {
      if (!p.alive || p.burnUntil <= this.time) continue;
      if (!this.exposed(p)) { p.burnUntil = 0; continue; } // в машине огонь сбивается (на мотоцикле - нет)
      p.burnT += DT;
      if (p.burnT >= 0.25) { p.burnT -= 0.25; this.damage(p, BURN_DMG, p.burnBy, W.FLAMER, p.x, p.y, 0.3, true); }
    }
  }

  kill(t, attackerId, weaponId) {
    if (t.vehicle) this.vehicles.exit(t, true);
    if (!t.isBot) this.npcs.playerDied(t); // смерть гасит все звёзды розыска
    t.alive = false; t.hp = 0; t.deaths++;
    t.fire = false; t.fireLatch = false; t.sprint = false; t.burnUntil = 0; t.rollUntil = 0; t.tripUntil = 0;
    t.respawnAt = this.time + KV.RESPAWN_DELAY;
    const a = this.players.get(attackerId);
    if (a && a !== t) a.kills++;
    if (a && a !== t && !a.isBot) a.money = (a.money || 0) + (t.isBot ? 50 : 100); // за игрока $100, за бота $50
    this.ev.k.push([attackerId || 0, t.id, weaponId]);
    if (t.cur !== W.FISTS && t.ammo[t.cur] > 0) this.addPickup(PK.WEAPON, t.cur, t.x, t.y, t.ammo[t.cur]);
    else if (WEAPONS[t.cur].noAmmo && t.ammo[t.cur] >= 0) this.addPickup(PK.WEAPON, t.cur, t.x, t.y, 0); // щит падает на землю
    // половина денег погибшего падает пачкой - подобрать может кто угодно
    if (!t.isBot && t.money >= 2) { const half = Math.floor(t.money / 2); t.money -= half; this.addPickup(PK.MONEY, 0, t.x + 0.6, t.y, half); }
    this.sbDirty = true;
  }

  // skipVeh - машина, которую этот взрыв не трогает (танк, об который взорвалась машина);
  // body - кузов взорвавшейся машины: NPC в 3 м от него погибают (npcs.explode)
  explode(x, y, blast, ownerId, weaponId, skipVeh, body) {
    const m = this.map;
    this.ev.x.push([r2(x), r2(y), blast.r]);
    for (const p of this.players.values()) {
      if (!p.alive || !this.exposed(p)) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d >= blast.r + 0.4) continue;
      let dmg = blast.dmg * (1 - Math.max(0, d - 0.4) / blast.r);
      if (!geom.losClear(m, x, y, p.x, p.y, false)) dmg *= 0.4;
      this.damage(p, dmg, ownerId, weaponId, p.x, p.y);
    }
    this.npcs.explode(x, y, blast, ownerId, weaponId, body);
    // Машины: урон (ракета поджигает сразу), взрывная волна отбрасывает все машины вокруг.
    // Сидящий внутри от взрыва рядом не страдает - погибнет, только если взорвётся сама машина.
    for (const v of [...this.vehicles.list.values()]) {
      if (v.dead || (skipVeh && v.id === skipVeh)) continue;
      const d = KV.distToOBB(x, y, v.x, v.y, v.a, KV.boxOf(v).hl, KV.boxOf(v).hw);
      const reach = blast.r + 3;
      if (d >= reach) continue;
      if (d < blast.r) {
        const k = 1 - d / blast.r;
        this.vehicles.damage(v, blast.dmg * k * 1.6 * (v.blastK || 1), ownerId);
      }
      this.vehicles.blastPush(v, x, y, (1 - d / reach) * 14 * (v.pushK || 1));
    }
    const r = blast.r;
    for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
      for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
        if (tx <= 0 || ty <= 0 || tx >= m.w - 1 || ty >= m.h - 1) continue;
        const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
        if (d >= r) continue;
        const k = ty * m.w + tx;
        const bt = m.block[k];
        if (bt === B.NONE) continue;
        this.damageTile(k, blast.tile * (1 - d / r), ownerId, BLOCKS[bt].blast);
      }
    }
    // взрыв внутри дома обрушивает крышу
    const fx = Math.floor(x), fy = Math.floor(y);
    if (fx >= 0 && fy >= 0 && fx < m.w && fy < m.h) {
      const bid = m.owner[fy * m.w + fx];
      if (bid >= 0) this.collapseRoof(m.buildings[bid]);
    }
  }

  // mult - доля урона, которая доходит до клетки (у кирпича от пули - половина и т.п.)
  damageTile(k, amount, ownerId, mult = 1) {
    const m = this.map;
    const t = m.block[k];
    if (t === B.NONE || t === B.BORDER) return;
    const dmg = amount * mult;
    if (!(dmg > 0)) return;
    if (m.owner[k] >= 0) { const hb = m.buildings[m.owner[k]]; hb.hitAt = this.time; hb.whole = false; } // по дому бьют - ремонт ждёт
    const info = BLOCKS[t];
    const before = m.hp[k];
    m.hp[k] -= dmg;
    if (m.hp[k] <= 0) { this.destroyTile(k, ownerId); return; }
    const st = KV.damageStage(m.hp[k], info.hp);
    if (st !== KV.damageStage(before, info.hp)) {
      m.dmg[k] = st;
      this.ev.tl.push([k, t, st, m.ground[k]]);
    }
  }

  destroyTile(k, ownerId, skipVeh) {
    const m = this.map;
    const t = m.block[k];
    if (t === B.NONE || t === B.BORDER) return;
    if (m.owner[k] >= 0) { const hb = m.buildings[m.owner[k]]; hb.hitAt = this.time; hb.whole = false; }
    const info = BLOCKS[t];
    m.block[k] = B.NONE; m.hp[k] = 0; m.dmg[k] = 0;
    if (info.rubble !== undefined) m.ground[k] = info.rubble;
    this.ev.tl.push([k, 0, 0, m.ground[k], t]);
    const x = k % m.w, y = Math.floor(k / m.w);
    if (info.explode) this.pending.push({ at: this.time + 0.12, x: x + 0.5, y: y + 0.5, blast: info.explode, owner: ownerId, w: -1, skip: skipVeh || 0 });
    if (t === B.CRATE) { this.crates--; this.crateLoot(x + 0.5, y + 0.5, ownerId); }
    // соседние кирпичи трескаются: стена рушится кусками
    if (info.crumble) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx <= 0 || ny <= 0 || nx >= m.w - 1 || ny >= m.h - 1) continue;
        const nk = ny * m.w + nx;
        if (m.block[nk] === t) this.damageTile(nk, info.hp * info.crumble * (0.6 + Math.random() * 0.8), ownerId);
      }
    }
    const bid = m.owner[k];
    if (t === B.BRICK && bid >= 0) {
      const b = m.buildings[bid];
      b.destroyed++;
      if (b.roof && b.destroyed >= Math.max(3, Math.ceil(b.walls * 0.18))) this.collapseRoof(b);
    }
  }

  collapseRoof(b) {
    if (!b || !b.roof) return;
    b.roof = false;
    this.ev.rf.push(b.id);
  }

  // ---------- дома чинятся сами ----------
  // Запоминаем, где у каждого дома были кирпичные стены и окна (двери - проёмы, их не закладываем)
  initRebuild() {
    const m = this.map;
    for (const b of m.buildings) {
      b.orig = [];
      b.hitAt = -1e9;
      for (let y = b.y; y < b.y + b.h; y++) {
        for (let x = b.x; x < b.x + b.w; x++) {
          const k = y * m.w + x;
          if (m.owner[k] === b.id && (m.block[k] === B.BRICK || m.block[k] === B.GLASS)) b.orig.push([k, m.block[k], m.ground[k]]);
        }
      }
    }
  }
  // Через минуту без урона дом чинится по кирпичику: раз в 0.3 с одна клетка (сначала рядом с уцелевшей стеной),
  // потом зарастают трещины; дом снова целый - возвращается крыша. Туда, где стоит человек или машина, лежит тело
  // или вещь, кирпич не встаёт - ждёт, пока место освободится (никого не замуровывает).
  updateRebuild() {
    const m = this.map, now = this.time;
    for (const b of m.buildings) {
      if (!b.orig || b.whole || now - b.hitAt < REBUILD_DELAY) continue;
      let best = null, bestScore = -1, crack = null, missing = 0;
      for (const e of b.orig) {
        const k = e[0], cur = m.block[k];
        if (cur === e[1]) { if (m.dmg[k] && !crack) crack = e; continue; }
        if (cur !== B.NONE) continue; // на месте стены что-то другое - не трогаем
        missing++;
        const x = k % m.w, y = (k / m.w) | 0;
        let score = Math.random() * 0.5;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nb = m.block[(y + dy) * m.w + x + dx];
          if (nb === B.BRICK || nb === B.GLASS) score += 1;
        }
        if (score > bestScore && this.tileFree(k)) { bestScore = score; best = e; }
      }
      if (best) this.restoreTile(b, best[0], best[1], best[2]);
      else if (crack) { const k = crack[0]; m.hp[k] = BLOCKS[crack[1]].hp; m.dmg[k] = 0; this.ev.tl.push([k, crack[1], 0, m.ground[k]]); }
      else if (!missing) {
        b.whole = true;
        b.destroyed = 0;
        if (!b.roof) { b.roof = true; this.ev.rr.push(b.id); }
      }
    }
  }
  restoreTile(b, k, t, g) {
    const m = this.map;
    m.block[k] = t; m.hp[k] = BLOCKS[t].hp; m.dmg[k] = 0; m.ground[k] = g;
    if (t === B.BRICK) b.destroyed = Math.max(0, b.destroyed - 1);
    this.ev.tl.push([k, t, 0, g]);
  }
  // можно ли поставить на клетку стену: никого и ничего рядом (у живых игроков - с запасом на задержку сети)
  tileFree(k) {
    const m = this.map, x = (k % m.w) + 0.5, y = ((k / m.w) | 0) + 0.5;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const r = p.isBot ? 1.0 : 1.6;
      if (Math.abs(p.x - x) < r && Math.abs(p.y - y) < r) return false;
    }
    for (const n of this.npcs.list.values()) if (!n.veh && Math.abs(n.x - x) < 1.1 && Math.abs(n.y - y) < 1.1) return false;
    for (const v of this.vehicles.list.values()) {
      if (v.dead || Math.abs(v.x - x) > 3.2 || Math.abs(v.y - y) > 3.2) continue;
      if (KV.distToOBB(x, y, v.x, v.y, v.a, KV.boxOf(v).hl, KV.boxOf(v).hw) < 1.0) return false;
    }
    for (const pk of this.pickups.values()) if (Math.abs(pk.x - x) < 0.9 && Math.abs(pk.y - y) < 0.9) return false;
    return !this.tileFires.has(k);
  }

  updatePending() {
    if (!this.pending.length) return;
    const due = this.pending.filter(e => e.at <= this.time);
    if (!due.length) return;
    this.pending = this.pending.filter(e => e.at > this.time);
    for (const e of due) this.explode(e.x, e.y, e.blast, e.owner, e.w, e.skip);
  }

  // ---------- ящики: внутри что-то лежит, со временем появляются новые ----------
  randomWeapon() {
    let total = 0;
    for (const [, wgt] of WEAPON_WEIGHTS) total += wgt;
    let r = Math.random() * total;
    for (const [w, wgt] of WEAPON_WEIGHTS) { r -= wgt; if (r <= 0) return w; }
    return W.PISTOL;
  }

  // Что выпадает из ящика или взорванной машины: гриб, оружие, патроны к своему оружию, аптечка, броня
  lootItem(x, y, ownerId) {
    const p = this.players.get(ownerId);
    const r = Math.random();
    if (r < 0.12) { this.addPickup(PK.SHROOM, 0, x, y, 1); return; }
    if (r < 0.42) { const w = this.randomWeapon(); this.addPickup(PK.WEAPON, w, x, y, WEAPONS[w].pick); return; }
    if (r < 0.64) {
      // патроны - к тому оружию, которое у разбившего уже есть
      const owned = p ? WEAPONS.filter(w => w.id && !w.noAmmo && p.ammo[w.id] >= 0).map(w => w.id) : [];
      if (owned.length) { const w = owned[Math.floor(Math.random() * owned.length)]; this.addPickup(PK.AMMO, w, x, y, WEAPONS[w].box); }
      else { const w = this.randomWeapon(); this.addPickup(PK.WEAPON, w, x, y, WEAPONS[w].pick); }
      return;
    }
    this.addPickup(r < 0.83 ? PK.HEALTH : PK.ARMOR, 0, x, y, r < 0.83 ? 40 : 50);
  }

  crateLoot(x, y, ownerId) {
    if (Math.random() < 0.9) this.lootItem(x, y, ownerId);
  }

  // из взорванной машины вылетает одна-две вещи рядом с ней
  carLoot(x, y, ownerId) {
    const n = Math.random() < 0.15 ? 0 : Math.random() < 0.45 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      for (let tries = 0; tries < 12; tries++) {
        const a = Math.random() * Math.PI * 2, d = 0.8 + Math.random() * 1.8;
        const lx = x + Math.cos(a) * d, ly = y + Math.sin(a) * d;
        if (!KV.circleFree(this.map, lx, ly, 0.35)) continue;
        this.lootItem(lx, ly, ownerId);
        break;
      }
    }
  }

  updateCrates() {
    if (this.time < this.nextCrateAt) return;
    this.nextCrateAt = this.time + 4 + Math.random() * 3;
    if (this.crates >= this.map.crates) return;
    const m = this.map;
    const tiles = m.pickupTiles;
    for (let tries = 0; tries < 40; tries++) {
      const k = tiles[Math.floor(Math.random() * tiles.length)];
      if (m.block[k] !== B.NONE || m.keep[k] || m.ground[k] === G.ROAD) continue;
      const x = k % m.w, y = Math.floor(k / m.w);
      let open = true;
      for (let j = -1; j <= 1 && open; j++) {
        for (let i = -1; i <= 1; i++) {
          const nk = (y + j) * m.w + x + i;
          if (m.block[nk] !== B.NONE || m.ground[nk] === G.WATER) { open = false; break; }
        }
      }
      if (!open) continue;
      let ok = true;
      for (const p of this.players.values()) if (p.alive && Math.hypot(p.x - x - 0.5, p.y - y - 0.5) < 12) { ok = false; break; }
      if (ok) for (const pk of this.pickups.values()) if (Math.hypot(pk.x - x - 0.5, pk.y - y - 0.5) < 1.5) { ok = false; break; }
      if (ok && this.vehicles.personBlocked(x + 0.5, y + 0.5, null)) ok = false;
      if (!ok) continue;
      m.block[k] = B.CRATE; m.hp[k] = BLOCKS[B.CRATE].hp; m.dmg[k] = 0;
      this.crates++;
      this.ev.tl.push([k, B.CRATE, 0, m.ground[k]]);
      return;
    }
  }

  // ---------- оружие на карте ----------
  addPickup(kind, w, x, y, amount) {
    if (this.pickups.size >= MAX_PICKUPS) {
      let oldest = null;
      for (const pk of this.pickups.values()) if (pk.kind !== PK.STAR) { oldest = pk; break; }
      if (oldest) this.removePickup(oldest.id);
    }
    const pk = { id: this.nextPickup++, kind, w, x, y, amount, born: this.time };
    this.pickups.set(pk.id, pk);
    this.ev.pa.push([pk.id, kind, w, r2(x), r2(y)]);
    return pk;
  }

  removePickup(id) {
    if (this.pickups.delete(id)) this.ev.pr.push(id);
  }

  randomPickupSpot(minPlayerDist) {
    const m = this.map;
    const tiles = m.pickupTiles;
    for (let i = 0; i < 40; i++) {
      const k = tiles[Math.floor(Math.random() * tiles.length)];
      if (m.block[k] !== B.NONE) continue;
      const x = (k % m.w) + 0.5, y = Math.floor(k / m.w) + 0.5;
      let ok = true;
      for (const pk of this.pickups.values()) if (Math.hypot(pk.x - x, pk.y - y) < 4) { ok = false; break; }
      if (ok) for (const p of this.players.values()) if (p.alive && Math.hypot(p.x - x, p.y - y) < minPlayerDist) { ok = false; break; }
      if (ok) return [x, y];
    }
    return null;
  }

  spawnWeaponDrop() {
    const wid = this.randomWeapon();
    const spot = this.randomPickupSpot(5);
    if (!spot) return;
    const [x, y] = spot;
    this.addPickup(PK.WEAPON, wid, x, y, WEAPONS[wid].pick);
    // коробка патронов к нему - рядом
    const m = this.map;
    const around = [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2], [1.1, 1.1], [-1.1, 1.1], [1.1, -1.1], [-1.1, -1.1]];
    for (let i = around.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [around[i], around[j]] = [around[j], around[i]]; }
    for (const [dx, dy] of around) {
      const ax = x + dx, ay = y + dy;
      if (KV.circleFree(m, ax, ay, 0.35) && geom.losClear(m, x, y, ax, ay, false)) {
        this.addPickup(PK.AMMO, wid, ax, ay, WEAPONS[wid].box);
        break;
      }
    }
  }

  updatePickups() {
    if (this.time >= this.nextWeaponAt) {
      this.spawnWeaponDrop();
      this.nextWeaponAt = this.time + 5 + Math.random() * 4; // примерно раз в 7 секунд
    }
    if (this.time >= this.nextSupplyAt) {
      const spot = this.randomPickupSpot(5);
      if (spot) this.addPickup(Math.random() < 0.55 ? PK.HEALTH : PK.ARMOR, 0, spot[0], spot[1], 50);
      this.nextSupplyAt = this.time + 10 + Math.random() * 6;
    }
    // аптечки отдельно от припасов: вместе их вдвое больше, чем было
    if (this.time >= this.nextMedAt) {
      const spot = this.randomPickupSpot(5);
      if (spot) this.addPickup(PK.HEALTH, 0, spot[0], spot[1], 50);
      this.nextMedAt = this.time + MED_EVERY[0] + Math.random() * (MED_EVERY[1] - MED_EVERY[0]);
    }
    // звёзды погашения розыска: всегда три на карте, подобрали - через 25-45 с новая в другом месте
    if (this.time >= this.nextStarAt) {
      let n = 0;
      for (const pk of this.pickups.values()) if (pk.kind === PK.STAR) n++;
      if (n < 3) { const spot = this.randomPickupSpot(15); if (spot) this.addPickup(PK.STAR, 0, spot[0], spot[1], 1); }
      this.nextStarAt = this.time + (n < 2 ? 2 : 25 + Math.random() * 20);
    }
    // грибы: до трёх на карте, вырастают где попало
    if (this.time >= this.nextShroomAt) {
      this.nextShroomAt = this.time + 18 + Math.random() * 18;
      let n = 0;
      for (const pk of this.pickups.values()) if (pk.kind === PK.SHROOM) n++;
      if (n < 3) { const spot = this.randomPickupSpot(6); if (spot) this.addPickup(PK.SHROOM, 0, spot[0], spot[1], 1); }
    }
    for (const pk of [...this.pickups.values()]) {
      if (pk.kind !== PK.STAR && this.time - pk.born > PICKUP_LIFE) { this.removePickup(pk.id); continue; }
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const r = p.vehicle ? 1.7 : 0.85;
        const dx = p.x - pk.x, dy = p.y - pk.y;
        if (dx * dx + dy * dy > r * r) continue;
        if (this.tryPick(p, pk)) { this.removePickup(pk.id); break; }
      }
    }
  }

  tryPick(p, pk) {
    if (pk.kind === PK.WEAPON && WEAPONS[pk.w].noAmmo) {
      // щит: берут люди (боты им не пользуются), второй не нужен
      if (p.isBot || p.ammo[pk.w] >= 0) return false;
      p.ammo[pk.w] = 0;
      if (p.cur === W.FISTS) p.cur = pk.w;
    } else if (pk.kind === PK.WEAPON) {
      const w = WEAPONS[pk.w];
      const had = p.ammo[pk.w] >= 0;
      if (had && p.ammo[pk.w] >= w.max) return false;
      p.ammo[pk.w] = Math.min(w.max, Math.max(0, p.ammo[pk.w]) + (pk.amount || w.pick));
      if (!had || p.cur === W.FISTS) p.cur = pk.w;
    } else if (pk.kind === PK.AMMO) {
      const w = WEAPONS[pk.w];
      if (!(p.ammo[pk.w] >= 0) || p.ammo[pk.w] >= w.max) return false;
      p.ammo[pk.w] = Math.min(w.max, p.ammo[pk.w] + (pk.amount || w.box));
    } else if (pk.kind === PK.SHROOM) {
      p.tripUntil = this.time + KV.TRIP;
      p.hp = Math.min(KV.MAX_HP, p.hp + 50); // гриб лечит, как аптечка
    } else if (pk.kind === PK.STAR) {
      if (!(p.stars > 0) || p.isBot) return false; // без розыска звезда лежит дальше
      this.npcs.starPicked(p);
    } else if (pk.kind === PK.MONEY) {
      if (p.isBot) return false; // ботам деньги ни к чему
      p.money = (p.money || 0) + (pk.amount || 0);
    } else if (pk.kind === PK.HEALTH) {
      if (p.hp >= KV.MAX_HP) return false;
      p.hp = Math.min(KV.MAX_HP, p.hp + (pk.amount || 50));
    } else {
      if (p.ar >= KV.MAX_ARMOR) return false;
      p.ar = Math.min(KV.MAX_ARMOR, p.ar + (pk.amount || 50));
    }
    this.ev.pu.push([p.id, pk.kind, pk.w, pk.kind === PK.MONEY ? pk.amount : 0]);
    return true;
  }

  // Круги-чекпоинты: больница и оружейный - пешком, автомастерская - на машине. Постоял - покупка, если хватает денег;
  // чтобы купить ещё раз, надо сойти с круга и встать снова.
  updateShops() {
    const shops = this.map.shops || [];
    for (const p of this.players.values()) {
      if (p.isBot || !p.alive) continue;
      let at = -1;
      for (let i = 0; i < shops.length; i++) {
        const s = shops[i];
        if ((s.kind === 'fix') !== !!p.vehicle || Math.hypot(p.x - s.x, p.y - s.y) > s.r) continue;
        at = i; break;
      }
      if (at !== p.shopAt) {
        if (p.healPaid) { this.send(p, { t: 'shop', k: 'med', ok: p.healPaid, part: 1 }); p.healPaid = 0; }
        p.shopAt = at; p.shopT = 0; p.shopDone = false; p.shopMsg = 0;
        if (at < 0) continue;
      }
      if (at < 0) continue;
      const s = shops[at];
      if (s.kind === 'med') { this.heal(p); continue; }   // больница лечит сразу, порциями
      if (s.kind === 'gun' || p.shopDone) continue;       // оружейный: игрок выбирает на панели (сообщение buy)
      p.shopT += 3 * DT;
      if (p.shopT >= SHOP_TIME[s.kind]) { p.shopDone = true; this.buy(p, s); }
    }
  }
  // Больница (17.11.2026): лечит сразу, как встал на круг, - по +10 здоровья каждые 0.1 с, $5 за каждые 10
  // (полное лечение - те же $50). Деньги кончились - лечение встаёт, надпись одна.
  heal(p) {
    if (p.hp >= KV.MAX_HP) {
      if (p.healPaid) { this.send(p, { t: 'shop', k: 'med', ok: p.healPaid }); p.healPaid = 0; }
      else if (!(p.shopMsg & 1)) { p.shopMsg |= 1; this.send(p, { t: 'shop', k: 'med', full: 1 }); }
      return;
    }
    const add = Math.min(MED_STEP, KV.MAX_HP - p.hp);
    const cost = Math.ceil(KV.SHOP_PRICE.med * add / MED_STEP);
    if ((p.money || 0) < cost) {
      if (!(p.shopMsg & 2)) { p.shopMsg |= 2; this.send(p, { t: 'shop', k: 'med', need: cost, paid: p.healPaid || 0 }); p.healPaid = 0; }
      return;
    }
    p.hp = Math.min(KV.MAX_HP, p.hp + add);
    p.money -= cost;
    p.healPaid = (p.healPaid || 0) + cost;
  }
  // Оружейный (17.11.2026): игрок выбирает на панели, у каждого оружия своя цена; уже есть - пополнить до полного
  // (миниган - +1000, запас до 10 000); щит второй не нужен
  buyGun(p, w) {
    const shops = this.map.shops || [];
    const s = p.shopAt >= 0 ? shops[p.shopAt] : null;
    if (!p.alive || p.vehicle || !s || s.kind !== 'gun' || Math.hypot(p.x - s.x, p.y - s.y) > s.r + 0.4) return;
    const ww = WEAPONS[w], price = KV.GUN_PRICE[w];
    if (!ww || !(price > 0)) return;
    if (ww.noAmmo ? p.ammo[w] >= 0 : p.ammo[w] >= ww.max) { this.send(p, { t: 'shop', k: 'gun', have: 1, w }); return; }
    if ((p.money || 0) < price) { this.send(p, { t: 'shop', k: 'gun', need: price, w }); return; }
    if (ww.noAmmo) p.ammo[w] = 0;
    else p.ammo[w] = ww.shop ? Math.min(ww.max, Math.max(0, p.ammo[w]) + ww.shop) : ww.max;
    p.cur = w; p.spinT = 0;
    p.money -= price;
    this.send(p, { t: 'shop', k: 'gun', ok: price, w });
  }
  buy(p, s) {
    const price = KV.SHOP_PRICE[s.kind];
    if ((p.money || 0) < price) { this.send(p, { t: 'shop', k: s.kind, need: price }); return; }
    // автомастерская: новый цвет, полный ремонт (и пожар потушен), все звёзды розыска сняты - погоня уезжает
    const v = this.vehicles.list.get(p.vehicle);
    if (!v) return;
    v.color = (v.color + 1 + Math.floor(Math.random() * 7)) % 8;
    v.hp = v.maxHp || CAR.HP; v.burn = 0;
    this.npcs.clearStars(p);
    p.money -= price;
    this.send(p, { t: 'shop', k: s.kind, ok: price });
  }

  // ---------- рассылка ----------
  flushEvents() {
    const out = { t: 'e' };
    let any = false;
    for (const key in this.ev) if (this.ev[key].length) { out[key] = this.ev[key]; any = true; }
    this.ev = emptyEvents();
    if (!any) return;
    const json = JSON.stringify(out);
    for (const p of this.players.values()) if (!p.isBot) this.send(p, json);
  }

  sendSnapshots() {
    const ts = Date.now();
    const all = [...this.players.values()];
    const cars = [...this.vehicles.list.values()];
    for (const p of all) {
      if (p.isBot) continue;
      const vw = p.view[0] + 6, vh = p.view[1] + 6;
      const list = [];
      for (const o of all) {
        if (o !== p && (Math.abs(o.x - p.x) > vw || Math.abs(o.y - p.y) > vh)) continue;
        const flags = (o.alive ? 1 : 0) | (this.time < o.prot ? 2 : 0) | (this.time - o.shotAt < 0.15 ? 4 : 0) | (o.vehicle ? 8 : 0) |
          (this.time < o.rollUntil ? 16 : 0) | (this.time < o.burnUntil ? 32 : 0) | (this.time < o.tripUntil ? 64 : 0) |
          (this.time < o.talkUntil ? 128 : 0) | (o.voice ? 256 : 0);
        list.push([o.id, r2(o.x), r2(o.y), r3(o.a), flags, o.cur, Math.max(0, Math.ceil(o.hp))]);
      }
      const c = [];
      for (const v of cars) {
        if (v.dead || Math.abs(v.x - p.x) > vw + 10 || Math.abs(v.y - p.y) > vh + 10) continue;
        c.push(this.vehicles.snap(v));
      }
      const me = [Math.max(0, Math.ceil(p.hp)), Math.ceil(p.ar), p.cur, p.ammo, p.alive ? 0 : r2(Math.max(0, p.respawnAt - this.time)),
        p.alive ? 1 : 0, Math.round(p.stamina), p.vehicle || 0, p.stars || 0, p.money || 0];
      const gr = [];
      for (const g of this.grenades) if (Math.abs(g.x - p.x) < vw && Math.abs(g.y - p.y) < vh) gr.push([g.id, r2(g.x), r2(g.y), g.t < 0.6 ? 1 : 0]);
      this.send(p, { t: 's', ts, p: list, c, n: this.npcs.snapFor(p, vw, vh), h: this.npcs.heliSnap(p, vw + 15, vh + 15), gr, me });
    }
  }

  sendPings() {
    // кто стрелял последние 2.5 с - красная точка на миникарте у всех (кулаки не считаются)
    const l = [];
    for (const p of this.players.values()) if (p.alive && this.time - p.shotAt < 2.5 && p.cur !== W.FISTS) l.push([p.id, Math.round(p.x), Math.round(p.y)]);
    // настоящие игроки видят друг друга на карте всегда
    const h = [];
    for (const p of this.players.values()) if (!p.isBot && p.alive) h.push([p.id, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
    // полиция и спецназ с мигалками, скорая, танки и вертолёты - на радаре у всех
    const pc = [], am = [], tk = [], hl = [];
    for (const v of this.vehicles.list.values()) {
      if (v.dead || v.state !== 'npc') continue;
      if (v.kind === 'tank') tk.push([Math.round(v.x), Math.round(v.y)]);
      else if (v.siren) (v.kind === 'amb' ? am : pc).push([Math.round(v.x), Math.round(v.y)]);
    }
    for (const q of this.npcs.helis.values()) hl.push([Math.round(q.x), Math.round(q.y)]);
    const json = JSON.stringify({ t: 'mm', l, h, pc, am, tk, hl });
    for (const p of this.players.values()) if (!p.isBot) this.send(p, json);
  }

  sendScoreboard() {
    this.sbDirty = false;
    const json = JSON.stringify({ t: 'sb', l: [...this.players.values()].map(p => [p.id, p.kills, p.deaths, p.civKills || 0, p.copKills || 0]) });
    for (const p of this.players.values()) if (!p.isBot) this.send(p, json);
  }
}

module.exports = { Room, MAX_HUMANS };
