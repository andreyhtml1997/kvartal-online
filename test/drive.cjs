/* Проверка машин и рывка в браузере (нужен сервер с KV_DEBUG=1). Запуск: node test/drive.cjs <адрес> <папка> */
const { chromium } = require(process.env.PW_PATH || 'playwright');
const BASE = (process.argv[2] || 'http://localhost:8093').replace(/\/$/, '');
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
    await pc.goto(BASE + '/?room=drive' + Date.now().toString(36).slice(-4));
    await pc.fill('#nameInput', 'Водитель');
    await pc.click('#btnJoin');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    await sleep(800);
    const kv = f => pc.evaluate(f);

    // рывок: с Shift бежит быстрее, выносливость тратится
    await kv(() => window.__kv.send({ t: 'dbg', god: 1 }));
    const s0 = await kv(() => ({ x: window.__kv.S.me.x, y: window.__kv.S.me.y, st: window.__kv.S.me.stamina }));
    await pc.keyboard.down('ShiftLeft'); await pc.keyboard.down('KeyD');
    await sleep(700);
    const s1 = await kv(() => ({ x: window.__kv.S.me.x, y: window.__kv.S.me.y, st: window.__kv.S.me.stamina, sp: window.__kv.S.me.sprinting }));
    await pc.keyboard.up('KeyD'); await pc.keyboard.up('ShiftLeft');
    check(s1.st < s0.st - 5, `рывок тратит выносливость (${Math.round(s0.st)} -> ${Math.round(s1.st)})`);

    // к машине, сесть по F, газ, выйти
    await kv(() => window.__kv.send({ t: 'dbg', nearCar: 1, give: 1 }));
    await sleep(900);
    const near = await kv(() => !!window.__kv.nearCar());
    check(near, 'рядом с машиной появилась возможность сесть');
    check(await pc.isVisible('#btnCar'), 'кнопка с машиной видна');
    await pc.keyboard.press('KeyF');
    await pc.waitForFunction(() => window.__kv.S.me.vehicle > 0, null, { timeout: 5000 }).catch(() => {});
    const inCar = await kv(() => window.__kv.S.me.vehicle);
    check(inCar > 0, 'сел в машину по F');
    const c0 = await kv(() => ({ x: window.__kv.S.car.x, y: window.__kv.S.car.y, tp: window.__kv.S.car.tp }));
    await pc.keyboard.down('KeyW'); await sleep(1200);
    await pc.screenshot({ path: OUT + '/driving.png' });
    await pc.keyboard.down('KeyD'); await sleep(500); await pc.keyboard.up('KeyD');
    await pc.keyboard.up('KeyW');
    await sleep(600);
    const c1 = await kv(() => ({ x: window.__kv.S.car.x, y: window.__kv.S.car.y, tp: window.__kv.S.car.tp, srv: window.__kv.S.srv }));
    const moved = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    console.log(`машина проехала ${moved.toFixed(1)} м; сервер видит [${c1.srv}]`);
    check(moved > 3 || c1.tp === c0.tp, 'машина едет');
    check(Math.hypot(c1.srv[0] - c1.x, c1.srv[1] - c1.y) < 1.5, 'сервер принимает положение машины');
    await pc.keyboard.press('KeyF');
    await pc.waitForFunction(() => window.__kv.S.me.vehicle === 0, null, { timeout: 5000 }).catch(() => {});
    check(await kv(() => window.__kv.S.me.vehicle === 0), 'вышел из машины по F');

    // радар и карта города
    await pc.click('#minimap');
    await sleep(300);
    check(await pc.isVisible('#bigmap'), 'нажатие на радар открывает карту города');
    await pc.screenshot({ path: OUT + '/bigmap.png' });
    await pc.click('#bigmap');
    await sleep(200);
    check(!(await pc.isVisible('#bigmap')), 'карта закрывается нажатием');

    // телефон: кнопка рывка при движении
    const ph = await (await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })).newPage();
    ph.on('pageerror', e => errors.push('phone: ' + e.message));
    await ph.goto(BASE + '/?room=' + (await kv(() => window.__kv.S.room)));
    await ph.fill('#nameInput', 'Богдан');
    await ph.click('#btnJoin');
    await ph.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    await sleep(600);
    const cdp = await ph.context().newCDPSession(ph);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 140, y: 290, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 170, y: 290, id: 1 }] });
    await sleep(400);
    check(await ph.isVisible('#btnSprint'), 'на телефоне при движении видна кнопка рывка');
    // правая половина: держим палец - стрельба идёт без остановки
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 170, y: 290, id: 1 }, { x: 650, y: 300, id: 2 }] });
    await sleep(900);
    const fire = await ph.evaluate(() => window.__kv.input.fire);
    check(fire, 'палец на правой половине держит атаку');
    await ph.screenshot({ path: OUT + '/phone2.png' });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await pc.screenshot({ path: OUT + '/pc2.png' });
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
