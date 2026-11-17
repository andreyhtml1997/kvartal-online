/* Переподключение: сервер перезапустился (как при выкладке) или связь молча замерла - игра сама возвращается
   в ту же комнату, табличка «Связь потеряна» не нужна, ошибок нет. Сервер тест запускает сам (порт 8097). */
const { chromium } = require(process.env.PW_PATH || 'playwright');
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8097, BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const startServer = () => spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
async function waitUp() {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) {} await sleep(200); }
  return false;
}

(async () => {
  let srv = startServer();
  const errors = [];
  let ok = true;
  const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) ok = false; };
  const browser = await chromium.launch({ channel: process.env.CH || 'chrome' });
  try {
    check(await waitUp(), 'сервер запущен');
    const pc = await (await browser.newContext({ viewport: { width: 1000, height: 600 } })).newPage();
    pc.on('pageerror', e => errors.push(e.message));
    const room = 'recon' + Date.now().toString(36).slice(-4);
    await pc.goto(BASE + '/?room=' + room);
    await pc.fill('#nameInput', 'Переподключение');
    await pc.click('#btnJoin');
    await pc.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
    const kv = (f, arg) => pc.evaluate(f, arg);
    const since = () => kv(() => window.__kv.S.inGameSince);

    // 1. сервер оборвался и поднялся снова (выкладка новой версии)
    const t1 = await since();
    srv.kill();
    await sleep(1200);
    srv = startServer();
    await waitUp();
    let back = false;
    for (let i = 0; i < 40 && !back; i++) { await sleep(500); back = await kv(t => window.__kv.S.inGameSince !== t && window.__kv.S.inGame && window.__kv.S.me.alive, t1); }
    const st1 = await kv(() => ({ room: window.__kv.S.room, lost: !document.getElementById('lost').hidden }));
    check(back && !st1.lost && st1.room === room, `после перезапуска сервера игра сама вернулась в комнату ${st1.room}`);

    // 2. связь молча замерла: снимки перестали приходить - через ~4 с переподключение
    const t2 = await since();
    await kv(() => { window.__kv.S.ws.onmessage = () => {}; });
    let back2 = false, waited = 0;
    for (; waited < 30 && !back2; waited++) { await sleep(500); back2 = await kv(t => window.__kv.S.inGameSince !== t && window.__kv.S.me.alive, t2); }
    check(back2, `замершая связь распознана, переподключение за ${(waited * 0.5).toFixed(1)} с`);
    await pc.screenshot({ path: (process.argv[2] || '.') + '/reconnect.png' });
  } catch (e) {
    ok = false;
    console.log('FAIL исключение:', e.message);
  } finally {
    check(errors.length === 0, 'ошибок на странице нет' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
    await browser.close();
    srv.kill();
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    process.exitCode = ok ? 0 : 1;
  }
})();
