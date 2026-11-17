'use strict';
/*
 * Генератор города. Каждая комната получает свою карту:
 * сетка дорог, кварталы с домами (комнаты, двери, окна), парки с прудами,
 * парковки с машинами, стройки за заборами. Все препятствия - клетки 1x1 м
 * со своей прочностью (см. BLOCKS в shared.js), поэтому разрушается всё, кроме границы.
 */
const KV = require('../public/shared.js');
const { G, B, BLOCKS } = KV;

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateMap(seed, W = KV.MAP_W, H = KV.MAP_H) {
  const rng = mulberry32(seed >>> 0);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const chance = p => rng() < p;
  const shuffle = arr => {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  };

  const N = W * H;
  const ground = new Uint8Array(N).fill(G.GRASS);
  const block = new Uint8Array(N);
  const owner = new Int16Array(N).fill(-1);   // индекс дома, которому принадлежит клетка
  const keep = new Uint8Array(N);             // проходы, которые нельзя загораживать
  const carMask = new Uint8Array(N);          // место под припаркованной машиной (машины - отдельные объекты, не клетки)
  const buildings = [];
  const carSpawns = [];

  const I = (x, y) => y * W + x;
  const inside = (x, y) => x > 0 && y > 0 && x < W - 1 && y < H - 1;
  const fillG = (x, y, w, h, t) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (inside(i, j)) ground[I(i, j)] = t;
  };
  const free = (x, y) => inside(x, y) && block[I(x, y)] === B.NONE && ground[I(x, y)] !== G.WATER && !keep[I(x, y)] && !carMask[I(x, y)];
  const rectFree = (x, y, w, h) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (!free(i, j)) return false;
    return true;
  };
  const near = (x, y, r, t) => {
    for (let j = y - r; j <= y + r; j++) for (let i = x - r; i <= x + r; i++) if (inside(i, j) && block[I(i, j)] === t) return true;
    return false;
  };
  const nearGround = (x, y, r, t) => {
    for (let j = y - r; j <= y + r; j++) for (let i = x - r; i <= x + r; i++) if (inside(i, j) && ground[I(i, j)] === t) return true;
    return false;
  };

  // ---------- граница ----------
  for (let x = 0; x < W; x++) { block[I(x, 0)] = B.BORDER; block[I(x, H - 1)] = B.BORDER; }
  for (let y = 0; y < H; y++) { block[I(0, y)] = B.BORDER; block[I(W - 1, y)] = B.BORDER; }

  // ---------- дороги ----------
  const RW = 4;
  function splitAxis(len, n) {
    const total = len - RW * (n + 1);
    const weights = [];
    let sum = 0;
    for (let i = 0; i < n; i++) { const w = 0.75 + rng() * 0.5; weights.push(w); sum += w; }
    const sizes = weights.map(w => Math.floor((total * w) / sum));
    let rest = total - sizes.reduce((a, b) => a + b, 0);
    for (let i = 0; rest > 0; i = (i + 1) % n) { sizes[i]++; rest--; }
    const roads = [], blocks = [];
    let p = 1;
    for (let i = 0; i < n; i++) { roads.push([p, RW]); p += RW; blocks.push([p, sizes[i]]); p += sizes[i]; }
    roads.push([p, RW]);
    return { roads, blocks };
  }
  const nBlocks = Math.max(2, Math.round((W - 2) / 31));
  const ax = splitAxis(W - 2, nBlocks), ay = splitAxis(H - 2, nBlocks);
  const vRoad = new Uint8Array(W), hRoad = new Uint8Array(H);
  for (const [x, w] of ax.roads) { fillG(x, 1, w, H - 2, G.ROAD); for (let i = x; i < x + w; i++) vRoad[i] = 1; }
  for (const [y, h] of ay.roads) { fillG(1, y, W - 2, h, G.ROAD); for (let j = y; j < y + h; j++) hRoad[j] = 1; }

  // ---------- машины на парковках (отдельные объекты, их можно угнать) ----------
  function placeCar(x, y, w, h, vertical, flip) {
    if (!rectFree(x, y, w, h)) return false;
    // носом вверх/вниз (вертикально) или вправо/влево
    const a = vertical ? (flip ? Math.PI / 2 : -Math.PI / 2) : (flip ? Math.PI : 0);
    carSpawns.push({ x: x + w / 2, y: y + h / 2, a, color: ri(0, 7) });
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) carMask[I(i, j)] = 1;
    return true;
  }

  // ---------- дома ----------
  // Координаты стены, клетки снаружи и клетки внутри для позиции t на стороне side (0 верх, 1 право, 2 низ, 3 лево)
  function sideTile(b, side, t) {
    const { x, y, w, h } = b;
    if (side === 0) return [x + t, y, x + t, y - 1, x + t, y + 1];
    if (side === 2) return [x + t, y + h - 1, x + t, y + h, x + t, y + h - 2];
    if (side === 3) return [x, y + t, x - 1, y + t, x + 1, y + t];
    return [x + w - 1, y + t, x + w, y + t, x + w - 2, y + t];
  }

  function splitRooms(x, y, w, h, depth) {
    if (depth > 3) return;
    const canV = w >= 9, canH = h >= 9;
    if (!canV && !canH) return;
    const vertical = canV && (!canH || w > h || (w === h && chance(0.5)));
    for (let tries = 0; tries < 8; tries++) {
      if (vertical) {
        const c = x + ri(4, w - 5);
        // концы новой стены должны упираться в стену, а не в проём
        if (block[I(c, y - 1)] !== B.BRICK || block[I(c, y + h)] !== B.BRICK) continue;
        for (let j = y; j < y + h; j++) block[I(c, j)] = B.BRICK;
        const dw = h >= 6 ? 2 : 1;
        const d = y + ri(1, h - 1 - dw);
        for (let j = d; j < d + dw; j++) { block[I(c, j)] = B.NONE; keep[I(c, j)] = 1; keep[I(c - 1, j)] = 1; keep[I(c + 1, j)] = 1; }
        splitRooms(x, y, c - x, h, depth + 1);
        splitRooms(c + 1, y, x + w - c - 1, h, depth + 1);
      } else {
        const c = y + ri(4, h - 5);
        if (block[I(x - 1, c)] !== B.BRICK || block[I(x + w, c)] !== B.BRICK) continue;
        for (let i = x; i < x + w; i++) block[I(i, c)] = B.BRICK;
        const dw = w >= 6 ? 2 : 1;
        const d = x + ri(1, w - 1 - dw);
        for (let i = d; i < d + dw; i++) { block[I(i, c)] = B.NONE; keep[I(i, c)] = 1; keep[I(i, c - 1)] = 1; keep[I(i, c + 1)] = 1; }
        splitRooms(x, y, w, c - y, depth + 1);
        splitRooms(x, c + 1, w, y + h - c - 1, depth + 1);
      }
      return;
    }
  }

  function makeDoor(b, side) {
    const len = side % 2 === 0 ? b.w : b.h;
    const dw = len >= 8 ? 2 : 1;
    const cands = [];
    for (let t = 2; t + dw <= len - 2; t++) cands.push(t);
    shuffle(cands);
    for (const t of cands) {
      const tiles = [];
      let ok = true;
      for (let d = 0; d < dw && ok; d++) {
        const [wx, wy, ox, oy, ix, iy] = sideTile(b, side, t + d);
        if (!inside(ox, oy) || block[I(ox, oy)] !== B.NONE || owner[I(ox, oy)] !== -1 ||
            block[I(ix, iy)] !== B.NONE || block[I(wx, wy)] !== B.BRICK) ok = false;
        else tiles.push([wx, wy, ox, oy, ix, iy]);
      }
      if (!ok) continue;
      for (const [wx, wy, ox, oy, ix, iy] of tiles) {
        block[I(wx, wy)] = B.NONE;
        keep[I(wx, wy)] = 1; keep[I(ox, oy)] = 1; keep[I(ix, iy)] = 1;
        const ox2 = ox + (ox - wx), oy2 = oy + (oy - wy);
        if (inside(ox2, oy2)) keep[I(ox2, oy2)] = 1;
      }
      return true;
    }
    return false;
  }

  function makeWindows(b) {
    for (let side = 0; side < 4; side++) {
      const len = side % 2 === 0 ? b.w : b.h;
      const phase = ri(0, 3);
      for (let t = 2; t <= len - 3; t++) {
        if ((t + phase) % 4 >= 2) continue;
        const [wx, wy, ox, oy, ix, iy] = sideTile(b, side, t);
        if (block[I(wx, wy)] !== B.BRICK || block[I(ix, iy)] !== B.NONE || !inside(ox, oy)) continue;
        block[I(wx, wy)] = B.GLASS;
      }
    }
  }

  function furnish(b) {
    const n = Math.max(1, Math.floor(((b.w - 2) * (b.h - 2)) / 30));
    for (let k = 0, tries = 0; k < n && tries < 80; tries++) {
      const tx = ri(b.x + 1, b.x + b.w - 2), ty = ri(b.y + 1, b.y + b.h - 2);
      if (!free(tx, ty)) continue;
      if (!DIRS4.some(([dx, dy]) => block[I(tx + dx, ty + dy)] === B.BRICK)) continue; // мебель - у стены
      if (near(tx, ty, 1, B.CRATE) || near(tx, ty, 1, B.BENCH) || near(tx, ty, 1, B.BARREL)) continue;
      block[I(tx, ty)] = chance(0.55) ? B.CRATE : chance(0.85) ? B.BENCH : B.BARREL;
      k++;
    }
  }

  function placeBuilding(x, y, w, h) {
    const b = { id: buildings.length, x, y, w, h, walls: 0, destroyed: 0, roof: true };
    buildings.push(b);
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        const k = I(i, j);
        owner[k] = b.id;
        ground[k] = G.FLOOR;
        block[k] = (i === x || j === y || i === x + w - 1 || j === y + h - 1) ? B.BRICK : B.NONE;
      }
    }
    splitRooms(x + 1, y + 1, w - 2, h - 2, 0);
    const doors = Math.min(4, 1 + (w * h > 120 ? 1 : 0) + (chance(0.3) ? 1 : 0));
    let made = 0;
    for (const side of shuffle([0, 1, 2, 3])) { if (made >= doors) break; if (makeDoor(b, side)) made++; }
    makeWindows(b);
    furnish(b);
  }

  // ---------- типы кварталов ----------
  function yardDecor(x, y, w, h) {
    for (let k = 0; k < Math.max(1, Math.floor((w * h) / 18)); k++) {
      const tx = ri(x, x + w - 1), ty = ri(y, y + h - 1);
      if (!free(tx, ty) || near(tx, ty, 1, B.TREE)) continue;
      block[I(tx, ty)] = chance(0.5) ? B.TREE : chance(0.6) ? B.CRATE : B.BARREL;
    }
  }

  function blockBuildings(x, y, w, h) {
    fillG(x, y, w, h, chance(0.5) ? G.GRASS : G.LOT);
    let parcels = [[x, y, w, h]];
    if (w >= 18 && chance(0.75)) {
      parcels = parcels.flatMap(([px, py, pw, ph]) => {
        const c = ri(7, pw - 9);
        fillG(px + c, py, 2, ph, G.LOT);
        return [[px, py, c, ph], [px + c + 2, py, pw - c - 2, ph]];
      });
    }
    if (h >= 18 && chance(0.75)) {
      parcels = parcels.flatMap(([px, py, pw, ph]) => {
        const c = ri(7, ph - 9);
        fillG(px, py + c, pw, 2, G.LOT);
        return [[px, py, pw, c], [px, py + c + 2, pw, ph - c - 2]];
      });
    }
    for (const [px, py, pw, ph] of parcels) {
      if (pw < 7 || ph < 7 || chance(0.1)) { yardDecor(px, py, pw, ph); continue; }
      const bw = pw - ri(0, Math.min(3, pw - 7));
      const bh = ph - ri(0, Math.min(3, ph - 7));
      placeBuilding(px + ri(0, pw - bw), py + ri(0, ph - bh), bw, bh);
    }
  }

  function blockPark(x, y, w, h) {
    fillG(x, y, w, h, G.GRASS);
    const cx = x + ri(Math.floor(w * 0.35), Math.floor(w * 0.6));
    const cy = y + ri(Math.floor(h * 0.35), Math.floor(h * 0.6));
    fillG(cx, y, 2, h, G.DIRT);
    fillG(x, cy, w, 2, G.DIRT);
    if (chance(0.6)) {
      const qx = chance(0.5) ? [x, cx] : [cx + 2, x + w];
      const qy = chance(0.5) ? [y, cy] : [cy + 2, y + h];
      const qw = qx[1] - qx[0], qh = qy[1] - qy[0];
      if (qw >= 7 && qh >= 7) {
        const rx = ri(2, Math.floor(qw / 2) - 1), ry = ri(2, Math.floor(qh / 2) - 1);
        const ex = qx[0] + Math.floor(qw / 2), ey = qy[0] + Math.floor(qh / 2);
        for (let j = ey - ry; j <= ey + ry; j++) {
          for (let i = ex - rx; i <= ex + rx; i++) {
            const dx = (i - ex) / rx, dy = (j - ey) / ry;
            if (dx * dx + dy * dy <= 1 && inside(i, j) && ground[I(i, j)] === G.GRASS) ground[I(i, j)] = G.WATER;
          }
        }
      }
    }
    const trees = Math.floor((w * h) / 16);
    for (let k = 0, tries = 0; k < trees && tries < trees * 8; tries++) {
      const tx = ri(x, x + w - 1), ty = ri(y, y + h - 1);
      if (!free(tx, ty) || ground[I(tx, ty)] !== G.GRASS || near(tx, ty, 1, B.TREE) || nearGround(tx, ty, 1, G.WATER)) continue;
      block[I(tx, ty)] = B.TREE;
      k++;
    }
    for (let k = 0; k < 6; k++) {
      const alongV = chance(0.5);
      const tx = alongV ? (chance(0.5) ? cx - 1 : cx + 2) : ri(x + 1, x + w - 2);
      const ty = alongV ? ri(y + 1, y + h - 2) : (chance(0.5) ? cy - 1 : cy + 2);
      if (free(tx, ty) && ground[I(tx, ty)] === G.GRASS && !near(tx, ty, 1, B.BENCH)) block[I(tx, ty)] = B.BENCH;
    }
  }

  function blockParking(x, y, w, h) {
    fillG(x, y, w, h, G.LOT);
    if (chance(0.5)) {
      const rows = [y + 1, y + h - 5];
      for (const ry of rows) for (let cx = x + 1; cx + 2 <= x + w - 1; cx += 3) if (chance(0.5)) placeCar(cx, ry, 2, 4, true, ry === rows[0]);
    } else {
      const cols = [x + 1, x + w - 5];
      for (const rx of cols) for (let cy = y + 1; cy + 2 <= y + h - 1; cy += 3) if (chance(0.5)) placeCar(rx, cy, 4, 2, false, rx === cols[0]);
    }
    for (let k = 0; k < 5; k++) {
      const tx = ri(x + 1, x + w - 2), ty = ri(y + 1, y + h - 2);
      let byCar = false;
      for (let j = ty - 1; j <= ty + 1; j++) for (let i = tx - 1; i <= tx + 1; i++) if (inside(i, j) && carMask[I(i, j)]) byCar = true;
      if (free(tx, ty) && !byCar) block[I(tx, ty)] = chance(0.55) ? B.BARREL : B.CONCRETE;
    }
  }

  function blockYard(x, y, w, h) {
    fillG(x, y, w, h, G.DIRT);
    const fence = (i, j) => { if (free(i, j)) block[I(i, j)] = B.FENCE; };
    for (let i = x; i < x + w; i++) { fence(i, y); fence(i, y + h - 1); }
    for (let j = y; j < y + h; j++) { fence(x, j); fence(x + w - 1, j); }
    // проходы в заборе
    for (let side = 0; side < 4; side++) {
      const len = side % 2 === 0 ? w : h;
      const n = ri(1, 2);
      for (let k = 0; k < n; k++) {
        const t = ri(2, len - 4);
        for (let d = 0; d < 2; d++) {
          let gx, gy, ix, iy, ox, oy;
          if (side === 0) { gx = x + t + d; gy = y; ix = gx; iy = gy + 1; ox = gx; oy = gy - 1; }
          else if (side === 2) { gx = x + t + d; gy = y + h - 1; ix = gx; iy = gy - 1; ox = gx; oy = gy + 1; }
          else if (side === 3) { gx = x; gy = y + t + d; ix = gx + 1; iy = gy; ox = gx - 1; oy = gy; }
          else { gx = x + w - 1; gy = y + t + d; ix = gx - 1; iy = gy; ox = gx + 1; oy = gy; }
          if (block[I(gx, gy)] === B.FENCE) block[I(gx, gy)] = B.NONE;
          keep[I(gx, gy)] = 1; keep[I(ix, iy)] = 1;
          if (inside(ox, oy)) keep[I(ox, oy)] = 1;
        }
      }
    }
    // недострой: кирпичный контур с проломами, без крыши
    if (w >= 12 && h >= 12 && chance(0.75)) {
      const sw = ri(6, Math.min(10, w - 5)), sh = ri(6, Math.min(10, h - 5));
      const sx = ri(x + 2, x + w - 2 - sw), sy = ri(y + 2, y + h - 2 - sh);
      fillG(sx, sy, sw, sh, G.LOT);
      let gaps = 0;
      for (let j = sy; j < sy + sh; j++) {
        for (let i = sx; i < sx + sw; i++) {
          if (i !== sx && j !== sy && i !== sx + sw - 1 && j !== sy + sh - 1) continue;
          const corner = (i === sx || i === sx + sw - 1) && (j === sy || j === sy + sh - 1);
          if (!corner && chance(0.22)) { gaps++; continue; }
          if (free(i, j)) block[I(i, j)] = B.BRICK;
        }
      }
      if (gaps < 2) { block[I(sx + 2, sy)] = B.NONE; block[I(sx + sw - 3, sy + sh - 1)] = B.NONE; }
    }
    // штабели ящиков, бочки, бетонные блоки
    for (let k = 0; k < Math.floor((w * h) / 45); k++) {
      const tx = ri(x + 2, x + w - 3), ty = ri(y + 2, y + h - 3);
      const cw = ri(1, 2), chh = ri(1, 2);
      if (rectFree(tx, ty, cw, chh)) for (let j = ty; j < ty + chh; j++) for (let i = tx; i < tx + cw; i++) block[I(i, j)] = B.CRATE;
    }
    for (let k = 0; k < 4; k++) {
      const tx = ri(x + 1, x + w - 2), ty = ri(y + 1, y + h - 2);
      if (free(tx, ty)) block[I(tx, ty)] = chance(0.6) ? B.BARREL : B.CONCRETE;
    }
  }

  for (const [bx, bw] of ax.blocks) {
    for (const [by, bh] of ay.blocks) {
      fillG(bx, by, bw, bh, G.WALK); // тротуар 2 клетки по краю квартала
      const ix = bx + 2, iy = by + 2, iw = bw - 4, ih = bh - 4;
      const r = rng();
      if (r < 0.52) blockBuildings(ix, iy, iw, ih);
      else if (r < 0.68) blockPark(ix, iy, iw, ih);
      else if (r < 0.84) blockParking(ix, iy, iw, ih);
      else blockYard(ix, iy, iw, ih);
    }
  }

  // ---------- улицы: дороги свободны для машин с водителями; деревья и бочки на тротуарах ----------
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (ground[I(x, y)] !== G.WALK || !free(x, y)) continue;
      const r = rng();
      if (r < 0.018 && !near(x, y, 3, B.TREE)) block[I(x, y)] = B.TREE;
      else if (r < 0.024 && !near(x, y, 2, B.BARREL)) block[I(x, y)] = B.BARREL;
      else if (r < 0.027) block[I(x, y)] = B.CONCRETE;
    }
  }

  // ---------- связность: всё, куда можно встать, должно быть достижимо ----------
  const walkable = k => block[k] === B.NONE && ground[k] !== G.WATER;
  const start = I(2, 2);
  function flood() {
    const reach = new Uint8Array(N);
    const q = new Int32Array(N);
    let head = 0, tail = 0;
    q[tail++] = start; reach[start] = 1;
    while (head < tail) {
      const k = q[head++];
      const x = k % W, y = (k / W) | 0;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = I(nx, ny);
        if (!reach[nk] && walkable(nk)) { reach[nk] = 1; q[tail++] = nk; }
      }
    }
    return reach;
  }
  let reach = flood();
  for (let pass = 0; pass < 300; pass++) {
    let opened = false;
    for (let k = 0; k < N && !opened; k++) {
      if (reach[k] || !walkable(k)) continue;
      const x = k % W, y = (k / W) | 0;
      for (const [dx, dy] of DIRS4) {
        const bx = x + dx, by = y + dy;
        if (!inside(bx, by)) continue;
        const bk = I(bx, by), t = block[bk];
        if (t === B.NONE || t === B.BORDER) continue;
        const touchesReach = DIRS4.some(([ex, ey]) => { const nx = bx + ex, ny = by + ey; return inside(nx, ny) && reach[I(nx, ny)]; });
        if (touchesReach) { block[bk] = B.NONE; opened = true; break; }
      }
    }
    if (!opened) break;
    reach = flood();
  }

  // ---------- прочность, стены домов, точки появления ----------
  const hp = new Float32Array(N);
  for (let k = 0; k < N; k++) hp[k] = block[k] ? BLOCKS[block[k]].hp : 0;
  for (const b of buildings) {
    let walls = 0;
    for (let j = b.y; j < b.y + b.h; j++) for (let i = b.x; i < b.x + b.w; i++) if (block[I(i, j)] === B.BRICK) walls++;
    b.walls = walls;
  }
  // появляться не на дороге (там ездят машины) и не под припаркованной машиной
  const spawnTiles = [], pickupTiles = [];
  for (let k = 0; k < N; k++) {
    if (!reach[k] || !walkable(k) || carMask[k]) continue;
    pickupTiles.push(k);
    if (owner[k] === -1 && ground[k] !== G.ROAD) spawnTiles.push(k);
  }
  let crates = 0;
  for (let k = 0; k < N; k++) if (block[k] === B.CRATE) crates++;

  return {
    seed, w: W, h: H, ground, block, hp, dmg: new Uint8Array(N), owner, keep,
    buildings, carSpawns, crates, roads: { x: ax.roads, y: ay.roads }, reach,
    spawnTiles: Int32Array.from(spawnTiles), pickupTiles: Int32Array.from(pickupTiles)
  };
}

module.exports = { generateMap, mulberry32 };
