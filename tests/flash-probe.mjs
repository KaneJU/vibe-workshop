// 開火閃光量測：跟 tests/record.mjs 一樣開房、拿槍、瞄準標靶開火，但在頁面裡記下「每一次真的畫出來」的閃光：
// 是哪一顆（槍口 or 命中點）、半徑、離鏡頭多遠、張角多大、蓋住畫面幾成、有沒有蓋到準星（畫面中央）。
// 同一格還會「只關掉那顆閃光再畫一次」讀回像素，比較白色像素比例——證明大白閃是哪一顆造成的。
//   node tests/flash-probe.mjs            （手機 390×844 和電腦 1280×800 各一場；用這台機器的 GPU）
//   KIND=m node tests/flash-probe.mjs     （只跑手機）
//   TOOLS=/tmp/舊版tools.mjs node tests/flash-probe.mjs   （瀏覽器改載這份 tools.mjs，用來跟修改前比；不動 public/ 的檔案）
// 只聽 127.0.0.1 的測試伺服器（預設 5322，資料放暫存資料夾）；結果印出來，也寫成 JSON（OUT 指定，預設 tests/out/flash/probe.json），
// 畫到槍口閃光的那幾格存成 PNG（只有 3D 畫面，不含 HTML 介面；準星在畫面正中央）。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5322);
if (PORT === 5310) throw new Error('不能對正式服務跑');
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(process.env.OUT || path.join(HERE, 'out', 'flash', 'probe.json'));
mkdirSync(path.dirname(OUT), { recursive: true });
const KINDS = (process.env.KIND || 'm,d').split(',');
const TOOLS_SRC = process.env.TOOLS ? readFileSync(process.env.TOOLS, 'utf8') : null;
const TAG = path.basename(OUT, '.json');
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-flash-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['--import', path.join(HERE, 'fixtures', 'seed-random.mjs'), 'server.mjs'], {
  cwd: path.join(HERE, '..'),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex' },
  stdio: 'ignore',
});
for (let i = 0; i < 60; i += 1) {
  if (await fetch(`${BASE}/api/games`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

async function client(kind) {
  const mobile = kind === 'm';
  const size = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const ctx = await browser.newContext(mobile ? { ...devices['iPhone 15'], viewport: size } : { viewport: size });
  if (TOOLS_SRC) await ctx.route('**/tools.mjs', (route) => route.fulfill({ body: TOOLS_SRC, contentType: 'text/javascript; charset=utf-8' }));
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = mobile ? await ctx.newCDPSession(page) : null;
  const c = { kind, mobile, ctx, page, size, errors };
  c.press = async (p) => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] }) : (await page.mouse.move(p.x, p.y), page.mouse.down()));
  c.move = (p) => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id: 1 }] }) : page.mouse.move(p.x, p.y));
  c.lift = () => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) : page.mouse.up());
  c.tap = async (sel) => (mobile ? page.locator(sel).first().tap() : page.locator(sel).first().click());
  return c;
}

// 瞄準（同 tests/record.mjs）：拖曳畫面把最近的標靶拉到準星
async function aim(c) {
  const cx = c.size.width / 2;
  const cy = c.size.height / 2;
  let gain = 0.25;
  for (let i = 0; i < 30; i += 1) {
    const g = await c.page.evaluate(() => window.__ws.game);
    const ups = g.targets.filter((t) => t.up && t.visible);
    if (!ups.length) {
      await sleep(150);
      continue;
    }
    const scr = await c.page.evaluate((list) => list.map((t) => ({ pos: t.pos, ...window.__ws.screenAt(t.pos[0], 0.95, t.pos[2]) })), ups);
    const pick = scr.filter((p) => !p.behind).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
    if (!pick) return false;
    const dx = pick.x - cx;
    const dy = pick.y - cy;
    if (Math.hypot(dx, dy) < (c.mobile ? 10 : 14)) return true;
    const mx = Math.max(-160, Math.min(160, dx * gain));
    const my = Math.max(-120, Math.min(120, dy * gain));
    const sy = c.size.height * 0.62;
    await c.press({ x: cx, y: sy });
    for (let k = 1; k <= 6; k += 1) {
      await c.move({ x: cx + (mx * k) / 6, y: sy + (my * k) / 6 });
      await sleep(30);
    }
    await c.lift();
    await sleep(250);
    const after = await c.page.evaluate((p) => window.__ws.screenAt(p[0], 0.95, p[2]), pick.pos);
    const moved = Math.hypot(after.x - pick.x, after.y - pick.y);
    if (moved > 1) gain = Math.max(0.05, Math.min(1.5, (0.85 * Math.hypot(mx, my)) / moved));
  }
  return false;
}

