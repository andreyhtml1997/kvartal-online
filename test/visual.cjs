/* Снимки боя для проверки глазами: гранатомёт по стене дома, автомат, разрушения.
   Нужен сервер с KV_DEBUG=1. Запуск: node test/visual.cjs <адрес> <папка> */
const { chromium } = require(process.env.PW_PATH || 'playwright');
const BASE = (process.argv[2] || 'http://localhost:8092').replace(/\/$/, '');
const OUT = process.argv[3] || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: process.env.CH || 'chrome' });
  const errors = [];
  try {
    const pc = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    pc.on('pageerror', e => errors.push(e.message));
    pc.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await pc.goto(BASE + '/?room=visual' + Date.now().toString(36).slice(-4));
    await pc.fill('#nameInput', 'Тест');
    await pc.click('#btnJoin');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    await sleep(800);

    // ближайший дом и точка в 3.5 м от его стены
    const plan = await pc.evaluate(() => {
      const S = window.__kv.S, m = S.map;
      const walk = (x, y) => { const k = Math.floor(y) * m.w + Math.floor(x); return m.block[k] === 0 && m.ground[k] !== 6; };
      let best = null;
      for (const b of m.buildings) {
        const cands = [[b.x - 3.5, b.y + b.h / 2, b.x + 0.5, b.y + b.h / 2], [b.x + b.w + 3.5, b.y + b.h / 2, b.x + b.w - 0.5, b.y + b.h / 2],
          [b.x + b.w / 2, b.y - 3.5, b.x + b.w / 2, b.y + 0.5], [b.x + b.w / 2, b.y + b.h + 3.5, b.x + b.w / 2, b.y + b.h - 0.5]];
        for (const [x, y, wx, wy] of cands) {
          if (!walk(x, y) || !walk(x + 0.45, y) || !walk(x - 0.45, y) || !walk(x, y + 0.45) || !walk(x, y - 0.45)) continue;
          const d = Math.hypot(x - S.me.x, y - S.me.y);
          if (!best || d < best.d) best = { d, x, y, wx, wy, id: b.id };
        }
      }
      return best;
    });
    console.log('дом', plan.id, 'встаём в', plan.x.toFixed(1), plan.y.toFixed(1));
    await pc.evaluate(p => { window.__kv.send({ t: 'dbg', give: 1, god: 1, tp: [p.x, p.y] }); }, plan);
    await sleep(600);
    const aimAt = async (wx, wy) => {
      const s = await pc.evaluate(([x, y]) => { const v = window.__kv.S.view; const dpr = window.__kv.S.view.tp ? (document.getElementById('game').width / innerWidth) : 1; return [(x * v.tp + v.ox) / dpr, (y * v.tp + v.oy) / dpr]; }, [wx, wy]);
      await pc.mouse.move(s[0], s[1]);
    };
    await pc.keyboard.press('Digit6'); // гранатомёт
    await sleep(300);
    await aimAt(plan.wx, plan.wy);
    await sleep(200);
    await pc.mouse.down(); await sleep(60); await pc.mouse.up();
    await sleep(330);
    await pc.screenshot({ path: OUT + '/boom.png' });
    for (let i = 0; i < 3; i++) { await sleep(1300); await aimAt(plan.wx, plan.wy + (i - 1) * 1.5); await pc.mouse.down(); await sleep(60); await pc.mouse.up(); }
    await sleep(2200);
    await pc.screenshot({ path: OUT + '/after.png' });
    const st = await pc.evaluate(id => ({ roof: window.__kv.S.map.buildings[id].roof }), plan.id);
    console.log('крыша дома после 4 гранат:', st.roof ? 'цела' : 'обрушилась');

    // автомат: очередь по окнам
    await pc.keyboard.press('Digit3');
    await sleep(300);
    await aimAt(plan.wx, plan.wy - 2);
    await pc.mouse.down(); await sleep(700);
    await pc.screenshot({ path: OUT + '/rifle.png' });
    await pc.mouse.up();

    // заходим внутрь через пролом - крыша должна стать прозрачной (если ещё цела)
    console.log('ошибок в консоли:', errors.length, errors.slice(0, 3).join(' | '));
  } catch (e) {
    console.log('ошибка:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
