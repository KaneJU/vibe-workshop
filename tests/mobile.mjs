// 手機版測試：模擬 iPhone 從區網連進來（通行碼 → 抽屜 → 工具箱拿零件 → 觸控拖曳 → 多選存成零件 → 復原）
// 會改動場景，只能對測試用資料夾跑（同 smoke.mjs）：
//   rm -rf /tmp/vw-test-data && DATA_DIR=/tmp/vw-test-data PORT=5311 HOST=0.0.0.0 npm start &
//   npm run test:mobile      （預設連本機第一個區網 IP；要指定就設 LAN_BASE）
import { readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright'; // devDependency；需要先 npx playwright install chromium
const { chromium, devices } = await import(PW);
// 要測「區網來的連線」，所以不能用 localhost，改連本機的區網 IP
const lanIp = Object.values(os.networkInterfaces())
  .flat()
  .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
const BASE = process.env.LAN_BASE || `http://${lanIp}:5311`;
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：這個測試會改動場景，請對資料複本（預設 :5311）跑。');
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

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ ...devices['iPhone 15'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
page.on('dialog', (d) => d.accept('手機組合'));
await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
const cdp = await context.newCDPSession(page);
const ws = (fn, arg) => page.evaluate(fn, arg);
const count = () => ws(() => window.__ws.instances.size);
const selCount = () => ws(() => window.__ws.selection.size);
const offscreen = (sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return r.right <= 0 || r.left >= innerWidth;
  }, sel);
async function touchDrag(from, to, steps = 14) {
  const pt = (p) => [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) });
  for (let i = 1; i <= steps; i += 1) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(p) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// 1) 沒通行碼會被擋
const denied = await page.goto(BASE);
check('沒通行碼 → 顯示需要通行碼', denied.status() === 401 && (await page.textContent('body')).includes('通行碼'));
errors.length = 0; // 上一步的 401 是預期的

// 2) 帶通行碼進來
await page.goto(`${BASE}/?physics=0&key=${KEY}`); // 經典模式的觸控拖曳疊放；物理模式的觸控在 tests/physics.mjs
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
check('帶通行碼進入，網址列不留通行碼', !page.url().includes('key='), page.url());
check('左右面板收起來、不擋畫面', (await offscreen('.panel.left')) && (await offscreen('.panel.right')));
check('非安全連線隱藏 🎙、提示用鍵盤聽寫', (await page.isHidden('#micBtn')) && (await page.getAttribute('#prompt', 'placeholder')).includes('聽寫'));
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, 'm01-home.png') });
const start = await count();

// 3) 🧰 → 工具箱抽屜 → 拿一個方塊
await page.tap('#libToggle');
await page.waitForTimeout(800);
check('點 🧰 打開工具箱', !(await offscreen('.panel.right')));
await page.screenshot({ path: path.join(OUT, 'm02-toolbox.png') });
await page
  .locator('.part')
  .filter({ has: page.locator('.n', { hasText: /^藍光能量方塊$/ }) })
  .first()
  .tap();
const drawerClosed = await page
  .waitForFunction(() => document.querySelector('.panel.right').getBoundingClientRect().left >= innerWidth, null, { timeout: 3000 })
  .then(() => true, () => false);
check('點零件 → 放進場景、抽屜自動收起', (await count()) === start + 1 && drawerClosed);
check('選取時上方出現動作列', await page.isVisible('#mobileBar'));
await page.screenshot({ path: path.join(OUT, 'm03-selected.png') });

// 4) 觸控拖曳：把新方塊拖到另一個物件上
const ids = await ws(() => [...window.__ws.instances.keys()]);
const cube = await ws(() => [...window.__ws.selection][0]);
const target = ids.find((id) => id !== cube);
const before = await ws((id) => window.__ws.worldBox(window.__ws.instances.get(id)).min.y, cube);
const from = await ws((id) => window.__ws.screenOf(id, 'center'), cube);
const to = await ws((id) => window.__ws.screenOf(id, 'top'), target);
await touchDrag(from, to);
await page.waitForTimeout(300);
const after = await ws(
  ([c, t]) => {
    const w = window.__ws;
    return { cubeBottom: w.worldBox(w.instances.get(c)).min.y, targetTop: w.worldBox(w.instances.get(t)).max.y };
  },
  [cube, target],
);
check(
  '手指拖曳物件 → 疊到另一個上面（不會變成轉視角）',
  after.cubeBottom > before + 0.2,
  `底部 ${before.toFixed(2)} → ${after.cubeBottom.toFixed(2)} m（目標頂 ${after.targetTop.toFixed(2)} m）`,
);

// 5) 多選 → 點另一個 → 存成零件 → 復原
await page.tap('#mobileBar [data-act=multi]');
const tp = await ws((id) => window.__ws.screenOf(id, 'center'), target);
await page.touchscreen.tap(tp.x, tp.y);
await page.waitForTimeout(200);
check('多選模式點第二個 → 選了 2 個', (await selCount()) === 2);
const libBefore = await ws(() => window.__ws.library.length);
await page.tap('#mobileBar [data-act=group]');
await page.waitForTimeout(800);
check('動作列「存成零件」', (await ws(() => window.__ws.library.length)) === libBefore + 1 && (await count()) === start);
await page.tap('#mobileBar [data-act=undo]');
await page.waitForTimeout(300);
check('動作列「↶」復原', (await count()) === start + 1);
await page.tap('#mobileBar [data-act=multi]'); // 關掉多選

// 6) ☰ 打造進度抽屜
await page.tap('#selToggle');
await page.waitForTimeout(800);
check('點 ☰ 打開選取／進度面板', !(await offscreen('.panel.left')));
await page.screenshot({ path: path.join(OUT, 'm04-panel.png') });

const real = errors.filter((e) => !/favicon/.test(e));
check('沒有瀏覽器錯誤', real.length === 0, real.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
