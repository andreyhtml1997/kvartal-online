'use strict';
/*
 * Сервер игры «Квартал»: раздаёт игру из ./public и ведёт комнаты по WebSocket /ws.
 * Комната создаётся по первой ссылке ?room=<код> и удаляется, когда в ней 30 с нет людей.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const KV = require('./public/shared.js');
const { Room } = require('./game/room');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 30;
const ROOM_IDLE_MS = 30000;
const ROOM_RE = /^[a-z0-9]{3,16}$/;
const MAX_MSGS_PER_SEC = 80;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};

const rooms = new Map();
const load = { ema: 0, max: 0 };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    let players = 0;
    for (const r of rooms.values()) players += r.humanCount();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    // tickMs - сколько в среднем занимает такт всех комнат, tickMax - худший недавний (замер нагрузки на хостинге)
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players, tickMs: Math.round(load.ema * 1000) / 1000, tickMax: Math.round(load.max * 100) / 100 }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (_) { res.writeHead(400); res.end(); return; }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});

function cleanName(v) {
  const s = String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  return s || 'Игрок';
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', ws => {
  ws.alive = true;
  ws.room = null;
  ws.player = null;
  ws.msgCount = 0;
  ws.msgWindow = Date.now();
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw, isBinary) => {
    // голосовой чат: двоичные кадры идут мимо JSON, у них своё ограничение частоты (room.onVoice)
    if (isBinary) { if (ws.room && ws.player) ws.room.onVoice(ws.player, raw); return; }
    const now = Date.now();
    if (now - ws.msgWindow > 1000) { ws.msgWindow = now; ws.msgCount = 0; }
    if (++ws.msgCount > MAX_MSGS_PER_SEC) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (!ws.room) {
      if (msg.t !== 'join') return;
      const id = String(msg.room || '').toLowerCase();
      if (!ROOM_RE.test(id)) { ws.send(JSON.stringify({ t: 'err', text: 'Неверный код комнаты' })); return; }
      let room = rooms.get(id);
      if (!room) {
        if (rooms.size >= MAX_ROOMS) { ws.send(JSON.stringify({ t: 'err', text: 'Сервер занят, попробуйте позже' })); return; }
        room = new Room(id);
        rooms.set(id, room);
      }
      const p = room.addHuman(ws, cleanName(msg.name));
      if (!p) { ws.send(JSON.stringify({ t: 'err', text: 'Комната заполнена (максимум 16 игроков)' })); return; }
      ws.room = room;
      ws.player = p;
      return;
    }
    ws.room.onMessage(ws.player, msg);
  });

  ws.on('close', () => {
    if (ws.room && ws.player) ws.room.removePlayer(ws.player.id);
    ws.room = null;
    ws.player = null;
  });
  ws.on('error', () => {});
});

// Пинг раз в 20 с: рвёт мёртвые соединения и не даёт хостингу закрыть простаивающий сокет
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 20000);
wss.on('close', () => clearInterval(heartbeat));

// Выкладка новой версии: хостинг шлёт SIGTERM. Предупреждаем игроков и закрываем соединения как «сервер перезапускается» -
// браузеры сами переподключатся к новой версии в ту же комнату (17.11.2026: при выкладке у игрока всё молча исчезало с экрана)
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const bye = JSON.stringify({ t: 'bye', why: 'update' });
  for (const ws of wss.clients) { try { ws.send(bye); } catch (_) {} }
  setTimeout(() => {
    for (const ws of wss.clients) { try { ws.close(1012, 'restart'); } catch (_) {} }
    server.close();
    setTimeout(() => process.exit(0), 300);
  }, 400);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Игровой цикл: фиксированный шаг, при задержке догоняем не больше 4 тактов за раз
const TICK_MS = 1000 / KV.TICK_RATE;
let last = process.hrtime.bigint();
let acc = 0;
setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Math.min(Number(now - last) / 1e6, 250);
  last = now;
  let steps = 0;
  while (acc >= TICK_MS && steps < 4) {
    const t0 = process.hrtime.bigint();
    let busy = false;
    for (const room of rooms.values()) {
      if (room.humanCount() > 0) {
        busy = true;
        try { room.tick(); } catch (e) { console.error('room', room.id, e); }
      }
    }
    if (busy) {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      load.ema = load.ema * 0.98 + ms * 0.02;
      load.max = Math.max(load.max * 0.995, ms);
    }
    acc -= TICK_MS;
    steps++;
  }
  if (steps === 4) acc = 0;
  const t = Date.now();
  for (const [id, room] of rooms) {
    if (room.humanCount() === 0 && room.emptySince && t - room.emptySince > ROOM_IDLE_MS) rooms.delete(id);
  }
}, TICK_MS / 2);

server.listen(PORT, () => console.log(`Kvartal server: http://localhost:${PORT}`));

module.exports = { server, rooms };