// 頁面裡：包住 renderer.render，每次畫之前記下場上的閃光，畫之後讀回像素算白色比例
function installProbe() {
  const ws = window.__ws;
  const { THREE, renderer, scene, camera } = ws;
  const gl = renderer.getContext();
  const log = (window.__flashLog = []);
  const orig = renderer.render.bind(renderer);
  const cam = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  let buf = null;
  let last = performance.now();
  let lastFired = ws.shotsFired;
  const seen = new WeakMap();
  let nextId = 1;
  // 畫面上接近白色（RGB 都 > 235）的像素比例（只算 3D 畫面，不含 HTML 介面）
  function white() {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (!buf || buf.length !== w * h * 4) buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0;
    let all = 0;
    for (let i = 0; i < buf.length; i += 4 * 3) {
      all += 1;
      if (buf[i] > 235 && buf[i + 1] > 235 && buf[i + 2] > 235) n += 1;
    }
    return n / all;
  }
  // 一顆球（中心 p、半徑 r）在畫面上蓋住幾成：每 3 px 打一條視線，看有沒有穿過球（背面剔除：鏡頭在球裡面就看不到）
  function cover(p, r) {
    camera.updateMatrixWorld();
    camera.getWorldPosition(cam);
    c.copy(p).sub(cam);
    const D = c.length();
    if (D <= r) return { D, deg: 90, cover: 0, center: false, inside: true };
    c.normalize();
    const cosA = Math.sqrt(1 - (r / D) ** 2);
    // 視線方向＝前 + nx·tw·右 + ny·th·上（鏡頭座標軸），跟球心方向的夾角 ≤ 球的張角就算蓋到
    const e = camera.matrixWorld.elements;
    const cr = d.set(e[0], e[1], e[2]).normalize().dot(c);
    const cu = d.set(e[4], e[5], e[6]).normalize().dot(c);
    const cf = -d.set(e[8], e[9], e[10]).normalize().dot(c);
    const th = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tw = th * camera.aspect;
    const W = window.innerWidth;
    const H = window.innerHeight;
    let hit = 0;
    let n = 0;
    for (let y = 1; y < H; y += 3) {
      const ny = (1 - (y / H) * 2) * th;
      for (let x = 1; x < W; x += 3) {
        const nx = ((x / W) * 2 - 1) * tw;
        n += 1;
        if ((cf + nx * cr + ny * cu) / Math.sqrt(1 + nx * nx + ny * ny) >= cosA) hit += 1;
      }
    }
    const center = cf >= cosA;
    const s = p.clone().project(camera);
    return { D, deg: THREE.MathUtils.radToDeg(Math.asin(r / D)), cover: hit / n, center, at: [Math.round(((s.x + 1) / 2) * W), Math.round(((1 - s.y) / 2) * H)] };
  }
  renderer.render = (s, cm) => {
    if (s !== scene) return orig(s, cm);
    const now = performance.now();
    const fired = ws.shotsFired;
    const flashes = scene.children.filter((o) => o.isMesh && o.visible && o.userData?.kind === 'flash');
    if (!flashes.length && fired === lastFired) {
      last = now;
      return orig(s, cm);
    }
    scene.updateMatrixWorld();
    const entry = { t: Math.round(now), dt: Math.round(now - last), fired, flashes: [] };
    for (const f of flashes) {
      if (!seen.has(f) || seen.get(f).life < f.userData.life) seen.set(f, { id: nextId++, life: f.userData.life }); // 池子重用的同一個 mesh：剩餘時間變多＝新的一顆
      seen.get(f).life = f.userData.life;
      const r = f.scale.x * (f.geometry.parameters?.radius || 1);
      // 用存活時間分辨：tools.mjs 槍口那顆 0.07 秒、命中那顆 0.2 秒
      const kind = f.userData.max <= 0.1 ? '槍口' : '命中';
      f.visible = false;
      orig(s, cm);
      const without = white();
      f.visible = true;
      entry.flashes.push({ id: seen.get(f).id, kind, life: +f.userData.life.toFixed(3), r: +r.toFixed(3), ...cover(f.position, r), without });
    }
    orig(s, cm);
    entry.white = white();
    // 畫到槍口閃光的格子：當下存一張 3D 畫面（同一個工作階段裡讀，畫面還沒被清掉）
    const shots = (window.__flashShots ||= []);
    if (entry.flashes.some((f) => f.kind === '槍口') && shots.length < 6) shots.push({ i: log.length, png: renderer.domElement.toDataURL('image/png') });
    entry.flashes.forEach((f) => {
      f.D = +f.D.toFixed(3);
      f.deg = +f.deg.toFixed(1);
      f.cover = +f.cover.toFixed(3);
      f.without = +f.without.toFixed(3);
    });
    entry.white = +entry.white.toFixed(3);
    log.push(entry);
    lastFired = fired;
    last = performance.now();
  };
}

