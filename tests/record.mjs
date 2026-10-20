// 操作錄影：手機（390×844）和電腦（1280×800）各錄一段「拿槍 → 用搖桿走幾步 → 拖曳瞄準 → ⚡ 開火 → 命中、得分」，
// 讓人看持槍、移動、射擊、命中的時間關係（截圖看不出手感）。另一位玩家同時在房間裡，所以畫面中看得到他。
//   SERVER_ROOT=<版本資料夾> OUT=<輸出資料夾> node tests/record.mjs      （用這台機器的 GPU；只聽 127.0.0.1 的測試伺服器 5321）
// 全程真的輸入：搖桿、拖曳畫面、點 ⚡；只讀狀態找標靶在畫面哪裡。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(process.env.SERVER_ROOT || path.join(HERE, '..'));
const OUT = path.resolve(process.env.OUT || path.join(HERE, 'out', 'visual-video'));
const PORT = 5321;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-record-'));
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
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

async function client(kind, video) {
  const mobile = kind === 'm';
  const size = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const ctx = await browser.newContext({ ...(mobile ? { ...devices['iPhone 15'], viewport: size } : { viewport: size }), ...(video ? { recordVideo: { dir: OUT, size } } : {}) });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
  const cdp = mobile ? await ctx.newCDPSession(page) : null;
  const c = { kind, mobile, ctx, page, size };
  c.press = async (p) => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] }) : (await page.mouse.move(p.x, p.y), page.mouse.down()));
  c.move = (p) => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id: 1 }] }) : page.mouse.move(p.x, p.y));
  c.lift = () => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) : page.mouse.up());
  c.tap = async (sel) => (mobile ? page.locator(sel).first().tap() : page.locator(sel).first().click());
  return c;
}

// 瞄準：拖曳畫面把最近的標靶拉到準星（看標靶實際移到哪再修正）
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

async function scene(kind) {
  const g = (await post('/api/games', { game: { rule: { type: 'timed', seconds: 90 } } })).game;
  const room = await post('/api/rooms', { gameId: g.id });
  const A = await client(kind, true);
  const B = await client(kind === 'm' ? 'd' : 'm', false); // 另一位玩家（不錄）
  await A.page.goto(`${BASE}/?room=${room.code}`);
  await A.page.waitForFunction(() => window.__ws?.game?.phase === 'lobby', null, { timeout: 60000 });
  await B.page.goto(`${BASE}/?room=${room.code}`);
  await B.page.waitForFunction(() => window.__ws?.game?.players?.length === 2, null, { timeout: 60000 });
  await sleep(800);
  await A.tap('#gameCardBtns button:has-text("開始比賽")');
  await A.page.waitForFunction(() => window.__ws.game.phase === 'playing', null, { timeout: 60000 });
  await sleep(1500);
  // 用搖桿往右走兩步（看得到槍跟著晃、往另一位玩家那邊走）
  const joy = await A.page.locator('#joy').boundingBox();
  const jc = { x: joy.x + joy.width / 2, y: joy.y + joy.height / 2 };
  await A.press(jc);
  for (let k = 1; k <= 8; k += 1) {
    await A.move({ x: jc.x + (A.mobile ? 40 : 45) * (k / 8), y: jc.y - 10 * (k / 8) });
    await sleep(60);
  }
  await sleep(1200);
  await A.lift();
  await sleep(500);
  // 瞄準、開火 3 次（每次都看命中、標靶倒下、+1）
  for (let n = 0; n < 3; n += 1) {
    if (await aim(A)) {
      await sleep(250);
      await A.tap('#btnAction');
      await sleep(1300);
    }
  }
  // 另一位玩家也開一槍（他的角色後座、子彈從他那邊飛出來）
  await B.tap('#btnAction');
  await sleep(1200);
  const path0 = await A.page.video().path();
  await A.ctx.close();
  await B.ctx.close();
  const name = path.join(OUT, `${kind}-play.webm`);
  renameSync(path0, name);
  console.log('video', name);
}

try {
  await scene('m');
  await scene('d');
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
console.log(readdirSync(OUT).join('\n'));
