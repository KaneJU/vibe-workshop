// 世界模組測試（以 iPhone 為準）：環境、重力、甩尾（改開車引擎）、出錯隔離、換版退回、太耗效能自動拔掉、
// 安全模式、?safe=1 逃生口、重新整理後狀態還在。
// 會改動場景，只能對測試用資料夾跑（同 smoke.mjs）：
//   rm -rf /tmp/vw-test-data && DATA_DIR=/tmp/vw-test-data PORT=5311 HOST=0.0.0.0 npm start &
//   npm run test:world      截圖輸出到 tests/out/
import { readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const lanIp = Object.values(os.networkInterfaces())
  .flat()
  .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
const BASE = process.env.LAN_BASE || `http://${lanIp}:5311`;
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：這個測試會改動場景，請對測試用資料夾（預設 :5311）跑。');
  process.exit(2);
}
const DATA_DIR = process.env.DATA_DIR || '/tmp/vw-test-data';
const KEY = readFileSync(path.join(DATA_DIR, 'access-key'), 'utf8').trim();
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ ...devices['iPhone 15'] });
const page = await context.newPage();
const errors = [];
const toasts = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  // 故意寫壞的模組會被宿主記一筆「世界模組「…」」錯誤，那是預期的
  if (m.type() === 'error' && !m.text().startsWith('世界模組「')) errors.push(`console: ${m.text()}`);
});
await page.addInitScript(() => {
  localStorage.setItem('vw_help_seen', '1');
  // 記下所有提示訊息，方便確認「出錯／太耗效能／退回」有告訴使用者
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((list) => {
      for (const r of list) for (const n of r.addedNodes) if (n.classList?.contains('toast')) (window.__toasts ||= []).push(n.textContent);
    }).observe(document.body, { childList: true, subtree: true });
  });
});
const cdp = await context.newCDPSession(page);
const ws = (fn, arg) => page.evaluate(fn, arg);
const touch = (type, pts) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })),
  });
async function holdJoystick(dx, dy, ms) {
  const b = await page.locator('#joy').boundingBox();
  const c = { x: b.x + b.width / 2, y: b.y + b.height / 2, r: b.width / 2 };
  await touch('touchStart', [c]);
  for (let i = 1; i <= 5; i += 1) {
    await touch('touchMove', [{ x: c.x + (dx * c.r * i) / 5, y: c.y + (dy * c.r * i) / 5 }]);
    await sleep(16);
  }
  await sleep(ms);
  await touch('touchEnd', []);
}
const worldState = () =>
  ws(() => ({
    ...window.__ws.worlds.state,
    active: window.__ws.worlds.host.activeIds(),
    bg: window.__ws.scene.background?.getHex?.() ?? null,
    grid: window.__ws.scene.getObjectByProperty('type', 'GridHelper')?.visible,
    roots: window.__ws.scene.getObjectByName('world-modules').children.length,
  }));
const modId = (name) => ws((n) => window.__ws.worlds.modules.find((m) => m.name === n)?.id, name);
async function openWorldTab() {
  // 抽屜收起來時只是滑到畫面外（元素還「看得見」），要用位置判斷
  if (await ws(() => document.querySelector('.panel.right').getBoundingClientRect().left >= innerWidth)) {
    await page.tap('#libToggle');
    await page.waitForTimeout(700);
  }
  if (await ws(() => document.querySelector('#tab-world').hidden)) {
    await page.tap('.panel.right [data-tab=world]');
    await page.waitForTimeout(200);
  }
}
async function closeDrawer() {
  if (!(await ws(() => document.querySelector('.panel.right').getBoundingClientRect().left >= innerWidth))) {
    await page.tap('#libToggle');
    await page.waitForTimeout(700);
  }
}
const card = (name) => page.locator('.wmod').filter({ has: page.locator('.n', { hasText: new RegExp(`^${name}$`) }) });
const DEFAULT_BG = 0x05080f;

// ---- 進場 ----
await page.goto(`${BASE}/?key=${KEY}`);
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
await openWorldTab();
check('🧰 → 🌍 世界分頁列出示範模組', (await page.locator('.wmod').count()) === 3, `${await page.locator('.wmod').count()} 個`);
await page.screenshot({ path: path.join(OUT, 'w00-list.png') });

