/* Голосовой чат в двух браузерах (вместо микрофона - тестовый сигнал Chrome). Запуск: node test/voice.cjs <адрес> <папка> */
const { chromium } = require(process.env.PW_PATH || 'playwright');
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const OUT = process.argv[3] || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: process.env.CH || 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  let ok = true;
  const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) ok = false; };
  try {
    const room = 'voice' + Date.now().toString(36).slice(-4);
    const open = async (name, vp) => {
      const ctx = await browser.newContext({ viewport: vp, permissions: ['microphone'] });
      const pg = await ctx.newPage();
      pg.on('pageerror', e => errors.push(name + ': ' + e.message));
      pg.on('console', m => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
      await pg.goto(BASE + '/?room=' + room);
      await pg.fill('#nameInput', name);
      await pg.click('#btnJoin');
      await pg.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
      return pg;
    };
    const a = await open('Андрей', { width: 1280, height: 720 });
    const b = await open('Богдан', { width: 1100, height: 650 });
    await sleep(600);
    check(await a.isVisible('#btnVoice'), 'кнопка голосового чата видна');
    check(!(await a.isVisible('#btnMic')), 'кнопки микрофона до подключения нет');
    await a.click('#btnVoice');
    await b.click('#btnVoice');
    await a.waitForFunction(() => window.__kv.Voice.isOn(), null, { timeout: 8000 }).catch(() => {});
    await b.waitForFunction(() => window.__kv.Voice.isOn(), null, { timeout: 8000 }).catch(() => {});
    check(await a.evaluate(() => window.__kv.Voice.isOn()) && await b.evaluate(() => window.__kv.Voice.isOn()), 'оба подключились к голосу');
    check(await a.isVisible('#btnMic'), 'появилась кнопка микрофона');
    // ставим Андрея рядом с Богданом: значок рисуется над теми, кто на экране
    const bp = await b.evaluate(() => ({ x: window.__kv.S.me.x, y: window.__kv.S.me.y }));
    await a.evaluate(() => window.__kv.send({ t: 'dbg', god: 1 }));
    await b.evaluate(() => window.__kv.send({ t: 'dbg', god: 1 }));
    for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1.2, 1.2]]) await a.evaluate(t => window.__kv.send({ t: 'dbg', tp: t }), [bp.x + dx, bp.y + dy]);
    await sleep(700);
    // тестовый сигнал Chrome пищит раз в секунду - микрофон должен его «услышать» и передать
    let talkSeen = false;
    for (let i = 0; i < 40 && !talkSeen; i++) {
      await sleep(150);
      talkSeen = await b.evaluate(() => { const S = window.__kv.S; for (const p of S.players.values()) if (p.id !== S.myId && !p.bot && (p.flags & 128)) return true; return false; });
    }
    await sleep(1500);
    const sa = await a.evaluate(() => Object.assign({}, window.__kv.Voice.stats));
    const sb = await b.evaluate(() => Object.assign({}, window.__kv.Voice.stats));
    console.log(`кадров голоса: Андрей отправил ${sa.sent}, получил ${sa.got}; Богдан отправил ${sb.sent}, получил ${sb.got}`);
    check(sa.sent > 5 && sb.got > 5, 'голос одного доходит до другого');
    check(talkSeen, 'у говорящего над головой значок динамика (флаг «говорит» виден второму)');
    await b.screenshot({ path: OUT + '/voice_b.png' });
    // выключил микрофон - голос не уходит
    await a.click('#btnMic');
    await sleep(400);
    const s1 = await a.evaluate(() => window.__kv.Voice.stats.sent);
    await sleep(2500);
    const s2 = await a.evaluate(() => window.__kv.Voice.stats.sent);
    check(s2 === s1, `выключенный микрофон молчит (${s2 - s1} кадров за 2.5 с)`);
    check(await a.evaluate(() => document.getElementById('btnMic').classList.contains('muted')), 'кнопка микрофона показывает «выключен»');
    // вышел из голоса - кнопка микрофона пропала
    await a.click('#btnVoice');
    await sleep(400);
    check(!(await a.evaluate(() => window.__kv.Voice.isOn())) && !(await a.isVisible('#btnMic')), 'выход из голосового чата');
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
