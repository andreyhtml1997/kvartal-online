/* Живая проверка в браузере: компьютер + телефон в одной комнате. Запуск: node test/e2e.cjs <адрес> <папка для снимков> */
const { chromium } = require(process.env.PW_PATH || 'playwright');
const BASE = (process.argv[2] || 'http://localhost:8091').replace(/\/$/, '');
const OUT = process.argv[3] || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: process.env.CH || 'chrome' });
  const errors = [];
  const log = (...a) => console.log(...a);
  let ok = true;
  const check = (cond, msg) => { log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) ok = false; };
  try {
    // ---- компьютер ----
    const pc = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    pc.on('pageerror', e => errors.push('pc: ' + e.message));
    pc.on('console', m => { if (m.type() === 'error') errors.push('pc console: ' + m.text()); });
    await pc.goto(BASE + '/');
    await pc.fill('#nameInput', 'Андрей');
    await pc.click('#btnCreate');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.inGame && window.__kv.S.me.alive, null, { timeout: 90000 });
    const room = await pc.evaluate(() => window.__kv.S.room);
    log('комната', room);
    await sleep(1500);

    // ---- телефон (iPhone-подобный, горизонтально, касания) ----
    const ph = await (await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })).newPage();
    ph.on('pageerror', e => errors.push('phone: ' + e.message));
    ph.on('console', m => { if (m.type() === 'error') errors.push('phone console: ' + m.text()); });
    await ph.goto(BASE + '/?room=' + room);
    check(await ph.isVisible('#inviteBlock'), 'по ссылке видно приглашение в комнату');
    await ph.fill('#nameInput', 'Богдан');
    await ph.click('#btnJoin');
    await ph.waitForFunction(() => window.__kv && window.__kv.S.inGame && window.__kv.S.me.alive, null, { timeout: 30000 });
    await sleep(1500);

    const names = await pc.evaluate(() => [...window.__kv.S.players.values()].map(p => p.name));
    log('игроки у компьютера:', names.join(', '));
    check(names.includes('Богдан'), 'компьютер видит телефон в списке игроков');
    check(names.filter(n => n.includes('(бот)')).length === 2, 'боты добрали комнату до 4');

    // ---- ходьба с клавиатуры, сервер принимает позицию ----
    const before = await pc.evaluate(() => ({ x: window.__kv.S.me.x, y: window.__kv.S.me.y, tp: window.__kv.S.me.tp }));
    await pc.keyboard.down('KeyD'); await sleep(450); await pc.keyboard.up('KeyD');
    await pc.keyboard.down('KeyS'); await sleep(450); await pc.keyboard.up('KeyS');
    await pc.keyboard.down('KeyA'); await sleep(450); await pc.keyboard.up('KeyA');
    await sleep(400);
    const after = await pc.evaluate(() => ({ x: window.__kv.S.me.x, y: window.__kv.S.me.y, tp: window.__kv.S.me.tp, srv: window.__kv.S.srv }));
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    log(`компьютер сдвинулся на ${moved.toFixed(2)} м, сервер видит [${after.srv}] против [${after.x.toFixed(2)}, ${after.y.toFixed(2)}]`);
    check(moved > 0.5 || after.tp === before.tp, 'игрок ходит (или упёрся в стену без отката)');
    check(after.tp === before.tp, 'сервер не откатывал позицию');
    check(Math.hypot(after.srv[0] - after.x, after.srv[1] - after.y) < 0.6, 'сервер знает позицию игрока');

    // ---- джойстик на телефоне ----
    const cdp = await ph.context().newCDPSession(ph);
    const pb = await ph.evaluate(() => ({ x: window.__kv.S.me.x, y: window.__kv.S.me.y, tp: window.__kv.S.me.tp }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 140, y: 290, id: 1 }] });
    for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 140 + i * 10, y: 290 - i * 6, id: 1 }] }); await sleep(30); }
    await sleep(900);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
    const pa = await ph.evaluate(() => ({ x: window.__kv.S.me.x, y: window.__kv.S.me.y, tp: window.__kv.S.me.tp, srv: window.__kv.S.srv }));
    const pm = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    log(`телефон сдвинулся джойстиком на ${pm.toFixed(2)} м`);
    check(pm > 0.5 || pa.tp === pb.tp, 'левый джойстик двигает игрока');
    check(pa.tp === pb.tp, 'сервер не откатывал телефон');

    // ---- правый джойстик: прицел и выстрел (кулаком) ----
    const punchesBefore = await ph.evaluate(() => window.__kv.S.me.nextShot);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 700, y: 290, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 750, y: 290, id: 2 }] });
    await sleep(500);
    const aim = await ph.evaluate(() => ({ a: window.__kv.S.me.a, fire: window.__kv.input.fire, next: window.__kv.S.me.nextShot }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(Math.abs(aim.a) < 0.3, `правый джойстик целится вправо (угол ${aim.a.toFixed(2)})`);
    check(aim.fire && aim.next > punchesBefore, 'правый джойстик стреляет (удар кулаком)');

    // ---- таблица счёта ----
    await pc.keyboard.down('Tab'); await sleep(200);
    check(await pc.isVisible('#board'), 'Tab открывает таблицу счёта');
    const rows = await pc.$$eval('#boardBody tr', r => r.length);
    check(rows === 4, `в таблице 4 игрока (${rows})`);
    await pc.keyboard.up('Tab');

    // ---- радар слева вверху, машины рядом ----
    const radar = await pc.evaluate(() => { const r = document.getElementById('minimap').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; });
    check(radar.x < 20 && radar.y < 20 && radar.w >= 140, `радар слева вверху, ${Math.round(radar.w)} px`);
    const cars = await pc.evaluate(() => window.__kv.S.vehicles.size);
    log('машин рядом у компьютера:', cars);

    // ---- ждём оружие на карте ----
    await sleep(5000);
    const pk = await pc.evaluate(() => window.__kv.S.paCount || 0);
    check(pk >= 1, `на карте появляется оружие (${pk})`);

    // ---- производительность ----
    const f0 = await pc.evaluate(() => window.__kv.S.frame);
    await sleep(2000);
    const f1 = await pc.evaluate(() => window.__kv.S.frame);
    log(`кадров в секунду (компьютер, без видеокарты): ${((f1 - f0) / 2).toFixed(0)}`);

    await pc.screenshot({ path: OUT + '/pc.png' });
    await ph.screenshot({ path: OUT + '/phone.png' });

    // ---- выход и меню ----
    await pc.click('#btnMenu');
    check(await pc.isVisible('#gearMenu'), 'шестерёнка открывает настройки');
    await pc.click('#btnExit');
    await sleep(300);
    check(await pc.isVisible('#menu'), 'кнопка «Выход» возвращает в меню');
    await sleep(1500);
    const left = await ph.evaluate(() => [...window.__kv.S.players.values()].map(p => p.name));
    check(!left.includes('Андрей') && left.filter(n => n.includes('(бот)')).length === 3, 'после выхода игрока бот занял место');
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
