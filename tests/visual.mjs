// 外觀前後對照：用同一份腳本、同樣的遊戲設定、同一個房號（標靶位置一樣）、同樣的視角與畫面大小，
// 拍手機 390×844 和電腦 1280×800 的畫面，並量同一個場景的 frame time 與 renderer 資源。
//   SERVER_ROOT=<要拍的版本的資料夾> OUT=<輸出資料夾> npm run visual
// 自己開一台只聽 127.0.0.1 的測試伺服器（預設 5316、全新的暫存資料夾、Codex 不存在），
// 用 tests/fixtures/seed-random.mjs 讓房號固定；正式服務不受影響。
// 鏡頭方向在拍照時直接設定（為了前後同一個角度）；操作本身（開房、加入、開始、開火）都是真的點按鈕。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(process.env.SERVER_ROOT || path.join(HERE, '..'));
const OUT = path.resolve(process.env.OUT || path.join(HERE, 'out', 'visual'));
const PORT = Number(process.env.PORT || 5316);
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-visual-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const server = spawn(process.execPath, ['--import', path.join(HERE, 'fixtures', 'seed-random.mjs'), 'server.mjs'], {
  cwd: SERVER_ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex' },
  stdio: 'ignore',
});
for (let i = 0; i < 60; i += 1) {
  if (await fetch(`${BASE}/api/games`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}

// GPU=1：用這台機器的顯示卡（Mac 是 Metal）；預設用軟體繪圖（SwiftShader，跟其他測試一樣）
const GPU = process.env.GPU === '1';
const browser = await chromium.launch({ args: GPU ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const report = { serverRoot: SERVER_ROOT, at: new Date().toISOString(), renderer: GPU ? 'gpu (ANGLE Metal)' : 'swiftshader (CPU)', shots: [], perf: {} };

async function client(kind) {
  const mobile = kind === 'm';
  const ctx = await browser.newContext(mobile ? { ...devices['iPhone 15'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  // 前後對照要同樣的畫質：固定最高畫質（舊版沒有自動畫質，這個設定對它沒影響）
  await page.addInitScript(() => {
    localStorage.setItem('vw_help_seen', '1');
    localStorage.setItem('vw_quality', 'max');
  });
  const c = { kind, mobile, page, errors: [] };
  page.on('pageerror', (e) => c.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && c.errors.push(`console: ${m.text()}`));
  page.setDefaultTimeout(90000);
  c.tap = async (sel) => {
    const loc = page.locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout: 20000 });
    if (mobile) await loc.tap();
    else await loc.click();
  };
  c.shot = async (name, wait = 700) => {
    await sleep(wait);
    const file = path.join(OUT, `${kind}-${name}.png`);
    await page.screenshot({ path: file });
    report.shots.push(file);
  };
  c.wait = (fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
  c.st = () => page.evaluate(() => window.__ws?.game);
  // 拍照用的鏡頭：站在原地，轉向某一點（第一人稱拿槍時，轉動中心在眼前 10 公分）
  c.lookAt = (p) =>
    page.evaluate((p) => {
      const w = window.__ws;
      const T = w.THREE;
      const cam = w.camera;
      const dir = new T.Vector3(p[0], p[1], p[2]).sub(cam.position).normalize();
      w.controls.target.copy(cam.position).addScaledVector(dir, w.engine.active ? 0.1 : 4);
      cam.lookAt(w.controls.target);
      w.controls.update();
    }, p);
  // 同一個場景量 5 秒：每格花多久、掉格、renderer 資源
  c.perf = async (label, seconds = 5) => {
    const r = await page.evaluate(
      (ms) =>
        new Promise((res) => {
          const d = [];
          let last = performance.now();
          const t0 = last;
          const f = (t) => {
            d.push(t - last);
            last = t;
            if (t - t0 < ms) requestAnimationFrame(f);
            else {
              const i = window.__ws.renderer.info;
              const gl = window.__ws.renderer.getContext();
              const ext = gl.getExtension('WEBGL_debug_renderer_info');
              res({ d, info: { geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? null, calls: i.render.calls, triangles: i.render.triangles, pixelRatio: window.__ws.renderer.getPixelRatio(), shadows: window.__ws.renderer.shadowMap.enabled, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null } });
            }
          };
          requestAnimationFrame(f);
        }),
      seconds * 1000,
    );
    const d = r.d.slice(2).sort((a, b) => a - b);
    const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
    const budget = mobile ? 1000 / 30 : 1000 / 60;
    const stats = {
      frames: d.length,
      fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1),
      p50: +q(0.5).toFixed(1),
      p95: +q(0.95).toFixed(1),
      max: +d[d.length - 1].toFixed(1),
      over_budget: d.filter((v) => v > budget * 1.5).length,
      ...r.info,
    };
    report.perf[`${kind}-${label}`] = stats;
    log(`perf ${kind}-${label}`, JSON.stringify(stats));
    return stats;
  };
  return c;
}

let M = null;
let D = null;
try {
  M = await client('m');
  D = await client('d');
  // ---- 首頁 ----
  for (const c of [M, D]) {
    await c.page.goto(`${BASE}/`);
    await c.page.waitForSelector('#title:not([hidden])');
    await c.shot('01-title', 2500);
  }
  // ---- 手機做遊戲（預設設定）→ 開房間 ----
  await M.tap('#titleGames');
  await M.page.waitForSelector('#gameHub:not([hidden])');
  await M.shot('02-hub', 1500);
  await M.tap('#gameNew');
  await M.page.waitForSelector('#gameEditor:not([hidden])');
  await M.shot('03-editor', 2000);
  await M.tap('#gameTry');
  await M.wait(() => window.__ws?.game?.phase === 'lobby');
  // ---- 電腦點房間加入 ----
  await D.tap('#titleGames');
  await D.page.waitForSelector('#gameHub:not([hidden])');
  const code = (await M.st()).me.code;
  await D.wait((code) => !!document.querySelector(`.g-item.join[data-code="${code}"]`), code);
  await D.shot('02-hub-room', 600);
  await D.tap(`.g-item.join[data-code="${code}"]`);
  await D.wait(() => window.__ws?.game?.phase === 'lobby' && window.__ws.game.players.length === 2);
  await M.shot('04-lobby', 1200);
  await D.shot('04-lobby', 1200);
  report.room = code;
  // ---- 開始：兩邊拿槍 ----
  await M.tap('#gameCardBtns button:has-text("開始比賽")');
  await M.wait(() => window.__ws.game.phase === 'playing');
  await D.wait(() => window.__ws.game.phase === 'playing');
  await sleep(1500);
  const targets = (await M.st()).targets.map((t) => ({ id: t.id, pos: t.pos }));
  report.targets = targets;
  // 持槍：站在出生點看向靶場中間
  for (const c of [M, D]) {
    const me = await c.page.evaluate(() => window.__ws.camera.position.toArray());
    await c.lookAt([me[0], 1.25, -9]);
    await c.shot('05-hold', 900);
  }
  // 多人同場：轉身看對方
  {
    const mp = await M.page.evaluate(() => window.__ws.camera.position.toArray());
    const dp = await D.page.evaluate(() => window.__ws.camera.position.toArray());
    await M.lookAt([dp[0], 1.1, dp[2] - 0.3]);
    await D.lookAt([mp[0], 1.1, mp[2] - 0.3]);
    await M.shot('06-friend', 900);
    await D.shot('06-friend', 900);
  }
  // 效能：同一個持槍畫面，量 5 秒
  for (const c of [M, D]) {
    const me = await c.page.evaluate(() => window.__ws.camera.position.toArray());
    await c.lookAt([me[0], 1.25, -9]);
  }
  await M.perf('hold');
  await D.perf('hold');
  // ---- 開火／命中：對準 t1 的靶心，按 ⚡，連拍 ----
  const t1 = targets[0];
  for (const c of [M, D]) {
    await c.lookAt([t1.pos[0], 0.95, t1.pos[2]]);
    await sleep(700);
    await c.tap('#btnAction');
    for (const [i, ms] of [[1, 60], [2, 160], [3, 420]]) {
      await sleep(ms);
      const file = path.join(OUT, `${c.kind}-07-fire-${i}.png`);
      await c.page.screenshot({ path: file });
      report.shots.push(file);
    }
    await sleep(1200);
  }
  // 連射之後資源有沒有一直變多：按住 ⚡ 4 秒，前後各量一次
  const before = await M.page.evaluate(() => { const i = window.__ws.renderer.info; return { geometries: i.memory.geometries, textures: i.memory.textures }; });
  const b = await M.page.locator('#btnAction').boundingBox();
  const cdp = await M.page.context().newCDPSession(M.page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }] });
  await sleep(4000);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(2500);
  const after = await M.page.evaluate(() => { const i = window.__ws.renderer.info; return { geometries: i.memory.geometries, textures: i.memory.textures, fired: window.__ws.shotsFired ?? null }; });
  report.burst = { before, after };
  log('burst resources', JSON.stringify(report.burst));
  await M.perf('after-burst');
} finally {
  report.errors = { m: M?.errors, d: D?.errors };
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  server.kill('SIGTERM');
}
log('saved', OUT);
