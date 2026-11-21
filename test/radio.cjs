/* Радио в машине (нужен сервер с KV_DEBUG=1 и интернет): сел - заиграла станция, E/Q - соседние, позиция
   «выключено» глушит поток, станция без ответа пропускается сама, вышел из машины - радио замолкло. */
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
    await pc.goto(BASE + '/?room=radio' + Date.now().toString(36).slice(-4));
    await pc.evaluate(() => { try { localStorage.removeItem('kv_radio'); } catch (_) {} });
    await pc.fill('#nameInput', 'Слушатель');
    await pc.click('#btnJoin');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    const kv = (f, arg) => pc.evaluate(f, arg);
    const R = () => kv(() => { const r = window.__kv.Radio, t = document.getElementById('radioTag'); return { active: r.active, state: r.state, station: r.station, tag: t.hidden ? '' : t.textContent }; });
    const waitOn = async ms => { const t0 = Date.now(); let r; do { await sleep(300); r = await R(); } while (r.state !== 'on' && Date.now() - t0 < ms); return r; };
    // первая станция не отвечает - радио должно само перейти на следующую
    const url0 = await kv(() => { const u = window.__kv.RADIO[0].url; window.__kv.RADIO[0].url = 'https://127.0.0.1:9/dead'; return u; });
    await kv(() => window.__kv.send({ t: 'dbg', nearCar: 1, god: 1, immortal: 1 }));
    await sleep(700);
    await pc.keyboard.press('KeyF');
    await pc.waitForFunction(() => window.__kv.S.me.vehicle, null, { timeout: 5000 }).catch(() => {});
    const r1 = await waitOn(20000);
    console.log(`сел в машину: радио ${r1.state}, станция «${r1.station}», надпись «${r1.tag}»`);
    check(r1.active && r1.state === 'on', 'в машине заиграло радио');
    check(r1.station !== '' && r1.station !== (await kv(() => window.__kv.RADIO[0].name)), 'молчащая станция пропущена сама');
    await pc.screenshot({ path: OUT + '/radio_on.png' });
    await kv(u => { window.__kv.RADIO[0].url = u; }, url0);
    // E - следующая станция
    await pc.keyboard.press('KeyE');
    const r2 = await waitOn(15000);
    console.log(`E: станция «${r2.station}» (${r2.state})`);
    check(r2.state === 'on' && r2.station !== r1.station, 'E включает следующую станцию');
    // Q листает назад; за последней станцией - «выключено»
    let off = null;
    for (let i = 0; i < 8 && !off; i++) { await pc.keyboard.press('KeyQ'); await sleep(250); const r = await R(); if (r.station === '') off = r; }
    console.log(`Q: «${off ? off.tag : '-'}»`);
    check(!!off && off.state === 'off' && /выключено|off/.test(off.tag), 'Q листает назад, есть позиция «выключено»');
    // снова включить и выйти из машины - радио замолкает
    await pc.keyboard.press('KeyE');
    const r3 = await waitOn(15000);
    await pc.keyboard.press('KeyF');
    await sleep(800);
    const r4 = await R();
    console.log(`после выхода: радио ${r4.active ? 'играет' : 'выключено'} (${r4.state}), надпись ${r4.tag ? 'видна' : 'скрыта'}; до выхода играла «${r3.station}»`);
    check(r3.state === 'on' && !r4.active && r4.state === 'off' && !r4.tag, 'вышел из машины - радио замолкло');
    // выбор запоминается
    const saved = await kv(() => localStorage.getItem('kv_radio'));
    check(saved !== null, `станция запомнена (${saved})`);
  } catch (e) {
    ok = false;
    console.log('FAIL исключение:', e.message);
  } finally {
    check(errors.length === 0, 'ошибок на странице нет' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
    await browser.close();
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    process.exitCode = ok ? 0 : 1;
  }
})();
