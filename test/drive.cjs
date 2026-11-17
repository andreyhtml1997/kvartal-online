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
    const kv = (f, arg) => pc.evaluate(f, arg);

    // ботов по умолчанию нет (если включены - угоняют и взрывают машины): на время проверок машин - выключены
    await kv(() => window.__kv.send({ t: 'bots', on: false }));
    // рывок: с Shift бежит быстрее, выносливость тратится
    await kv(() => window.__kv.send({ t: 'dbg', god: 1 }));
    const s0 = await kv(() => ({ x: window.__kv.S.me.x, y: window.__kv.S.me.y, st: window.__kv.S.me.stamina }));
    // рывок туда, где свободно
    const freeDir = await kv(() => {
      const S = window.__kv.S, KV = window.KV; let best = 'KeyD', bl = -1;
      for (const [key, dx, dy] of [['KeyD', 1, 0], ['KeyA', -1, 0], ['KeyS', 0, 1], ['KeyW', 0, -1]]) {
        const r = KV.moveCircle(S.map, S.me.x, S.me.y, dx * 8, dy * 8, KV.PLAYER_R); const l = Math.hypot(r[0] - S.me.x, r[1] - S.me.y);
        if (l > bl) { bl = l; best = key; } } return best; });
    await pc.keyboard.down('ShiftLeft'); await pc.keyboard.down(freeDir);
    await sleep(700);
    const s1 = await kv(() => ({ x: window.__kv.S.me.x, y: window.__kv.S.me.y, st: window.__kv.S.me.stamina, sp: window.__kv.S.me.sprinting }));
    await pc.keyboard.up(freeDir); await pc.keyboard.up('ShiftLeft');
    const sprintSpeed = Math.hypot(s1.x - s0.x, s1.y - s0.y) / 0.7;
    console.log(`рывок: ${sprintSpeed.toFixed(1)} м/с`);
    check(s1.st < s0.st - 5, `рывок тратит выносливость (${Math.round(s0.st)} -> ${Math.round(s1.st)})`);

    // к машине, сесть по F, газ, выйти
    await kv(() => window.__kv.send({ t: 'dbg', nearCar: 1, give: 1 }));
    await sleep(900);
    // один клик мышью - ровно один выстрел (раньше короткое нажатие иногда давало два)
    await kv(() => window.__kv.selectWeapon(1));
    await pc.mouse.move(900, 260);
    await sleep(500);
    const am0 = await kv(() => window.__kv.S.me.ammo[1]);
    for (let i = 0; i < 2; i++) { await pc.mouse.down(); await sleep(150); await pc.mouse.up(); await sleep(700); }
    await sleep(300);
    const am1 = await kv(() => window.__kv.S.me.ammo[1]);
    check(am0 - am1 === 2, `два клика по 150 мс - два выстрела (потрачено патронов: ${am0 - am1})`);
    await kv(() => window.__kv.send({ t: 'dbg', god: 1 }));
    const near = await kv(() => !!window.__kv.nearCar());
    check(near, 'рядом с машиной появилась возможность сесть');
    check(await pc.isVisible('#btnCar'), 'кнопка с машиной видна');
    await pc.keyboard.press('KeyF');
    await pc.waitForFunction(() => window.__kv.S.me.vehicle > 0, null, { timeout: 5000 }).catch(() => {});
    const inCar = await kv(() => window.__kv.S.me.vehicle);
    check(inCar > 0, 'сел в машину по F');
    // толкание: стоящая машина прямо перед нашей, газ в упор - она должна поехать вперёд
    await kv(() => window.__kv.send({ t: 'dbg', carAhead: 1 }));
    await sleep(800);
    const ahead = await kv(() => {
      const S = window.__kv.S, my = S.car;
      let best = null, bd = 1e9;
      for (const v of S.vehicles.values()) {
        if (v.id === S.me.vehicle) continue;
        const d = Math.hypot(v.rx - my.x - Math.cos(my.a) * 4.6, v.ry - my.y - Math.sin(my.a) * 4.6);
        if (d < bd) { bd = d; best = { id: v.id, x: v.rx, y: v.ry, d }; }
      }
      return best;
    });
    if (ahead && ahead.d < 1) {
      await pc.keyboard.down('KeyW'); await sleep(1600);
      await pc.screenshot({ path: OUT + '/push.png' });
      await pc.keyboard.up('KeyW'); await sleep(500);
      const after = await kv(id => { const v = window.__kv.S.vehicles.get(id); return v ? { x: v.rx, y: v.ry } : null; }, ahead.id);
      const pushed = after ? Math.hypot(after.x - ahead.x, after.y - ahead.y) : 0;
      console.log(`толкание: стоящую машину сдвинули на ${pushed.toFixed(1)} м`);
      check(pushed > 1.5, 'машина с газом толкает стоящую машину');
    } else console.log('перед машиной нет места для второй машины - толкание не проверено');
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
    // снова газ и выход прямо на ходу
    await pc.keyboard.down('KeyW'); await sleep(1500);
    const vBefore = await kv(() => Math.abs(window.__kv.S.car ? window.__kv.S.car.v : 0));
    const carId = await kv(() => window.__kv.S.me.vehicle);
    await pc.keyboard.press('KeyF');
    await pc.waitForFunction(() => window.__kv.S.me.vehicle === 0, null, { timeout: 5000 }).catch(() => {});
    await pc.keyboard.up('KeyW');
    check(await kv(() => window.__kv.S.me.vehicle === 0), `вышел из машины на ходу (скорость была ${vBefore.toFixed(1)} м/с)`);
    await sleep(250);
    const rolling = await kv(id => { const v = window.__kv.S.vehicles.get(id); return v ? Math.abs(v.v) : -1; }, carId);
    console.log(`брошенная машина после выхода: ${rolling < 0 ? 'не видно' : rolling.toFixed(1) + ' м/с'}`);

    // радар и карта города
    await pc.click('#minimap');
    await sleep(300);
    check(await pc.isVisible('#bigmap'), 'нажатие на радар открывает карту города');
    await pc.screenshot({ path: OUT + '/bigmap.png' });
    await pc.click('#bigmap');
    await sleep(200);
    check(!(await pc.isVisible('#bigmap')), 'карта закрывается нажатием');

    // крыш нет: здания всегда открыты (на экране нет полупрозрачных крыш, игроки в домах видны)
    check(await kv(() => typeof window.__kv.S.map.buildings[0] === 'object'), 'в городе есть дома');

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
    // настоящие игроки видят друг друга на карте, где бы ни были
    await sleep(1200);
    const phoneId = await ph.evaluate(() => window.__kv.S.myId);
    const seen = await kv(id => window.__kv.S.humans.some(h => h[0] === id), phoneId);
    check(seen, 'компьютер видит игрока с телефона на карте');
    // режим без ботов: включаем обратно, потом выключаем под шестерёнкой - боты исчезают, включаем - возвращаются
    await kv(() => window.__kv.send({ t: 'bots', on: true }));
    await sleep(1300);
    await pc.click('#btnMenu');
    await pc.click('#btnBots');
    await sleep(1200);
    const noBots = await kv(() => [...window.__kv.S.players.values()].filter(p => p.bot).length);
    check(noBots === 0, `переключатель «Боты: выключены» убирает ботов (осталось ${noBots})`);
    check((await pc.textContent('#btnBots')).includes('выключены'), 'кнопка показывает, что боты выключены');
    await pc.click('#btnBots');
    await sleep(1200);
    const backBots = await kv(() => [...window.__kv.S.players.values()].filter(p => p.bot).length);
    check(backBots >= 1, `боты возвращаются (${backBots})`);
    await pc.keyboard.press('Escape');
    // прицел под пальцем: касание правее и выше персонажа - перекрестие ровно под пальцем
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(200);
    const pt = await ph.evaluate(() => ({ x: innerWidth * 0.62, y: innerHeight * 0.22 }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 7 }] });
    await sleep(250);
    const under = await ph.evaluate(p => { const S = window.__kv.S, v = S.view, dpr = document.getElementById('game').width / innerWidth;
      if (!window.__kv.input.aim && !window.__kv.input.fire) return null; return { mode: window.__kv.input.aim && window.__kv.input.aim.mode, fire: window.__kv.input.fire }; }, pt);
    await ph.screenshot({ path: OUT + '/aim_point.png' });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(!under, 'касание вне кнопки атаки не стреляет и не целится');
    // большой стик справа внизу: отвёл палец влево - перекрестие слева от персонажа
    const base = await ph.evaluate(() => [Math.max(innerWidth * 0.72, innerWidth - 200), innerHeight - Math.min(115, innerHeight * 0.3)]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: base[0], y: base[1], id: 8 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: base[0] - 70, y: base[1], id: 8 }] });
    await sleep(250);
    const st = await ph.evaluate(() => { const S = window.__kv.S; return S.aimPt ? { mode: window.__kv.input.aim.mode, dx: S.aimPt[0] - S.me.x, dy: S.aimPt[1] - S.me.y, snap: S.aimSnap } : null; });
    await ph.screenshot({ path: OUT + '/aim_stick.png' });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(st && st.mode === 'stick' && (st.snap || (st.dx < -2 && Math.abs(st.dy) < 1)), `кнопка атаки: потянул влево - прицел слева (${st ? st.dx.toFixed(1) : '-'} м)`);
    check(await ph.isVisible('#miniBoard'), 'справа вверху видна таблица счёта всех игроков');
    const rowsMini = await ph.$$eval('#miniBoard li', l => l.length);
    check(rowsMini >= 3, `в таблице счёта строк: ${rowsMini}`);
    const miniNames = await ph.$$eval('#miniBoard li .nm', l => l.map(e => e.textContent));
    check(miniNames.includes('Водитель') && miniNames.includes('Богдан'), `оба живых игрока всегда в таблице справа (${miniNames.join(', ')})`);
    // снова держим джойстик для следующих проверок
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 140, y: 290, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 170, y: 290, id: 1 }] });
    await sleep(200);
    // правая половина: держим палец - стрельба идёт без остановки
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 170, y: 290, id: 1 }, { x: 650, y: 300, id: 2 }] });
    await sleep(900);
    const fire = await ph.evaluate(() => window.__kv.input.fire);
    check(fire, 'палец на правой половине держит атаку');
    await ph.screenshot({ path: OUT + '/phone2.png' });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
    check(await ph.isVisible('#btnWeapon'), 'на телефоне справа есть кнопка смены оружия');
    await ph.evaluate(() => window.__kv.send({ t: 'dbg', give: 1, nearCar: 1, god: 1 }));
    await sleep(900);
    const w0 = await ph.evaluate(() => window.__kv.S.me.cur);
    await ph.tap('#btnWeapon');
    await sleep(300);
    const w1 = await ph.evaluate(() => window.__kv.S.me.cur);
    check(w1 !== w0, `кнопка справа меняет оружие (${w0} -> ${w1})`);
    // короткое касание правой половины экрана - ровно один выстрел
    await ph.evaluate(() => window.__kv.selectWeapon(1));
    await sleep(500);
    const pa0 = await ph.evaluate(() => window.__kv.S.me.ammo[1]);
    // кнопка атаки справа внизу (как в Mobile Legends)
    const tapPt = await ph.evaluate(() => ({ x: Math.max(innerWidth * 0.72, innerWidth - 200), y: innerHeight - Math.min(115, innerHeight * 0.3) }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tapPt.x, y: tapPt.y, id: 9 }] });
    await sleep(140);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(1000);
    const pa1 = await ph.evaluate(() => window.__kv.S.me.ammo[1]);
    check(pa0 - pa1 === 1, `короткое касание - один выстрел (потрачено патронов: ${pa0 - pa1})`);
    // с пистолетом стик сопоставлен с экраном: палец у края круга влево - прицел у левого края экрана
    const bb = await ph.evaluate(() => [Math.max(innerWidth * 0.72, innerWidth - 200), innerHeight - Math.min(115, innerHeight * 0.3)]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bb[0], y: bb[1], id: 11 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bb[0] - 75, y: bb[1], id: 11 }] });
    await sleep(250);
    const far = await ph.evaluate(() => { const S = window.__kv.S, v = S.view, dpr = document.getElementById('game').width / innerWidth;
      return S.aimPt ? { sx: (S.aimPt[0] * v.tp + v.ox) / dpr, w: innerWidth, snap: S.aimSnap } : null; });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(far && (far.snap || far.sx < far.w * 0.2), `стик сопоставлен с экраном: прицел у левого края (x=${far ? Math.round(far.sx) : '-'} из ${far ? far.w : '-'})`);
    await ph.screenshot({ path: OUT + '/aim_far.png' });
    await ph.evaluate(() => window.__kv.send({ t: 'dbg', god: 1 }));
    // держим левый джойстик и касаемся оружия в полоске сверху - оружие меняется на ходу
    const slots = await ph.$$eval('#weaponBar .slot', els => els.map((e, i) => { const r = e.getBoundingClientRect(); return { i, hidden: e.hidden, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }).filter(s => !s.hidden));
    const curNow = await ph.evaluate(() => window.__kv.S.me.cur);
    const target = slots.find(s => s.i !== curNow);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 140, y: 290, id: 5 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 175, y: 290, id: 5 }] });
    await sleep(250);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 175, y: 290, id: 5 }, { x: target.x, y: target.y, id: 6 }] });
    // отпускаем только палец с кнопки оружия, палец на джойстике остаётся
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 176, y: 290, id: 5 }] });
    await sleep(300);
    const curAfter = await ph.evaluate(() => window.__kv.S.me.cur);
    const stillMoving = await ph.evaluate(() => !!window.__kv.input.move);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(curAfter === target.i && stillMoving, `на ходу (палец на джойстике) касание оружия сверху меняет его (${curNow} -> ${curAfter})`);
    await kv(() => window.__kv.send({ t: 'bots', on: false })); // дальше снова машины - без ботов
    await ph.evaluate(() => window.__kv.send({ t: 'dbg', nearCar: 1 }));
    await sleep(900);
    const boxW = await ph.locator('#btnWeapon').boundingBox();
    check(await ph.isVisible('#btnCar'), 'рядом с машиной справа появилась кнопка «Сесть»');
    const boxCar = await ph.locator('#btnCar').boundingBox();
    check(boxCar && boxW && boxCar.y > boxW.y, '«Сесть» под кнопкой оружия');
    await ph.tap('#btnCar');
    await ph.waitForFunction(() => window.__kv.S.me.vehicle > 0, null, { timeout: 5000 }).catch(() => {});
    await sleep(400);
    const hornVis = await ph.isVisible('#btnHorn'), leaveVis = await ph.isVisible('#btnLeave');
    check(hornVis && leaveVis, 'в машине справа кнопки «Гудок» и «Выйти»');
    const bh = await ph.locator('#btnHorn').boundingBox(), bl = await ph.locator('#btnLeave').boundingBox();
    check(bh && bl && bl.y > bh.y, '«Выйти» снизу, «Гудок» над ней');
    // газ левым джойстиком и выход на полном ходу
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 140, y: 290, id: 3 }] });
    const ca = await ph.evaluate(() => window.__kv.S.car.a);
    const tx = 140 + Math.cos(ca) * 50, ty = 290 + Math.sin(ca) * 50;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tx, y: ty, id: 3 }] });
    await sleep(1400);
    await ph.screenshot({ path: OUT + '/phone_car.png' });
    const pv = await ph.evaluate(() => Math.abs(window.__kv.S.car.v));
    await ph.tap('#btnLeave');
    await ph.waitForFunction(() => window.__kv.S.me.vehicle === 0, null, { timeout: 5000 }).catch(() => {});
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(await ph.evaluate(() => window.__kv.S.me.vehicle === 0), `на телефоне вышел на ходу (скорость ${pv.toFixed(1)} м/с)`);
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
