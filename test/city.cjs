/* Жители города в браузере: прохожие видны, звёзды розыска, полиция с мигалками, колонки счёта (нужен сервер с KV_DEBUG=1). */
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
    await pc.goto(BASE + '/?room=city' + Date.now().toString(36).slice(-4));
    await pc.fill('#nameInput', 'Горожанин');
    await pc.click('#btnJoin');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    const kv = (f, arg) => pc.evaluate(f, arg);
    await kv(() => window.__kv.send({ t: 'bots', on: false }));
    await kv(() => window.__kv.send({ t: 'dbg', god: 1 }));
    // прохожие подходят из-за края экрана
    let peds = 0;
    for (let i = 0; i < 30 && peds < 2; i++) { await sleep(500); peds = await kv(() => [...window.__kv.S.peds.values()].filter(n => n.fl & 1).length); }
    console.log(`прохожих на экране: ${peds}`);
    check(peds >= 1, 'на экране видны прохожие');
    await pc.screenshot({ path: OUT + '/city_peds.png' });
    check(!(await pc.isVisible('#stars')), 'без розыска звёзд на экране нет');
    // три звезды розыска - полиция с мигалками
    await kv(() => window.__kv.send({ t: 'dbg', wanted: 210 }));
    await sleep(800);
    const stars = await kv(() => window.__kv.S.stars);
    check(stars === 3, `звёзды розыска: ${stars}`);
    check(await pc.isVisible('#stars') && (await pc.$$eval('#stars i.on', l => l.length)) === 3, 'справа вверху горят три звезды');
    let police = 0, siren = false, copsNear = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const st = await kv(() => { const S = window.__kv.S; let pv = 0, sir = false; for (const v of S.vehicles.values()) if (v.kind === 1) { pv++; if (v.fl & 16) sir = true; }
        return { radar: S.police.length, pv, sir, cops: [...S.peds.values()].filter(n => n.kind === 1 && (n.fl & 1)).length }; });
      police = Math.max(police, st.radar); if (st.sir) siren = true; copsNear = Math.max(copsNear, st.cops);
      if (siren && copsNear > 0) break;
    }
    console.log(`полиция: на радаре ${police}, мигалки рядом ${siren}, полицейских на экране ${copsNear}`);
    check(police >= 1, 'полиция видна на радаре');
    check(siren || copsNear > 0, 'полиция приехала: машина с мигалками или полицейские рядом');
    await pc.screenshot({ path: OUT + '/city_police.png' });
    // ранили полицейского - над ним полоска здоровья (данные о здоровье жителей приходят в браузер)
    await kv(() => window.__kv.send({ t: 'dbg', god: 1, weapon: 1 }));
    let hurt = false;
    for (let i = 0; i < 10 && !hurt; i++) {
      const cop = await kv(() => { const S = window.__kv.S; let b = null, bd = 1e9; for (const n of S.peds.values()) if (n.kind === 1 && (n.fl & 1)) { const d = Math.hypot(n.rx - S.me.x, n.ry - S.me.y); if (d < bd) { bd = d; b = n; } } return b ? { x: b.rx, y: b.ry } : null; });
      if (!cop) { await sleep(500); continue; }
      const scr = await kv(c => { const v = window.__kv.S.view, dpr = document.getElementById('game').width / innerWidth; return { x: (c.x * v.tp + v.ox) / dpr, y: (c.y * v.tp + v.oy) / dpr }; }, cop);
      await pc.mouse.move(scr.x, scr.y); await pc.mouse.down(); await sleep(300); await pc.mouse.up(); await sleep(400);
      hurt = await kv(() => [...window.__kv.S.peds.values()].some(n => n.kind === 1 && (n.fl & 1) && n.hp < 100));
    }
    await pc.screenshot({ path: OUT + '/city_cop_hp.png' });
    check(hurt, 'у раненого полицейского видно здоровье (полоска над ним)');
    // таблица счёта: колонки «Мирные» и «Полиция»
    await pc.keyboard.down('Tab');
    await sleep(300);
    const heads = await pc.$$eval('#board th', l => l.map(e => e.textContent));
    await pc.keyboard.up('Tab');
    check((heads.includes('Мирные') || heads.includes('Civilians')) && (heads.includes('Полиция') || heads.includes('Police')), `в таблице колонки: ${heads.join(', ')}`);
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