// ---- 環境：月球星空 ----
await card('月球星空').locator('.toggle').tap();
await page.waitForFunction(() => window.__ws.worlds.state.environment, null, { timeout: 10000 });
let st = await worldState();
check('啟用「月球星空」→ 天空、地面當場換掉', st.bg !== DEFAULT_BG && st.roots > 0, `背景 #${st.bg?.toString(16)}，加了 ${st.roots} 樣東西`);
await closeDrawer();
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, 'w01-moon.png') });

// ---- 規則：重力 ----
await openWorldTab();
await card('重力微彈').locator('.toggle').tap();
await page.waitForTimeout(300);
const liftedId = await ws(() => {
  const w = window.__ws;
  const inst = [...w.instances.values()][0];
  inst.object.position.y += 2.5; // 把一個東西抬到半空
  return inst.id;
});
const up = await ws((id) => window.__ws.worldBox(window.__ws.instances.get(id)).min.y, liftedId);
await page.waitForFunction(
  (id) => window.__ws.worldBox(window.__ws.instances.get(id)).min.y < 0.05,
  liftedId,
  { timeout: 15000 },
).catch(() => {});
const down = await ws((id) => window.__ws.worldBox(window.__ws.instances.get(id)).min.y, liftedId);
check('啟用「重力微彈」→ 抬到半空的東西掉回地上', up > 2 && Math.abs(down) < 0.05, `底部 ${up.toFixed(2)} → ${down.toFixed(3)} m`);

// ---- 規則：極速甩尾（改開車引擎）----
await card('極速甩尾').locator('.toggle').tap();
await page.waitForTimeout(300);
const tuned = await ws(() => window.__ws.engine.vehicle.tuning);
check('啟用「極速甩尾」→ 開車引擎參數當場改掉', tuned.maxForward > 10 && tuned.grip < 1, `最高速 ${tuned.maxForward}、抓地力 ${tuned.grip}`);
await closeDrawer();
await page.tap('#libToggle');
await page.waitForTimeout(700);
await page.tap('.panel.right [data-tab=parts]');
await page
  .locator('.part')
  .filter({ has: page.locator('.n', { hasText: /^氮氣卡丁車$/ }) })
  .first()
  .tap();
await page.waitForTimeout(700);
await page.tap('#mobileBar [data-act=control]');
await page.waitForTimeout(300);
let maxSlip = 0;
const sampler = setInterval(async () => {
  const slip = await ws(() => {
    const s = window.__ws.engine.session;
    return s ? Math.abs(Math.atan2(Math.sin(s.yaw - s.moveYaw), Math.cos(s.yaw - s.moveYaw))) : 0;
  }).catch(() => 0);
  maxSlip = Math.max(maxSlip, slip);
}, 100);
await holdJoystick(0, -1, 1200);
await holdJoystick(0.9, -0.6, 1500);
clearInterval(sampler);
const hud = await ws(() => ({ hidden: document.querySelector('#worldHud').hidden, text: document.querySelector('#worldHud').textContent }));
check('開卡丁車轉彎 → 車頭和行進方向分開（甩尾）', maxSlip > 0.15, `最大滑移 ${((maxSlip * 180) / Math.PI).toFixed(0)}°`);
check('畫面上方顯示時速', !hud.hidden && /km|時速|速/.test(hud.text), hud.text);
await page.screenshot({ path: path.join(OUT, 'w02-drift.png') });
await page.tap('#ctlExit');
await page.waitForTimeout(300);

// ---- 停用 → 恢復原狀 ----
await openWorldTab();
await card('極速甩尾').locator('.toggle').tap();
await page.waitForTimeout(200);
const back = await ws(() => window.__ws.engine.vehicle.tuning);
check('停用「極速甩尾」→ 開車手感回到預設', back.maxForward === 10 && back.grip === 1);
await page.tap('#resetEnvBtn');
await page.waitForTimeout(200);
st = await worldState();
check('恢復預設環境 → 天空地面回到原本、月球的東西清乾淨', st.bg === DEFAULT_BG && st.grid === true && st.roots === 0 && !st.environment);

