/* Поиск «невидимых стрелков»: каждая пуля в кадре должна вылетать из того, кого браузер рисует (нужен KV_DEBUG=1). */
const { chromium } = require(process.env.PW_PATH || 'playwright');
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const OUT = process.argv[3] || '.';
const SECS = Number(process.argv[4] || 70);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: process.env.CH || 'chrome' });
  const errors = [];
  let ok = true;
  const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) ok = false; };
  try {
    const pc = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    pc.on('pageerror', e => errors.push(e.message));
    await pc.goto(BASE + '/?room=ghost' + Date.now().toString(36).slice(-4));
    await pc.fill('#nameInput', 'Сыщик');
    await pc.click('#btnJoin');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    const kv = (f, arg) => pc.evaluate(f, arg);
    // каждая новая пуля: есть ли рядом с её началом кто-то, кого браузер рисует
    await kv(() => {
      const S = window.__kv.S;
      window.__ghost = [];
      window.__shots = 0;
      const orig = S.bullets.set.bind(S.bullets);
      S.bullets.set = (id, b) => {
        const v = S.view, x0 = b.x0, y0 = b.y0;
        const inView = Math.abs(x0 - S.me.x) < v.hw && Math.abs(y0 - S.me.y) < v.hh;
        if (inView) {
          window.__shots++;
          let best = 1e9, who = '';
          const last = o => (o.snaps && o.snaps.length ? o.snaps[o.snaps.length - 1] : null);
          const now = performance.now(), drawn = o => now - (o.drawnAt || -1e9) < 250;
          if (S.me.alive) { const d = Math.hypot(S.me.x - x0, S.me.y - y0); if (d < best) { best = d; who = 'я'; } }
          for (const p of S.players.values()) { const s = last(p); if (!s || !(p.flags & 1) || !drawn(p)) continue; const d = Math.hypot(p.rx - x0, p.ry - y0); if (d < best) { best = d; who = 'игрок ' + p.name; } }
          for (const n of S.peds.values()) { if (!(n.fl & 1) || !drawn(n)) continue; const d = Math.hypot(n.rx - x0, n.ry - y0); if (d < best) { best = d; who = 'житель вид ' + n.kind; } }
          for (const c of S.vehicles.values()) { if (!drawn(c)) continue; const d = Math.max(0, Math.hypot(c.rx - x0, c.ry - y0) - 2.2); if (d < best) { best = d; who = 'машина вид ' + (c.kind || 0); } }
          // полицейский вертолёт (с 4 звёзд) бьёт очередями из-под винта
          for (const h of (S.helis || new Map()).values()) { if (!drawn(h)) continue; const d = Math.max(0, Math.hypot(h.rx - x0, h.ry - y0) - 1.6); if (d < best) { best = d; who = 'вертолёт'; } }
          // кто стрелял по данным сервера (для отчёта)
          let src = '';
          for (const p of S.players.values()) { const s = last(p); if (s && Math.hypot(s[1] - x0, s[2] - y0) < 3) src += ' данные: игрок ' + p.name + ' флаги ' + p.flags + ' нарисован ' + drawn(p) + ';'; }
          for (const n of S.peds.values()) { const s = last(n); if (s && Math.hypot(s[1] - x0, s[2] - y0) < 3) src += ' данные: житель вид ' + n.kind + ' флаги ' + n.fl + ' нарисован ' + drawn(n) + ';'; }
          for (const c of S.vehicles.values()) { const s = last(c); if (s && Math.hypot(s[1] - x0, s[2] - y0) < 5) src += ' данные: машина вид ' + (c.kind || 0) + ' флаги ' + c.fl + ' нарисована ' + drawn(c) + ';'; }
          who += src;
          if (best > 3) window.__ghost.push({ x0: +x0.toFixed(1), y0: +y0.toFixed(1), w: b.w, best: +best.toFixed(1), who, me: [+S.me.x.toFixed(1), +S.me.y.toFixed(1)], car: S.me.vehicle });
        }
        return orig(id, b);
      };
    });
    // звёзды - приезжает полиция; садимся в машину и стоим/едем
    await kv(() => window.__kv.send({ t: 'dbg', god: 1, wanted: 210 }));
    await kv(() => window.__kv.send({ t: 'dbg', nearCar: 1 }));
    await sleep(900);
    await pc.keyboard.press('KeyF');
    await sleep(800);
    const t0 = Date.now();
    let k = 0;
    while (Date.now() - t0 < SECS * 1000) {
      // покатались туда-сюда, чтобы было как у игрока: в машине, полиция догоняет
      const key = k++ % 4 < 2 ? 'KeyW' : 'KeyS';
      await pc.keyboard.down(key); await sleep(1200); await pc.keyboard.up(key);
      await kv(() => window.__kv.send({ t: 'dbg', god: 1, wanted: 60 }));
      await sleep(800);
    }
    const res = await kv(() => ({ shots: window.__shots, ghost: window.__ghost }));
    console.log(`пуль в кадре: ${res.shots}, без видимого стрелка рядом: ${res.ghost.length}`);
    for (const g of res.ghost.slice(0, 15)) console.log('  ' + JSON.stringify(g));
    await pc.screenshot({ path: OUT + '/ghost.png' });
    check(res.ghost.length === 0, 'каждая пуля вылетает из того, кого видно');
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
