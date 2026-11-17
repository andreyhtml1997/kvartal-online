/* Дома чинятся сами - в браузере (нужен сервер с KV_DEBUG=1): выбитые кирпичи ближайшего дома возвращаются
   по одному (с пылью), карта у браузера совпадает, ошибок нет. Минуту ожидания отладочная команда пропускает. */
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
    await pc.goto(BASE + '/?room=rebuild' + Date.now().toString(36).slice(-4));
    await pc.fill('#nameInput', 'Строитель');
    await pc.click('#btnJoin');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    const kv = (f, arg) => pc.evaluate(f, arg);
    await kv(() => window.__kv.send({ t: 'bots', on: false }));
    // считаем, что приходит с сервера: выбитые клетки и вернувшиеся кирпичи
    await kv(() => {
      const S = window.__kv.S;
      window.__rb = { broken: new Set(), back: [] };
      S.ws.addEventListener('message', ev => {
        if (typeof ev.data !== 'string' || !ev.data.startsWith('{"t":"e"')) return;
        const m = JSON.parse(ev.data);
        for (const e of m.tl || []) {
          if (e.length === 5 && e[4] === 2) window.__rb.broken.add(e[0]);               // кирпич выбит
          else if (e.length === 4 && e[1] === 2 && window.__rb.broken.has(e[0])) window.__rb.back.push([e[0], performance.now()]); // встал на место
        }
      });
    });
    await kv(() => window.__kv.send({ t: 'dbg', god: 1, immortal: 1, wall: 1 }));
    let st = { broken: 0, back: 0 };
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      st = await kv(() => ({ broken: window.__rb.broken.size, back: window.__rb.back.length }));
      if (st.broken && st.back >= st.broken) break;
    }
    const res = await kv(() => {
      const S = window.__kv.S, back = window.__rb.back;
      const gaps = back.slice(1).map((e, i) => e[1] - back[i][1]);
      return { broken: window.__rb.broken.size, back: back.length, onMap: [...window.__rb.broken].filter(k => S.map.block[k] === 2).length,
        minGap: gaps.length ? Math.min(...gaps) : 0 };
    });
    console.log(`выбито кирпичей ${res.broken}, вернулось ${res.back}, на карте браузера ${res.onMap}, шаг от ${Math.round(res.minGap)} мс`);
    check(res.broken >= 3, 'кирпичи ближайшего дома выбиты');
    check(res.back === res.broken && res.onMap === res.broken, 'все выбитые кирпичи вернулись, и браузер их видит');
    check(res.back < 2 || res.minGap > 150, 'кирпичи встают по одному, а не разом');
    await pc.screenshot({ path: OUT + '/rebuild.png' });
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
