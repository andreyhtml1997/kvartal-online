/* Режим «Банда» в браузере (нужен сервер с KV_DEBUG=1): в меню выбирается «Банда», ссылка несёт режим, второй входит
   по ней в ту же банду, пули своего не ранят, розыск общий - звёзды у обоих, ошибок нет. */
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
    const a = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    a.on('pageerror', e => errors.push('A: ' + e.message));
    await a.goto(BASE + '/');
    await a.evaluate(() => { try { localStorage.removeItem('kv_mode'); } catch (_) {} });
    await a.reload();
    await a.fill('#nameInput', 'Атаман');
    await a.click('#modeGang');
    const note = await a.textContent('#modeNote');
    check(/одна банда|one gang/.test(note) && (await a.getAttribute('#modeGang', 'aria-checked')) === 'true', 'в меню выбрана «Банда», под кнопками подсказка');
    await a.click('#btnCreate');
    await a.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    const st = await a.evaluate(() => ({ gang: window.__kv.S.gang, url: location.search, board: document.getElementById('boardRoom').textContent }));
    check(st.gang && /mode=gang/.test(st.url) && /Банда|Gang/.test(st.board), `комната в режиме «Банда», режим в адресе (${st.url})`);

    // по ссылке «Создать свою комнату» ведёт к выбору режима, а не сразу в игру
    const c = await (await browser.newContext()).newPage();
    await c.goto(BASE + '/' + st.url);
    await c.click('#btnNewRoom');
    const cv = await c.evaluate(() => ({ create: !document.getElementById('createBlock').hidden, invite: !document.getElementById('inviteBlock').hidden }));
    check(cv.create && !cv.invite, '«Создать свою комнату» из приглашения открывает выбор режима');
    await c.close();

    // второй - по ссылке
    const b = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
    b.on('pageerror', e => errors.push('B: ' + e.message));
    await b.goto(BASE + '/' + st.url);
    const invite = await b.textContent('#inviteBlock');
    check(/Банда|Gang/.test(invite), 'в приглашении написан режим «Банда»');
    await b.fill('#nameInput', 'Братан');
    await b.click('#btnJoin');
    await b.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    check(await b.evaluate(() => window.__kv.S.gang), 'второй вошёл в ту же банду');

    // второй встаёт в 3 м от первого (без бессмертия), первый стреляет в него из пистолета
    await a.evaluate(() => window.__kv.send({ t: 'dbg', give: 1, god: 1, immortal: 1 }));
    const aPos = await a.evaluate(() => [window.__kv.S.me.x, window.__kv.S.me.y]);
    await b.evaluate(([x, y]) => window.__kv.send({ t: 'dbg', tpTo: [x + 3, y] }), aPos);
    await sleep(3500); // защита после появления спадает
    await a.evaluate(() => window.__kv.selectWeapon(1));
    await sleep(300);
    const bPos = await b.evaluate(() => [window.__kv.S.me.x, window.__kv.S.me.y]);
    const scr = await a.evaluate(([px, py]) => { const v = window.__kv.S.view, dpr = document.getElementById('game').width / innerWidth;
      return { x: (px * v.tp + v.ox) / dpr, y: (py * v.tp + v.oy) / dpr }; }, bPos);
    const ammo0 = await a.evaluate(() => window.__kv.S.me.ammo[1]);
    await a.mouse.move(scr.x, scr.y);
    await a.mouse.down(); await sleep(1600); await a.mouse.up();
    await sleep(500);
    const ammo1 = await a.evaluate(() => window.__kv.S.me.ammo[1]);
    const bhp = await b.evaluate(() => window.__kv.S.me.hp);
    console.log(`первый выстрелил ${ammo0 - ammo1} раз в своего с ${Math.hypot(bPos[0] - aPos[0], bPos[1] - aPos[1]).toFixed(1)} м; здоровье второго ${bhp}`);
    check(ammo0 - ammo1 >= 3 && bhp === 100, 'пули своего не ранят');
    await a.screenshot({ path: OUT + '/gang_a.png' });

    // розыск общий: натворил первый - звёзды и у второго
    await a.evaluate(() => window.__kv.send({ t: 'dbg', wanted: 210 }));
    await sleep(1500);
    const sa = await a.evaluate(() => window.__kv.S.stars), sb = await b.evaluate(() => window.__kv.S.stars);
    const toastB = await b.textContent('#toast');
    console.log(`звёзды: у первого ${sa}, у второго ${sb}; надпись у второго «${toastB}»`);
    check(sa >= 3 && sb === sa && /банд|gang/i.test(toastB), 'розыск общий - звёзды у обоих');
  } catch (e) {
    ok = false;
    console.log('FAIL исключение:', e.message);
  } finally {
    check(errors.length === 0, 'ошибок на страницах нет' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
    await browser.close();
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    process.exitCode = ok ? 0 : 1;
  }
})();
