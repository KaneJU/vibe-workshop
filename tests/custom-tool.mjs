// 自己組的道具也能當遊戲道具：在自由工坊把「能量槍」和「木板」選起來存成零件（組合零件，名字用預設的、不用打字），
// 遊戲房的編輯器就會把它列在道具裡 → 選它 → 開房間 → 拿著自己組的東西射靶，伺服器照樣計分。
// 全程 iPhone 模擬真觸控；只讀狀態找東西在畫面哪裡。會改場景與工具箱，只能對測試用伺服器跑：
//   DATA_DIR=/tmp/vw-room-data PORT=5313 HOST=127.0.0.1 CODEX_BIN=/nonexistent/codex npm start &
//   BASE=http://127.0.0.1:5313 npm run test:custom-tool
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const BASE = process.env.BASE || 'http://127.0.0.1:5313';
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：這個測試會改場景和工具箱，請對測試用伺服器跑。');
  process.exit(2);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ ...devices['iPhone 15'], viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
const cdp = await ctx.newCDPSession(page);
const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] : [] });
const ws = (fn, arg) => page.evaluate(fn, arg);

// ---- 自由工坊：拿木板和能量槍，多選，存成零件 ----
await page.goto(`${BASE}/?ws`);
await page.waitForFunction(() => window.__ws?.loaded === true && window.__ws.physics.ready, null, { timeout: 30000 });
await sleep(800);
async function take(name) {
  await page.tap('#libToggle');
  const card = page.locator('#library .part', { hasText: name }).first();
  await card.waitFor({ state: 'visible' });
  await card.tap();
  await sleep(700);
  return ws(() => [...window.__ws.selection][0]);
}
const boardId = await take('木板');
const gunId = await take('能量槍');
// 東西放到畫面外了：像人一樣兩指在空白的天空捏一捏，把畫面縮小到兩個都看得到
const onScreen = async (id) => {
  const p = await ws((id) => window.__ws.screenOf(id), id);
  return p.x > 30 && p.x < 360 && p.y > 130 && p.y < 760 ? p : null;
};
const pts = (a, b) => [{ x: a.x, y: a.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }, { x: b.x, y: b.y, id: 2, radiusX: 4, radiusY: 4, force: 1 }];
for (let i = 0; i < 10 && !((await onScreen(boardId)) && (await onScreen(gunId))); i += 1) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts({ x: 60, y: 230 }, { x: 330, y: 230 }) });
  for (let k = 1; k <= 6; k += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts({ x: 60 + k * 20, y: 230 }, { x: 330 - k * 20, y: 230 }) });
    await sleep(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
}
check('兩指縮小畫面 → 木板和能量槍都看得到', !!(await onScreen(boardId)) && !!(await onScreen(gunId)));
await page.tap('#mobileBar [data-act=multi]');
const bp = await onScreen(boardId);
await page.touchscreen.tap(bp.x, bp.y);
await sleep(400);
const sel = await ws(() => [...window.__ws.selection]);
check('多選：能量槍＋木板', sel.length === 2 && sel.includes(boardId) && sel.includes(gunId), `${sel.length} 個`);
const before = await ws(() => window.__ws.library.length);
page.once('dialog', (d) => d.accept(d.defaultValue())); // 名字用預設的、直接按「好」（不用打字）
await page.tap('#mobileBar [data-act=group]');
await page.waitForFunction((n) => window.__ws.library.length > n, before, { timeout: 10000 });
const made = await ws(() => {
  const p = window.__ws.library[window.__ws.library.length - 1];
  return { id: p.id, name: p.name, kind: p.kind, children: (p.children || []).map((c) => c.partId) };
});
check('存成零件 → 工具箱多一個組合零件（裡面有能量槍）', made.kind === 'composite' && made.children.includes('p_vwblaster01'), `${made.name}：${made.children.join('、')}`);
await page.screenshot({ path: path.join(OUT, 'custom-tool-workshop.png') });

// ---- 遊戲房：編輯器的道具列出它 → 選它 → 開房間 ----
await page.goto(`${BASE}/?edit=new`);
await page.waitForSelector('#gameEditor:not([hidden])');
const opt = `.g-seg[data-name="tool.partId"] button[data-v="${made.id}"]`;
const listed = await page.locator(opt).count();
check('遊戲編輯器的「道具」列出自己組的零件（因為裡面有能量槍）', listed === 1);
await page.locator(opt).tap();
await page.tap('.g-seg[data-name="rule.goal"] button[data-v="3"]');
await sleep(400);
check('選它當這個遊戲的道具', (await ws(() => window.__ws.game.editing.tool.partId)) === made.id);
await page.screenshot({ path: path.join(OUT, 'custom-tool-editor.png') });
await page.tap('#gameTry');
await page.waitForFunction(() => window.__ws?.game?.phase === 'lobby', null, { timeout: 20000 });
await page.tap('#gameCardBtns button:has-text("開始比賽")');
await page.waitForFunction(() => window.__ws.game.phase === 'playing', null, { timeout: 20000 });
await sleep(800);
const held = await ws(() => ({ partId: window.__ws.engine.session?.inst?.partId, holding: window.__ws.game.holding }));
check('比賽開始：手上拿的是自己組的零件', held.holding && held.partId === made.id, held.partId);

// ---- 拿它射靶（拖曳瞄準、⚡），伺服器計分 ----
const cx = 195;
const cy = 422;
let score = 0;
let gain = 0.28;
const t0 = Date.now();
while (Date.now() - t0 < 60000 && score < 1) {
  const s = await ws(() => window.__ws.game);
  if (s.phase !== 'playing') break;
  const ups = s.targets.filter((t) => t.up && t.visible);
  if (!ups.length) {
    await sleep(150);
    continue;
  }
  const scr = await ws((list) => list.map((t) => ({ id: t.id, pos: t.pos, ...window.__ws.screenAt(t.pos[0], 0.95, t.pos[2]) })), ups);
  const pick = scr.filter((p) => !p.behind).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0] || scr[0];
  const dx = pick.x - cx;
  const dy = pick.y - cy;
  if (Math.hypot(dx, dy) < 12 && !pick.behind) {
    await page.tap('#btnAction');
    await sleep(1200);
    score = (await ws(() => window.__ws.game.players.find((p) => p.id === window.__ws.game.me.playerId)?.score)) || 0;
    continue;
  }
  const mx = Math.max(-160, Math.min(160, dx * gain));
  const my = Math.max(-120, Math.min(120, dy * gain));
  await touch('touchStart', { x: cx, y: 523 });
  for (let k = 1; k <= 4; k += 1) {
    await touch('touchMove', { x: cx + (mx * k) / 4, y: 523 + (my * k) / 4 });
    await sleep(16);
  }
  await touch('touchEnd');
  await sleep(260);
  const after = await ws((p) => window.__ws.screenAt(p[0], 0.95, p[2]), pick.pos);
  const moved = Math.hypot(after.x - pick.x, after.y - pick.y);
  if (moved > 1) gain = Math.max(0.05, Math.min(1.5, (0.8 * Math.hypot(mx, my)) / moved));
}
await page.screenshot({ path: path.join(OUT, 'custom-tool-hit.png') });
check('拿自己組的道具打中標靶 → 伺服器計分', score >= 1, `${score} 分`);
check('沒有 JS 錯誤', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);
