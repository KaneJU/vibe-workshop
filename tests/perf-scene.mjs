// 同一個遊戲場景的繪圖成本（前後對照用）：一個頁面、用這台機器的 GPU、解除影格上限（不等螢幕更新），
// 開房、開始、拿槍看向靶場，量 6 秒每格花多久，加上 renderer 的繪製次數、三角形、記憶體。
//   SERVER_ROOT=<版本資料夾> VIEW=m|d QUALITY=max|auto node tests/perf-scene.mjs
// 自己開只聽 127.0.0.1 的測試伺服器（5319、暫存資料夾、固定房號）。注意：這是同一台 Mac（M4）的相對比較，不是真手機數據。
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(process.env.SERVER_ROOT || path.join(HERE, '..'));
const VIEW = process.env.VIEW || 'm';
const QUALITY = process.env.QUALITY || 'max';
const PORT = 5319;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-perf-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['--import', path.join(HERE, 'fixtures', 'seed-random.mjs'), 'server.mjs'], {
  cwd: SERVER_ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex' },
  stdio: 'ignore',
});
for (let i = 0; i < 60; i += 1) {
  if (await fetch(`${BASE}/api/games`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}
// RENDERER=cpu：改用軟體繪圖（SwiftShader，很慢的裝置的代表），看自動畫質會降到哪裡
const CPU = process.env.RENDERER === 'cpu';
const browser = await chromium.launch({ args: CPU ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
try {
  const ctx = await browser.newContext(VIEW === 'm' ? { ...devices['iPhone 15'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript((q) => {
    localStorage.setItem('vw_help_seen', '1');
    if (q === 'max') localStorage.setItem('vw_quality', 'max');
  }, QUALITY);
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const g = (await post('/api/games', { game: {} })).game;
  const room = await post('/api/rooms', { gameId: g.id });
  await page.goto(`${BASE}/?room=${room.code}`);
  await page.waitForFunction(() => window.__ws?.game?.phase === 'lobby', null, { timeout: 60000 });
  await page.locator('#gameCardBtns button:has-text("開始比賽")').first().click();
  await page.waitForFunction(() => window.__ws.game.phase === 'playing', null, { timeout: 60000 });
  await sleep(1500);
  await page.evaluate(() => {
    const w = window.__ws;
    const c = w.camera;
    const d = new w.THREE.Vector3(c.position.x, 1.25, -9).sub(c.position).normalize();
    w.controls.target.copy(c.position).addScaledVector(d, 0.1);
    w.controls.update();
  });
  await sleep(QUALITY === 'auto' ? 8000 : 1500); // auto：給自動畫質時間調整
  const r = await page.evaluate(
    () =>
      new Promise((res) => {
        const d = [];
        let last = performance.now();
        const t0 = last;
        const f = (t) => {
          d.push(t - last);
          last = t;
          if (t - t0 < 6000) requestAnimationFrame(f);
          else {
            const w = window.__ws;
            const i = w.renderer.info;
            const gl = w.renderer.getContext();
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            res({ d, calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? null, pixelRatio: w.renderer.getPixelRatio(), shadows: w.renderer.shadowMap.enabled, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight] });
          }
        };
        requestAnimationFrame(f);
      }),
  );
  const d = r.d.slice(5).sort((a, b) => a - b);
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  const out = { view: VIEW, quality: QUALITY, renderer: CPU ? 'cpu' : 'gpu', serverRoot: SERVER_ROOT, frames: d.length, fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p50_ms: +q(0.5).toFixed(2), p95_ms: +q(0.95).toFixed(2), max_ms: +d[d.length - 1].toFixed(2), over_16_7ms: d.filter((v) => v > 16.7).length, over_33ms: d.filter((v) => v > 33.4).length, ...r, d: undefined };
  console.log(JSON.stringify(out));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