async function scene(kind) {
  const g = (await post('/api/games', { game: { rule: { type: 'timed', seconds: 90 } } })).game;
  const room = await post('/api/rooms', { gameId: g.id });
  const A = await client(kind);
  const B = await client(kind === 'm' ? 'd' : 'm');
  await A.page.goto(`${BASE}/?room=${room.code}`);
  await A.page.waitForFunction(() => window.__ws?.game?.phase === 'lobby', null, { timeout: 60000 });
  await B.page.goto(`${BASE}/?room=${room.code}`);
  await B.page.waitForFunction(() => window.__ws?.game?.players?.length === 2, null, { timeout: 60000 });
  await sleep(800);
  await A.tap('#gameCardBtns button:has-text("開始比賽")');
  await A.page.waitForFunction(() => window.__ws.game.phase === 'playing', null, { timeout: 60000 });
  await sleep(1500);
  await A.page.evaluate(installProbe);
  const info = await A.page.evaluate(() => ({ fov: window.__ws.camera.fov, aspect: +window.__ws.camera.aspect.toFixed(3), near: window.__ws.camera.near, pr: window.__ws.renderer.getPixelRatio() }));
  let shots = 0;
  for (let n = 0; n < 3; n += 1) {
    if (await aim(A)) {
      await sleep(250);
      await A.tap('#btnAction');
      shots += 1;
      await sleep(1300);
    }
  }
  // 按住 ⚡ 連射 1.5 秒（多抓幾格槍口閃光；錄影環境一格常超過 70 ms，閃光不一定每發都畫得到）
  const btn = await A.page.locator('#btnAction').boundingBox();
  const bc = { x: btn.x + btn.width / 2, y: btn.y + btn.height / 2 };
  await A.press(bc);
  await sleep(1500);
  await A.lift();
  await sleep(800);
  await B.tap('#btnAction'); // 另一位玩家開一槍（看他的子彈落點離我多遠）
  await sleep(1200);
  const log = await A.page.evaluate(() => window.__flashLog);
  const snaps = await A.page.evaluate(() => window.__flashShots || []);
  for (const [n, sn] of snaps.entries()) {
    const e = log[sn.i];
    const m = e?.flashes.find((f) => f.kind === '槍口');
    const file = path.join(path.dirname(OUT), `${TAG}-${kind}-muzzle-${n + 1}.png`);
    writeFileSync(file, Buffer.from(sn.png.split(',')[1], 'base64'));
    if (m) m.png = path.basename(file);
  }
  const errors = [...A.errors, ...B.errors];
  await A.ctx.close();
  await B.ctx.close();
  return { kind, info, shots, log, errors };
}

const report = [];
try {
  for (const k of KINDS) report.push(await scene(k));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
writeFileSync(OUT, JSON.stringify(report, null, 1));
for (const r of report) {
  console.log(`\n== ${r.kind === 'm' ? '手機 390×844' : '電腦 1280×800'}：fov ${r.info.fov}°、aspect ${r.info.aspect}、像素比 ${r.info.pr}；開火 ${r.shots} 次；JS 錯誤 ${r.errors.length} ==`);
  for (const e of r.log) {
    if (!e.flashes.length) continue;
    const fs = e.flashes.map((f) => `${f.kind}#${f.id} 半徑 ${f.r} m、離鏡頭 ${f.D} m、張角 ${f.deg}°、蓋住 ${(f.cover * 100).toFixed(1)}%${f.center ? '、蓋到準星' : ''}${f.at ? `、中心 (${f.at})` : ''}；關掉它白色 ${(f.without * 100).toFixed(1)}%${f.png ? `（截圖 ${f.png}）` : ''}`).join(' ／ ');
    console.log(`  第 ${r.log.indexOf(e)} 筆 dt ${e.dt} ms：畫面白色 ${(e.white * 100).toFixed(1)}%｜${fs}`);
  }
  const by = {};
  for (const e of r.log) for (const f of e.flashes) {
    const b = (by[f.kind] ||= { n: 0, r: 0, cover: 0, deg: 0, center: 0, D: [Infinity, 0], white: 0 });
    b.n += 1;
    b.r = Math.max(b.r, f.r);
    b.cover = Math.max(b.cover, f.cover);
    b.deg = Math.max(b.deg, f.deg);
    b.center += f.center ? 1 : 0;
    b.D = [Math.min(b.D[0], f.D), Math.max(b.D[1], f.D)];
    b.white = Math.max(b.white, e.white);
  }
  for (const [k, b] of Object.entries(by)) console.log(`  【${k}】畫了 ${b.n} 格：最大半徑 ${b.r} m、離鏡頭 ${b.D[0]}–${b.D[1]} m、最大張角 ${b.deg}°、最多蓋住 ${(b.cover * 100).toFixed(1)}%、蓋到準星 ${b.center} 格；有它在的格子白色最多 ${(b.white * 100).toFixed(1)}%`);
}
console.log('\n詳細記錄', OUT);