// ---- 出錯隔離：規則跑到一半丟錯 → 只拔掉它 ----
const boom = await ws(async () => {
  const w = window.__ws.worlds;
  await w.installRaw({ id: 'w_boom1', type: 'rule', name: '會爆炸的規則' }, { default: () => { let n = 0; return { update() { if (++n > 10) throw new Error('boom'); } }; } });
  return w.host.isActive('w_boom1');
});
await page.waitForFunction(() => !window.__ws.worlds.host.isActive('w_boom1'), null, { timeout: 10000 }).catch(() => {});
st = await worldState();
const t1 = await ws(() => window.__toasts || []);
check(
  '規則執行到一半出錯 → 自動停用，其他規則照跑',
  boom && !st.active.includes('w_boom1') && st.active.includes(await modId('重力微彈')) && t1.some((x) => x.includes('會爆炸的規則') && x.includes('出錯')),
);

// ---- 換版失敗退回：新環境裝不起來 → 月球留著 ----
const moonId = await modId('月球星空');
await card('月球星空').locator('.toggle').tap();
await page.waitForFunction(() => window.__ws.worlds.state.environment, null, { timeout: 10000 });
await ws(
  (moon) =>
    window.__ws.worlds.installRaw(
      { id: 'w_badenv', type: 'environment', name: '裝不起來的環境', replaces: moon },
      { default: () => { throw new Error('install 壞了'); } },
    ),
  moonId,
);
st = await worldState();
check('改版的新環境裝不起來 → 退回原本的月球', st.environment === moonId && st.active.includes(moonId) && st.bg !== DEFAULT_BG);

// ---- 換版後才出錯：跑一陣子丟錯 → 退回上一版 ----
await ws(
  (moon) =>
    window.__ws.worlds.installRaw(
      { id: 'w_lateenv', type: 'environment', name: '晚點才壞的環境', replaces: moon },
      {
        default: (world) => {
          world.env.background(0xff00ff);
          let n = 0;
          return { update() { if (++n > 20) throw new Error('later'); } };
        },
      },
    ),
  moonId,
);
const swapped = (await worldState()).environment === 'w_lateenv';
await page.waitForFunction((moon) => window.__ws.worlds.state.environment === moon, moonId, { timeout: 10000 }).catch(() => {});
st = await worldState();
check('新版環境跑一陣子出錯 → 自動退回上一版「月球星空」', swapped && st.environment === moonId && st.bg !== 0xff00ff);

// ---- 太耗效能 → 自動拔掉 ----
await page.tap('#resetEnvBtn'); // 月球地形很重，先拿掉讓畫面跑快一點
await ws(() =>
  window.__ws.worlds.installRaw(
    { id: 'w_slow', type: 'rule', name: '很慢的規則' },
    { default: () => ({ update() { const t0 = performance.now(); while (performance.now() - t0 < 12) {} } }) },
  ),
);
await page.waitForFunction(() => !window.__ws.worlds.host.isActive('w_slow'), null, { timeout: 40000 }).catch(() => {});
const t2 = await ws(() => window.__toasts || []);
check('每格要花 12 毫秒的規則 → 自動拔掉', !(await worldState()).active.includes('w_slow') && t2.some((x) => x.includes('很慢的規則') && x.includes('效能')));

// ---- 安全模式 ----
await card('月球星空').locator('.toggle').tap();
await page.waitForFunction(() => window.__ws.worlds.state.environment, null, { timeout: 10000 });
await page.tap('#safeBtn');
await page.waitForTimeout(300);
st = await worldState();
check('🛡️ 安全模式 → 所有世界模組停掉、環境回到預設', st.safeMode && st.active.length === 0 && st.bg === DEFAULT_BG);
await page.reload();
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
st = await worldState();
check('安全模式中重新整理 → 還是什麼都沒裝', st.safeMode && st.active.length === 0);
await openWorldTab();
await page.tap('#safeBtn');
await page.waitForFunction(() => window.__ws.worlds.host.activeIds().length >= 2, null, { timeout: 15000 }).catch(() => {});
st = await worldState();
check('關掉安全模式 → 月球和重力都裝回來', !st.safeMode && st.environment === moonId && st.active.includes(await modId('重力微彈')));

// ---- 重新整理：狀態還在；?safe=1 逃生口 ----
await page.reload();
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
st = await worldState();
check('重新整理 → 環境和規則都還在', st.environment === moonId && st.active.length === 2);
await page.goto(`${BASE}/?safe=1`);
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
st = await worldState();
check('網址加 ?safe=1 → 不載入任何世界模組', st.safeMode && st.active.length === 0 && st.bg === DEFAULT_BG);

const real = errors.filter((e) => !/favicon/.test(e));
check('沒有預期外的瀏覽器錯誤', real.length === 0, real.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
