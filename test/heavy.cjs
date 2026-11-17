/* Тяжёлая техника в браузере (нужен сервер с KV_DEBUG=1): спецназ на 3 звёздах, вертолёт на 4 (виден, на радаре,
   сбивается, если целиться в него), танки на 5; угон танка - атака стреляет снарядом из башни, патроны не тратятся. */
const { chromium } = require(process.env.PW_PATH || 'playwright');
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const OUT = process.argv[3] || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: process.env.CH || 'chrome' });
  const errors = [];
  let ok = true;
  const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) ok = false; };
  try {
    const pc = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    pc.on('pageerror', e => errors.push(e.message));
    pc.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await pc.goto(BASE + '/?room=heavy' + Date.now().toString(36).slice(-4));
    await pc.fill('#nameInput', 'Танкист');
    await pc.click('#btnJoin');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    const kv = (f, arg) => pc.evaluate(f, arg);
    await kv(() => window.__kv.send({ t: 'bots', on: false }));
    // неуязвим и под огнём: проверяем технику, а не выживание
    const god = () => kv(() => window.__kv.send({ t: 'dbg', god: 1, immortal: 1 }));
    await god();
    // точка мира -> экран (css px), в пределах окна
    const toScreen = (x, y) => kv(([px, py]) => {
      const v = window.__kv.S.view, dpr = document.getElementById('game').width / innerWidth;
      return { x: Math.max(5, Math.min(innerWidth - 5, (px * v.tp + v.ox) / dpr)), y: Math.max(5, Math.min(innerHeight - 5, (py * v.tp + v.oy) / dpr)) };
    }, [x, y]);

    // 1. три звезды - грузовик спецназа, бойцы в чёрном
    await kv(() => window.__kv.send({ t: 'dbg', wanted: 210 }));
    let swat = { truck: 0, men: 0 };
    for (let i = 0; i < 90 && !(swat.truck && swat.men) ; i++) {
      await sleep(500);
      swat = await kv(() => { const S = window.__kv.S, t = performance.now();
        return { truck: [...S.vehicles.values()].filter(v => v.kind === 3 && t - (v.drawnAt || 0) < 400).length, men: [...S.peds.values()].filter(n => n.kind === 5 && (n.fl & 1) && t - (n.drawnAt || 0) < 400).length }; });
      if (swat.men >= 3) break;
    }
    console.log(`спецназ на экране: грузовиков ${swat.truck}, бойцов ${swat.men}`);
    check(swat.truck > 0 || swat.men > 0, 'на 3 звёздах приехал спецназ');
    await pc.screenshot({ path: OUT + '/heavy_swat.png' });

    // 2. четыре звезды - вертолёт: нарисован, на радаре
    await kv(() => window.__kv.send({ t: 'dbg', wanted: 200 }));
    let heli = null;
    for (let i = 0; i < 60 && !heli; i++) {
      await sleep(500);
      heli = await kv(() => { const S = window.__kv.S; const h = [...S.helis.values()].find(q => !(q.fl & 1) && performance.now() - (q.drawnAt || 0) < 300 && Math.hypot(q.rx - S.me.x, q.ry - S.me.y) < 14);
        return h ? { id: h.id, mm: S.helisMM.length } : null; });
    }
    check(!!heli, 'на 4 звёздах прилетел вертолёт и кружит рядом');
    check(!!heli && heli.mm >= 1, 'вертолёт виден на радаре');
    await pc.screenshot({ path: OUT + '/heavy_heli.png' });

    // 3. сбить вертолёт из автомата: прицел на нём - пули летят вверх, стены не мешают
    let downed = false, shots = 0;
    if (heli) {
      await kv(() => window.__kv.send({ t: 'dbg', give: 1, weapon: 2, immortal: 1 }));
      await sleep(300);
      let pos = await kv(id => { const h = window.__kv.S.helis.get(id); return h ? [h.rx, h.ry] : null; }, heli.id);
      if (pos) { const p = await toScreen(pos[0], pos[1]); await pc.mouse.move(p.x, p.y); }
      await pc.mouse.down();
      for (let i = 0; i < 260 && !downed; i++) {
        const st = await kv(id => { const h = window.__kv.S.helis.get(id); return !h ? { gone: 1 } : { fall: h.fl & 1, x: h.rx, y: h.ry, hp: h.hp }; }, heli.id);
        if (st.gone || st.fall) { downed = true; break; }
        const p = await toScreen(st.x, st.y);
        await pc.mouse.move(p.x, p.y);
        shots++;
        await sleep(90);
      }
      await pc.mouse.up();
    }
    console.log(`стрельба по вертолёту: ${shots} шагов прицела, сбит ${downed}`);
    check(downed, 'вертолёт сбивают пулями, если целиться в него');
    await sleep(1500);
    await pc.screenshot({ path: OUT + '/heavy_heli_down.png' });

    // 4. пять звёзд - танки (нарисованы на экране и видны на радаре)
    await god();
    await kv(() => window.__kv.send({ t: 'dbg', wanted: 300 }));
    let tank = null;
    for (let i = 0; i < 100 && !tank; i++) {
      await sleep(500);
      tank = await kv(() => { const S = window.__kv.S; const v = [...S.vehicles.values()].find(q => q.kind === 4 && performance.now() - (q.drawnAt || 0) < 300);
        return v ? { tur: v.tur, mm: S.tanks.length } : null; });
    }
    console.log(`танк: ${tank ? 'на экране, на радаре ' + tank.mm : 'не доехал'}`);
    check(!!tank, 'на 5 звёздах приехал танк');
    check(!!tank && tank.mm >= 1, 'танк виден на радаре');
    await pc.screenshot({ path: OUT + '/heavy_tank.png' });

    // 5. угнать танк: атака - снаряд из башни, патроны в руках не тратятся, башня смотрит в прицел
    await kv(() => window.__kv.send({ t: 'dbg', veh: 'tank', immortal: 1 }));
    await sleep(700);
    await pc.keyboard.press('KeyF');
    await pc.waitForFunction(() => window.__kv.S.car && window.__kv.S.car.kind === 4, null, { timeout: 5000 }).catch(() => {});
    const inTank = await kv(() => !!(window.__kv.S.car && window.__kv.S.car.kind === 4));
    check(inTank, 'в танк можно сесть');
    if (inTank) {
      await kv(() => {
        const S = window.__kv.S;
        window.__shells = 0;
        const orig = S.bullets.set.bind(S.bullets);
        S.bullets.set = (id, b) => { if (b.w === 5 && S.car && Math.hypot(b.x0 - S.car.x, b.y0 - S.car.y) < 3.6) window.__shells++; return orig(id, b); };
      });
      const before = await kv(() => ({ cur: window.__kv.S.me.cur, ammo: window.__kv.S.me.ammo[window.__kv.S.me.cur] }));
      const aimAt = await kv(() => { const S = window.__kv.S; return [S.car.x + 9, S.car.y - 4]; });
      const p = await toScreen(aimAt[0], aimAt[1]);
      await pc.mouse.move(p.x, p.y);
      await pc.mouse.down();
      await sleep(2300);
      await pc.mouse.up();
      await sleep(600);
      const after = await kv(cur => { const S = window.__kv.S, v = S.vehicles.get(S.me.vehicle);
        return { shells: window.__shells, ammo: S.me.ammo[cur], tr: v ? v.tr : null, a: S.me.a }; }, before.cur);
      console.log(`из танка: снарядов ${after.shells}, патронов в руках было ${before.ammo}, стало ${after.ammo}; башня ${after.tr !== null ? after.tr.toFixed(2) : '-'} при прицеле ${after.a.toFixed(2)}`);
      check(after.shells >= 1, 'из танка летят снаряды');
      check(after.ammo === before.ammo, 'патроны в руках не тратятся');
      check(after.tr !== null && Math.abs(after.tr - after.a) < 0.05, 'башня смотрит туда, куда целишься');
      // поехать: танк трогается, давит на ходу
      const x0 = await kv(() => [window.__kv.S.car.x, window.__kv.S.car.y]);
      await pc.keyboard.down('KeyW'); await sleep(1500); await pc.keyboard.up('KeyW');
      const x1 = await kv(() => [window.__kv.S.car.x, window.__kv.S.car.y, window.__kv.S.car.v]);
      console.log(`танк проехал ${Math.hypot(x1[0] - x0[0], x1[1] - x0[1]).toFixed(1)} м за 1.5 с`);
      check(Math.hypot(x1[0] - x0[0], x1[1] - x0[1]) > 2, 'танк едет');
      await pc.screenshot({ path: OUT + '/heavy_mytank.png' });
    }
  } catch (e) {
    ok = false;
    console.log('FAIL исключение:', e.message);
  } finally {
    check(errors.length === 0, 'ошибок в консоли нет' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
    await browser.close();
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    process.exitCode = ok ? 0 : 1;
  }
})();
