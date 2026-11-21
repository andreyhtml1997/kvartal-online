/* Язык (21.11.2026): новый гость видит игру по-английски, и ни в меню, ни в игре нет ни одной русской буквы
   (видимый и скрытый текст, подписи кнопок, подсказки полей); ?lang=ru и кнопка RU включают русский и запоминаются,
   кнопка EN возвращает английский; сервер отвечает на языке игрока, имена ботов - на языке создателя комнаты.
   Нужен сервер с KV_DEBUG=1. */
const { chromium } = require(process.env.PW_PATH || 'playwright');
const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const OUT = process.argv[3] || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: process.env.CH || 'chrome' });
  const errors = [];
  let ok = true;
  const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) ok = false; };
  // русские буквы на странице: текст любых узлов, подписи, подсказки, заголовок вкладки (сами data-ru* не считаются)
  const russianLeft = page => page.evaluate(() => {
    const re = /[А-Яа-яЁё]/, bad = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const tag = n.parentElement ? n.parentElement.tagName : '';
      if (tag !== 'SCRIPT' && tag !== 'STYLE' && re.test(n.nodeValue)) bad.push(n.nodeValue.trim().slice(0, 60));
    }
    for (const el of document.querySelectorAll('*')) {
      for (const a of ['aria-label', 'placeholder', 'title', 'alt']) {
        const v = el.getAttribute(a);
        if (v && re.test(v)) bad.push(a + ': ' + v.slice(0, 60));
      }
    }
    if (re.test(document.title)) bad.push('title: ' + document.title);
    return bad;
  });
  const join = async (page, name) => {
    await page.fill('#nameInput', name);
    await page.click('#btnCreate');
    await page.waitForFunction(() => window.__kv && window.__kv.S.me.alive, null, { timeout: 30000 });
  };
  const watch = page => {
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) errors.push(m.text()); });
  };
  try {
    // 1. Новый гость - английский, в меню ни одной русской буквы
    const en = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    watch(en);
    await en.goto(BASE + '/');
    const m1 = await en.evaluate(() => ({
      lang: document.documentElement.getAttribute('data-lang'), htmlLang: document.documentElement.lang,
      logo: document.querySelector('.logo').textContent, title: document.title,
      pressed: [...document.querySelectorAll('.lang-btn')].map(b => b.textContent + '=' + b.getAttribute('aria-pressed')).join(' '),
      wait: document.documentElement.classList.contains('i18n-wait')
    }));
    check(m1.lang === 'en' && m1.htmlLang === 'en' && m1.logo === 'CITY BLOCK' && /City Block/.test(m1.title) && !m1.wait,
      `по умолчанию английский: «${m1.logo}», вкладка «${m1.title}»`);
    check(m1.pressed === 'EN=true RU=false', `переключатель показывает EN (${m1.pressed})`);
    let bad = await russianLeft(en);
    check(bad.length === 0, `в меню нет русских букв${bad.length ? ': ' + bad.slice(0, 6).join(' | ') : ''}`);
    const logoBox = await en.evaluate(() => { const r = document.querySelector('.logo').getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width) }; });
    check(logoBox.h < 70, `название в одну строку (${logoBox.w}x${logoBox.h})`);
    await en.screenshot({ path: OUT + '/lang_menu_en.png' });

    // 2. Игра по-английски: боты, шестерёнка, счёт, карта, машина с радио
    await join(en, 'Tester');
    const kv = (f, arg) => en.evaluate(f, arg);
    await kv(() => window.__kv.send({ t: 'dbg', god: 1 }));
    await kv(() => window.__kv.send({ t: 'bots', on: true }));
    let bots = [];
    for (let i = 0; i < 20 && bots.length < 2; i++) { await sleep(400); bots = await kv(() => [...window.__kv.S.players.values()].filter(p => p.bot).map(p => p.name)); }
    check(bots.length >= 2 && bots.every(n => / \(bot\)$/.test(n) && !/[А-Яа-яЁё]/.test(n)), `боты с английскими именами: ${bots.slice(0, 4).join(', ')}`);
    const w = await kv(() => window.__kv.WEAPONS.map(x => x.name).join(', '));
    check(!/[А-Яа-яЁё]/.test(w) && /Pistol/.test(w) && /Minigun/.test(w), `оружие по-английски: ${w.slice(0, 70)}...`);
    await en.click('#btnMenu');
    await sleep(300);
    bad = await russianLeft(en);
    check(bad.length === 0, `в игре и в шестерёнке нет русских букв${bad.length ? ': ' + bad.slice(0, 6).join(' | ') : ''}`);
    await en.screenshot({ path: OUT + '/lang_gear_en.png' });
    await en.click('#btnBoard');
    await sleep(300);
    const heads = await en.evaluate(() => [...document.querySelectorAll('#board th')].map(t => t.textContent).join(', '));
    check(heads === 'Player, Kills, Deaths, Civilians, Police', `колонки счёта: ${heads}`);
    await en.click('#btnBoardClose');
    // машина рядом и радио: надпись станции английская
    await kv(() => window.__kv.send({ t: 'dbg', nearCar: 1 }));
    await sleep(700);
    await en.keyboard.press('KeyF');
    let inCar = false;
    for (let i = 0; i < 15 && !inCar; i++) { await sleep(300); inCar = await kv(() => !!window.__kv.S.me.vehicle); }
    await sleep(1200);
    const car = await kv(() => ({ tag: document.getElementById('radioTag').textContent, bar: document.getElementById('carText').textContent, toast: document.getElementById('toast').textContent }));
    check(inCar && /[A-Za-z]/.test(car.tag) && !/[А-Яа-яЁё]/.test(car.tag + car.bar + car.toast), `в машине: «${car.bar}», радио «${car.tag}», подсказка «${car.toast.slice(0, 50)}»`);
    // розыск - надпись и звёзды
    await kv(() => window.__kv.send({ t: 'dbg', wanted: 60 }));
    await sleep(1500);
    bad = await russianLeft(en);
    check(bad.length === 0, `за рулём и с розыском нет русских букв${bad.length ? ': ' + bad.slice(0, 6).join(' | ') : ''}`);
    await en.screenshot({ path: OUT + '/lang_game_en.png' });

    // 3. Сервер отвечает на языке игрока
    const errs = await kv(async () => {
      const ask = lang => new Promise(res => {
        const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
        ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room: '!', name: 'x', lang }));
        ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'err') { res(m.text); ws.close(); } } catch (_) {} };
        setTimeout(() => res('нет ответа'), 4000);
      });
      return { en: await ask('en'), ru: await ask('ru') };
    });
    check(errs.en === 'Invalid room code' && errs.ru === 'Неверный код комнаты', `ошибка сервера: en «${errs.en}», ru «${errs.ru}»`);

    // 4. ?lang=ru включает русский и запоминается; кнопки EN/RU переключают
    const ruCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const ru = await ruCtx.newPage();
    watch(ru);
    await ru.goto(BASE + '/?lang=ru');
    const st = () => ru.evaluate(() => ({
      lang: document.documentElement.getAttribute('data-lang'), logo: document.querySelector('.logo').textContent,
      title: document.title, saved: localStorage.getItem('kv_lang'), wait: document.documentElement.classList.contains('i18n-wait'),
      btn: document.getElementById('btnCreate').textContent, ph: document.getElementById('nameInput').placeholder
    }));
    let r = await st();
    check(r.lang === 'ru' && r.logo === 'КВАРТАЛ' && r.btn === 'Создать комнату' && r.ph === 'Игрок' && /Квартал/.test(r.title) && r.saved === 'ru' && !r.wait,
      `?lang=ru: «${r.logo}», «${r.btn}», вкладка «${r.title}», запомнено ${r.saved}`);
    await ru.screenshot({ path: OUT + '/lang_menu_ru.png' });
    await ru.goto(BASE + '/');
    r = await st();
    check(r.lang === 'ru' && r.logo === 'КВАРТАЛ', 'без параметра русский остаётся (выбор запомнен)');
    await Promise.all([ru.waitForNavigation(), ru.click('.lang-btn[data-lang="en"]')]);
    r = await st();
    check(r.lang === 'en' && r.logo === 'CITY BLOCK' && r.saved === 'en', `кнопка EN: «${r.logo}», запомнено ${r.saved}`);
    await Promise.all([ru.waitForNavigation(), ru.click('.lang-btn[data-lang="ru"]')]);
    r = await st();
    check(r.lang === 'ru' && r.logo === 'КВАРТАЛ' && r.saved === 'ru', `кнопка RU: «${r.logo}», запомнено ${r.saved}`);
    // комната, созданная по-русски, - русские имена ботов
    await join(ru, 'Проверка');
    await ru.evaluate(() => window.__kv.send({ t: 'bots', on: true }));
    let rb = [];
    for (let i = 0; i < 20 && rb.length < 2; i++) { await sleep(400); rb = await ru.evaluate(() => [...window.__kv.S.players.values()].filter(p => p.bot).map(p => p.name)); }
    check(rb.length >= 2 && rb.every(n => / \(бот\)$/.test(n)), `в русской комнате боты: ${rb.slice(0, 3).join(', ')}`);
    const hud = await ru.evaluate(() => document.getElementById('hpText').textContent);
    check(/Здоровье/.test(hud), `полоска здоровья по-русски: «${hud}»`);

    check(errors.length === 0, `ошибок в консоли нет${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  } catch (e) {
    console.log('FAIL исключение: ' + (e && e.stack || e));
    ok = false;
  }
  await browser.close();
  console.log('RESULT: ' + (ok ? 'PASS' : 'FAIL'));
  process.exit(ok ? 0 : 1);
})();
