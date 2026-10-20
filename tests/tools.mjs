// 道具行為可重用：在「自由工坊」（不是遊戲房）從工具箱拿能量槍和標靶，按 ▶ 操作拿在手上，
// 拖曳瞄準、按 ⚡ 射擊 → 子彈真的飛出去、打中標靶會計分、被打中的東西會被推動（物理）。
// 全程真的觸控（iPhone 模擬）；只讀狀態找東西在畫面哪裡。會改場景，只能對測試用伺服器跑：
//   DATA_DIR=/tmp/vw-room-data PORT=5313 HOST=127.0.0.1 CODEX_BIN=/nonexistent/codex npm start &
//   BASE=http://127.0.0.1:5313 npm run test:tools
const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://127.0.0.1:5313';
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：這個測試會改場景，請對測試用伺服器跑。');
  process.exit(2);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ ...devices['iPhone 15'], viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.addInitScript(() => {
  localStorage.setItem('vw_help_seen', '1');
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((list) => {
      for (const r of list) for (const n of r.addedNodes) if (n.classList?.contains('toast')) (window.__toasts ||= []).push(n.textContent);
    }).observe(document.body, { childList: true, subtree: true });
  });
});
const cdp = await ctx.newCDPSession(page);
const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] : [] });
const ws = (fn, arg) => page.evaluate(fn, arg);

await page.goto(`${BASE}/?ws`);
await page.waitForFunction(() => window.__ws?.loaded === true && window.__ws.physics.ready, null, { timeout: 30000 });
await sleep(800);
// 從工具箱拿：先拿標靶（放在前面），再拿能量槍
async function takeFromToolbox(name) {
  await page.tap('#libToggle');
  const card = page.locator('#library .part', { hasText: name }).first();
  await card.waitFor({ state: 'visible' });
  await card.tap();
  await sleep(600);
  return ws(() => [...window.__ws.selection][0]);
}
const targetId = await takeFromToolbox('標靶');
const gunId = await takeFromToolbox('能量槍');
check('工具箱裡有內建的能量槍和標靶，點一下就拿出來', !!targetId && !!gunId);
const t0 = await ws((id) => window.__ws.instances.get(id).object.position.toArray(), targetId);
// 選能量槍（剛拿出來就是選取狀態）→ ▶ 操作：拿在手上
await page.tap('#mobileBar [data-act=control]');
await page.waitForFunction(() => window.__ws.engine.active && window.__ws.engine.mode === 'wear', null, { timeout: 10000 });
await sleep(500);
check('▶ 操作 → 能量槍拿在手上、出現準星', await page.isVisible('#crosshair'), await page.textContent('#ctlHint'));
// 瞄準標靶（拖曳畫面；往右拖＝往右看）
const center = { x: 195, y: 422 };
let hit = false;
let fired = 0;
for (let i = 0; i < 40 && !hit; i += 1) {
  const sp = await ws((id) => {
    const w = window.__ws;
    const b = w.worldBox(w.instances.get(id));
    const c = b.getCenter(new w.THREE.Vector3());
    c.y = b.max.y - 0.36; // 靶心
    return w.screenAt(c.x, c.y, c.z);
  }, targetId);
  const dx = sp.x - center.x;
  const dy = sp.y - center.y;
  if (Math.hypot(dx, dy) < 10 && !sp.behind) {
    await page.tap('#btnAction');
    fired += 1;
    await sleep(900);
    hit = (await ws(() => (window.__toasts || []).some((t) => t.includes('命中')))) || false;
    continue;
  }
  const mx = Math.max(-120, Math.min(120, dx * 0.25));
  const my = Math.max(-100, Math.min(100, dy * 0.25));
  await touch('touchStart', { x: 195, y: 560 });
  for (let k = 1; k <= 4; k += 1) {
    await touch('touchMove', { x: 195 + (mx * k) / 4, y: 560 + (my * k) / 4 });
    await sleep(16);
  }
  await touch('touchEnd');
  await sleep(280);
}
await page.screenshot({ path: path.join(OUT, 'tools-workshop-hit.png') });
const toasts = await ws(() => window.__toasts || []);
check('拖曳瞄準、按 ⚡ → 子彈打中標靶，跳出「命中」計分', hit, toasts.filter((t) => t.includes('命中')).slice(-1)[0] || `射了 ${fired} 發`);
await sleep(1500);
const t1 = await ws((id) => window.__ws.instances.get(id).object.position.toArray(), targetId);
const moved = Math.hypot(t1[0] - t0[0], t1[2] - t0[2]);
const tilt = await ws((id) => new window.__ws.THREE.Vector3(0, 1, 0).applyQuaternion(window.__ws.instances.get(id).object.quaternion).y, targetId);
check('被打中的標靶真的被推動（物理）', moved > 0.05 || tilt < 0.95, `移動 ${moved.toFixed(2)} m、直立度 ${tilt.toFixed(2)}`);
// 按住 ⚡ 連射
const b = await page.locator('#btnAction').boundingBox();
const before = await ws(() => window.__ws.shotsFired);
await touch('touchStart', { x: b.x + b.width / 2, y: b.y + b.height / 2 });
await sleep(1200);
await touch('touchEnd');
const after = await ws(() => window.__ws.shotsFired);
check('按住 ⚡ 會連射（照能量槍的射速，每秒最多 4 發）', after - before >= 3 && after - before <= 7, `按住 1.2 秒射了 ${after - before} 發`);
await page.tap('#ctlExit');
await sleep(300);
check('✕ 離開 → 放下能量槍、準星消失', !(await page.isVisible('#crosshair')));
check('沒有 JS 錯誤', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);
