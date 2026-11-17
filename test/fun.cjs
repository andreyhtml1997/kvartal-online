/* Огнемёт, пила, гриб и кувырок в браузере (нужен сервер с KV_DEBUG=1). Запуск: node test/fun.cjs <адрес> <папка> */
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
    await pc.goto(BASE + '/?room=fun' + Date.now().toString(36).slice(-4));
    await pc.fill('#nameInput', 'Пиротехник');
    await pc.click('#btnJoin');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    await sleep(800);
    const kv = (f, arg) => pc.evaluate(f, arg);
    const players = await kv(() => window.__kv.S.players.size);
    check(players === 10, `в комнате 10 персонажей (${players})`);
    await kv(() => window.__kv.send({ t: 'dbg', god: 1, weapon: 6 }));
    await sleep(500);
    check(await kv(() => window.__kv.S.me.cur === 6), 'в руках огнемёт');
    await pc.mouse.move(900, 360);
    await pc.mouse.down(); await sleep(900);
    await pc.screenshot({ path: OUT + '/flamer.png' });
    await pc.mouse.up(); await sleep(400);
    const flames = await kv(() => window.__kv.S.particles.filter(p => p.kind === 'fire').length);
    console.log(`частиц огня на экране: ${flames}`);
    const fuel = await kv(() => window.__kv.S.me.ammo[6]);
    check(fuel < 300, `огнемёт тратит топливо (${fuel} из 300)`);
    await kv(() => window.__kv.send({ t: 'dbg', god: 1, weapon: 7 }));
    await sleep(500);
    await pc.mouse.down(); await sleep(700);
    await pc.screenshot({ path: OUT + '/saw.png' });
    await pc.mouse.up(); await sleep(300);
    const gas = await kv(() => window.__kv.S.me.ammo[7]);
    check(gas < 300, `пила тратит бензин (${gas} из 300)`);
    // гриб под ногами: подходим - эффект 10 с
    await kv(() => window.__kv.send({ t: 'dbg', god: 1, shroom: 1 }));
    await sleep(600);
    const sh = await kv(() => { const S = window.__kv.S; let best = null, bd = 1e9;
      for (const p of S.pickups.values()) { if (p.kind !== 4) continue; const d = Math.hypot(p.x - S.me.x, p.y - S.me.y); if (d < bd) { bd = d; best = { x: p.x, y: p.y, d }; } }
      return best; });
    console.log(`ближайший гриб в ${sh ? sh.d.toFixed(1) : '-'} м`);
    check(!!sh, 'гриб появился на карте');
    if (sh) await kv(p => window.__kv.send({ t: 'dbg', tp: [p.x, p.y] }), sh);
    await pc.waitForFunction(() => !!window.__kv.S.trip, null, { timeout: 4000 }).catch(() => {});
    check(await kv(() => !!window.__kv.S.trip), 'гриб съеден - начался эффект');
    await pc.keyboard.down('KeyD'); await sleep(1500);
    await pc.screenshot({ path: OUT + '/trip.png' });
    await pc.keyboard.up('KeyD');
    const filt = await kv(() => document.getElementById('game').style.filter);
    check(/hue-rotate/.test(filt), `экран в кислотных цветах (${filt.slice(0, 40)})`);
    const ph = await kv(() => window.__kv.S.phantoms.length);
    check(ph >= 5, `видения бродят вокруг (${ph})`);
    // кувырок: в машину, разгон, выход на ходу
    await kv(() => window.__kv.send({ t: 'dbg', nearCar: 1 }));
    await sleep(900);
    await pc.keyboard.press('KeyF');
    await pc.waitForFunction(() => window.__kv.S.me.vehicle > 0, null, { timeout: 5000 }).catch(() => {});
    check(await kv(() => window.__kv.S.me.vehicle > 0), 'сел в машину');
    // разгон по свободному направлению: смотрим, куда дальше свободно, и разворачиваем машину туда
    await kv(() => { const S = window.__kv.S, KV = window.KV; let best = 0, bl = -1;
      for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8; let l = 0; for (let d = 1; d < 30; d++) { if (KV.carOverlapsSolid(S.map, S.car.x + Math.cos(a) * d, S.car.y + Math.sin(a) * d, a, 0.05)) break; l = d; } if (l > bl) { bl = l; best = a; } }
      S.car.a = best; });
    await pc.keyboard.down('KeyW'); await sleep(1400);
    const v = await kv(() => Math.abs(window.__kv.S.car ? window.__kv.S.car.v : 0));
    await pc.keyboard.press('KeyF');
    await pc.waitForFunction(() => window.__kv.S.me.vehicle === 0, null, { timeout: 5000 }).catch(() => {});
    await pc.keyboard.up('KeyW');
    await sleep(250);
    const roll = await kv(() => window.__kv.S.me.rollUntil - performance.now());
    await pc.screenshot({ path: OUT + '/roll.png' });
    console.log(`скорость при выходе ${v.toFixed(1)} м/с, кувырок ещё ${roll.toFixed(0)} мс`);
    check(v > 7.5 ? roll > 0 : roll <= 0, v > 7.5 ? 'выпрыгнул на скорости - катится' : 'на малой скорости кувырка нет');
    await sleep(1500);
    check(await kv(() => window.__kv.S.me.rollUntil < performance.now()), 'после кувырка встал');
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
