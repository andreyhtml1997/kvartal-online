/* Круги и вид в браузере (нужен сервер с KV_DEBUG=1): в оружейном вверху панель с ценами - клик и цифра покупают,
   сошёл с круга - панель закрылась; больница лечит сразу по +10; V - вид дальше/ближе, приближение плавное (масштаб меняется
   понемногу, без скачков); на карте подпись «ты»; на телефоне панель не залезает на радар и здоровье; ошибок нет. */
const { chromium } = require(process.env.PW_PATH || 'playwright');
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const OUT = process.argv[3] || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: process.env.CH || 'chrome' });
  const errors = [];
  let ok = true;
  const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) ok = false; };
  const join = async (page, name) => {
    await page.goto(BASE + '/?room=shop' + Date.now().toString(36).slice(-4));
    await page.fill('#nameInput', name);
    await page.click('#btnJoin');
    await page.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
  };
  try {
    const pc = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    pc.on('pageerror', e => errors.push(e.message));
    await join(pc, 'Покупатель');
    const kv = (f, arg) => pc.evaluate(f, arg);
    const gun = await kv(() => window.__kv.S.shops.find(s => s[0] === 'gun'));
    await kv(([x, y]) => window.__kv.send({ t: 'dbg', tpTo: [x, y], money: 600, god: 1, immortal: 1 }), [gun[1], gun[2]]);
    await pc.waitForFunction(() => !document.getElementById('shopPanel').hidden, null, { timeout: 5000 }).catch(() => {});
    const items = await kv(() => [...document.querySelectorAll('#shopGrid .sp-item')].map(b => b.textContent.trim()));
    check(items.length === 13 && /\$1000/.test(items[items.length - 1]), `в оружейном панель: ${items.length} видов, последний - ${items[items.length - 1]}`);
    await pc.screenshot({ path: OUT + '/shop_panel.png' });
    // клик по дробовику
    const before = await kv(() => ({ money: window.__kv.S.money, sg: window.__kv.S.me.ammo[3] }));
    await pc.click('#shopGrid .sp-item:nth-child(3)');
    await sleep(700);
    const after = await kv(() => ({ money: window.__kv.S.money, sg: window.__kv.S.me.ammo[3], toast: document.getElementById('toast').textContent }));
    check(after.money === before.money - 150 && after.sg > 0, `клик - дробовик куплен за $150 (было $${before.money}, стало $${after.money}; «${after.toast}»)`);
    // цифра 1 - пистолет
    await pc.keyboard.press('Digit1');
    await sleep(700);
    const m2 = await kv(() => window.__kv.S.money);
    check(m2 === after.money - 50, `цифра 1 - пистолет за $50 (осталось $${m2})`);
    // сошёл с круга - панель закрылась
    await kv(([x, y]) => window.__kv.send({ t: 'dbg', tpTo: [x + 9, y + 9] }), [gun[1], gun[2]]);
    await sleep(800);
    check(await kv(() => document.getElementById('shopPanel').hidden), 'сошёл с круга - панель закрылась');

    // больница: встал с 30 здоровья - быстро до 100
    const med = await kv(() => window.__kv.S.shops.find(s => s[0] === 'med'));
    await kv(([x, y]) => window.__kv.send({ t: 'dbg', tpTo: [x, y], hp: 30, money: 300 }), [med[1], med[2]]);
    const hpSeen = [];
    for (let i = 0; i < 12; i++) { await sleep(150); hpSeen.push(await kv(() => Math.round(window.__kv.S.me.hp))); }
    const moneyAfter = await kv(() => window.__kv.S.money);
    console.log(`больница: здоровье по шагам ${hpSeen.join(' ')}; денег $${moneyAfter}`);
    check(hpSeen[hpSeen.length - 1] === 100 && hpSeen.indexOf(100) <= 7 && moneyAfter === 300 - 35, 'больница лечит сразу и быстро, $5 за +10');

    // V - вид и снайперка: масштаб пишем каждый кадр - наибольший скачок за кадр должен быть маленьким
    const frames = async act => {
      await kv(() => { window.__tpLog = []; const f = () => { window.__tpLog.push(window.__kv.S.view.tp); if (window.__tpLog.length < 150) requestAnimationFrame(f); }; requestAnimationFrame(f); });
      await act();
      await sleep(2600);
      const log = await kv(() => window.__tpLog);
      const jumps = log.slice(1).map((t, i) => Math.abs(t - log[i]) / log[i]);
      return { from: log[0], to: log[log.length - 1], max: Math.max(...jumps), n: log.length };
    };
    const z1 = await frames(() => pc.keyboard.press('KeyV'));
    console.log(`V: масштаб ${z1.from.toFixed(1)} -> ${z1.to.toFixed(1)} за ${z1.n} кадров, наибольший шаг за кадр ${(z1.max * 100).toFixed(1)}%`);
    check(z1.to < z1.from * 0.85 && z1.max < 0.035, 'V отдаляет вид плавно, без скачков');
    await pc.keyboard.press('KeyV'); await pc.keyboard.press('KeyV');
    await kv(() => window.__kv.send({ t: 'dbg', give: 1 }));
    await sleep(2500);
    const z2 = await frames(() => kv(() => window.__kv.selectWeapon(4)));
    console.log(`снайперка: масштаб ${z2.from.toFixed(1)} -> ${z2.to.toFixed(1)} за ${z2.n} кадров, наибольший шаг за кадр ${(z2.max * 100).toFixed(1)}%`);
    check(z2.to < z2.from * 0.85 && z2.max < 0.035, 'со снайперкой вид отъезжает плавно');

    // карта: подпись «ты»
    await pc.keyboard.press('KeyM');
    await sleep(500);
    await pc.screenshot({ path: OUT + '/shop_bigmap.png' });
    await pc.keyboard.press('KeyM');

    // телефон: панель не залезает на радар и здоровье
    const ph = await (await browser.newContext({ viewport: { width: 667, height: 375 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
    ph.on('pageerror', e => errors.push('phone: ' + e.message));
    await join(ph, 'Телефон');
    const g2 = await ph.evaluate(() => window.__kv.S.shops.find(s => s[0] === 'gun'));
    await ph.evaluate(([x, y]) => window.__kv.send({ t: 'dbg', tpTo: [x, y], money: 2000 }), [g2[1], g2[2]]);
    await ph.waitForFunction(() => !document.getElementById('shopPanel').hidden, null, { timeout: 5000 }).catch(() => {});
    await sleep(300);
    const lay = await ph.evaluate(() => {
      const R = el => el.getBoundingClientRect();
      const p = R(document.getElementById('shopPanel')), m = R(document.getElementById('minimap')), t = R(document.querySelector('.hud-tr'));
      const ov = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return { open: !document.getElementById('shopPanel').hidden, radar: ov(p, m), vitals: ov(p, t), h: Math.round(p.height), w: Math.round(p.width) };
    });
    await ph.screenshot({ path: OUT + '/shop_phone.png' });
    check(lay.open && !lay.radar && !lay.vitals, `на телефоне панель открыта (${lay.w}x${lay.h}), не залезает на радар и здоровье`);
    await ph.tap('#shopGrid .sp-item:last-child');
    await sleep(700);
    const mg = await ph.evaluate(() => ({ ammo: window.__kv.S.me.ammo[8], money: window.__kv.S.money }));
    check(mg.ammo >= 1000 && mg.money === 1000, `касание - миниган за $1000 (патронов ${mg.ammo})`);
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
