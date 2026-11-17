/* Мотоцикл в браузере (нужен сервер с KV_DEBUG=1): сесть, разогнаться быстрее машины, на полном ходу врезаться
   (в машину или в край карты) и вылететь через руль; второй игрок видит мотоцикл с водителем; ошибок нет. */
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
    const room = 'moto' + Date.now().toString(36).slice(-4);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
    const pc = await ctx.newPage();
    pc.on('pageerror', e => errors.push(e.message));
    pc.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await pc.goto(BASE + '/?room=' + room);
    await pc.fill('#nameInput', 'Байкер');
    await pc.click('#btnJoin');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    const kv = (f, arg) => pc.evaluate(f, arg);
    await kv(() => window.__kv.send({ t: 'dbg', veh: 'moto', god: 1, immortal: 1 }));
    await sleep(800);

    const me0 = await kv(() => [window.__kv.S.me.x, window.__kv.S.me.y]);
    await pc.keyboard.press('KeyF');
    await pc.waitForFunction(() => window.__kv.S.car && window.__kv.S.car.kind === 5, null, { timeout: 5000 }).catch(() => {});
    const onBike = await kv(() => ({ kind: window.__kv.S.car ? window.__kv.S.car.kind : 0, hud: document.getElementById('carText').textContent }));
    check(onBike.kind === 5, 'на мотоцикл можно сесть');
    check(/Мотоцикл/.test(onBike.hud), `на полоске прочности написано «${onBike.hud}»`);
    await sleep(600);
    await pc.screenshot({ path: OUT + '/moto_sit.png', clip: { x: 440, y: 200, width: 400, height: 320 } });

    // второй игрок встаёт рядом - смотрит со стороны
    const obs = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
    obs.on('pageerror', e => errors.push('obs: ' + e.message));
    await obs.goto(BASE + '/?room=' + room);
    await obs.fill('#nameInput', 'Зритель');
    await obs.click('#btnJoin');
    await obs.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    await obs.evaluate(([x, y]) => window.__kv.send({ t: 'dbg', tpTo: [x, y], god: 1, immortal: 1 }), me0);
    await sleep(1200);
    const seen = await obs.evaluate(() => { const S = window.__kv.S, t = performance.now();
      return [...S.vehicles.values()].filter(v => v.kind === 5 && v.driver && t - (v.drawnAt || 0) < 500).length; });
    check(seen >= 1, 'второй игрок видит мотоцикл с водителем');
    await obs.screenshot({ path: OUT + '/moto_obs.png' });

    // газ до упора: быстрее машины (21 м/с); держим, пока не врежемся - на полном ходу водитель вылетает
    await pc.keyboard.down('KeyW');
    let vmax = 0, thrown = false, t0 = Date.now(), shot = false;
    while (Date.now() - t0 < 9000) {
      await sleep(100);
      const s = await kv(() => { const S = window.__kv.S; return { v: S.car ? S.car.v : -1, veh: S.me.vehicle, roll: S.me.rollUntil > performance.now() }; });
      if (s.v > vmax) vmax = s.v;
      if (!shot && s.v > 15) { shot = true; await pc.screenshot({ path: OUT + '/moto_ride.png' }); }
      if (!s.veh) { thrown = s.roll; break; }
    }
    await pc.keyboard.up('KeyW');
    const toast = await kv(() => document.getElementById('toast') ? document.getElementById('toast').textContent : '');
    console.log(`разгон: до ${vmax.toFixed(1)} м/с; ${thrown ? 'врезался и вылетел' : 'не вылетел'}; надпись: «${toast}»`);
    check(vmax > 22, 'мотоцикл быстрее машины (больше 22 м/с)');
    check(thrown, 'на полном ходу врезался - вылетел через руль и кувыркается');
    await sleep(500);
    await pc.screenshot({ path: OUT + '/moto_fall.png' });
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
