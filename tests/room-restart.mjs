// 房間開著的時候伺服器重新啟動：房間在記憶體裡所以沒了，玩家要很快看到清楚的結果（不是一直「重新連線中」），
// 回大廳時遊戲定義還在。自己開一台只聽本機的測試伺服器（5314），不碰別的資料：npm run test:room-restart
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5314;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-restart-'));
const BASE = `http://127.0.0.1:${PORT}`;
const start = () => spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex' }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
let srv = start();
const up = async () => {
  for (let i = 0; i < 50; i += 1) {
    if (await fetch(`${BASE}/api/games`).then((r) => r.ok, () => false)) return true;
    await sleep(200);
  }
  return false;
};
await up();
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const g = (await post('/api/games', { game: { name: '重啟測試' } })).game;
const room = await post('/api/rooms', { gameId: g.id });
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ ...devices['iPhone 15'], viewport: { width: 390, height: 844 } })).newPage();
try {
  await page.goto(`${BASE}/?room=${room.code}`);
  await page.waitForFunction(() => window.__ws?.game?.phase === 'lobby', null, { timeout: 20000 });
  check('進到房間', true, room.code);
  srv.kill('SIGTERM');
  await sleep(1500);
  srv = start();
  await up();
  const t0 = Date.now();
  const ok = await page.waitForFunction(() => document.querySelector('#gameCardTitle')?.textContent === '房間已經關了', null, { timeout: 30000 }).then(() => true, () => false);
  check('伺服器重新啟動 → 玩家很快看到「房間已經關了」', ok, `${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  await page.screenshot({ path: path.join(ROOT, 'tests', 'out', 'coplay-m-room-closed.png') });
  await page.tap('#gameCardBtns button');
  await page.waitForSelector('#gameHub:not([hidden])', { timeout: 15000 });
  const listed = await page.waitForFunction((id) => !!document.querySelector(`.g-item.game[data-id="${id}"]`), g.id, { timeout: 10000 }).then(() => true, () => false);
  check('回遊戲房大廳：遊戲還在（可以再開房間）', listed);
} finally {
  await browser.close();
  srv.kill('SIGTERM');
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);
