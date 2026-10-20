// 操作引擎測試（以 iPhone 為準）：開車、換成飛行、穿戴、選單、彈指，最後順便用電腦鍵盤開一次。
// 會改動場景，只能對測試用資料夾跑（同 smoke.mjs）：
//   rm -rf /tmp/vw-test-data && DATA_DIR=/tmp/vw-test-data PORT=5311 HOST=0.0.0.0 npm start &
//   npm run test:control      截圖輸出到 tests/out/
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
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
const cdp = await context.newCDPSession(page);
const ws = (fn, arg) => page.evaluate(fn, arg);

const center = async (sel) => {
  const b = await page.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, r: b.width / 2 };
};
const touch = (type, pts) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i + 1, radiusX: 4, radiusY: 4, force: 1 })),
  });
// 手指按住搖桿往 (dx, dy) 推（-1..1，往上是負），維持 ms 毫秒
async function holdJoystick(dx, dy, ms) {
  const c = await center('#joy');
  await touch('touchStart', [{ x: c.x, y: c.y }]);
  for (let i = 1; i <= 5; i += 1) {
    await touch('touchMove', [{ x: c.x + (dx * c.r * i) / 5, y: c.y + (dy * c.r * i) / 5 }]);
    await sleep(16);
  }
  await sleep(ms);
  await touch('touchEnd', []);
}
async function holdButton(sel, ms) {
  const c = await center(sel);
  await touch('touchStart', [{ x: c.x, y: c.y }]);
  await sleep(ms);
  await touch('touchEnd', []);
}
const session = () =>
  ws(() => {
    const s = window.__ws.engine.session;
    if (!s) return null;
    const p = s.obj.position;
    const c = window.__ws.camera.getWorldPosition(new window.__ws.THREE.Vector3());
    return {
      mode: s.mode,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: s.yaw ?? 0,
      speed: s.speed ?? 0,
      camDist: Math.hypot(c.x - p.x, c.z - p.z),
      parentIsCamera: s.obj.parent === window.__ws.camera,
      hook: !!s.hook,
    };
  });
async function spawn(name) {
  await page.tap('#libToggle');
  await page.waitForTimeout(700);
  await page
    .locator('.part')
    .filter({ has: page.locator('.n', { hasText: new RegExp(`^${name}( #\\d+)?$`) }) })
    .first()
    .tap();
  await page.waitForTimeout(700);
  return ws(() => [...window.__ws.selection][0]);
}

// ---- 進場 ----
await page.goto(`${BASE}/?key=${KEY}`);
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });

// ---- 開車 ----
const kartId = await spawn('氮氣卡丁車');
await page.tap('#mobileBar [data-act=control]');
await page.waitForTimeout(400);
const hudOk = await ws(
  () =>
    document.body.classList.contains('controlling') &&
    !document.querySelector('#ctlHud').hidden &&
    getComputedStyle(document.querySelector('.hud.bottom')).display === 'none',
);
check('▶ 操作 → 進入開車，搖桿與按鈕出現、一般介面收起', hudOk && (await page.textContent('#ctlLabel')).includes('開車'), await page.textContent('#ctlLabel'));
const s0 = await session();
const wheel0 = await ws(() => window.__ws.engine.session.obj.getObjectByName('wheel_fl')?.rotation.x ?? null);
await holdJoystick(0, -1, 1500);
const s1 = await session();
const moved = Math.hypot(s1.x - s0.x, s1.z - s0.z);
const wheel1 = await ws(() => window.__ws.engine.session.obj.getObjectByName('wheel_fl')?.rotation.x ?? null);
check('搖桿往上推 1.5 秒 → 車子往前開', moved > 2, `移動 ${moved.toFixed(2)} m`);
check('鏡頭跟在車後', s1.camDist < 10, `鏡頭離車 ${s1.camDist.toFixed(2)} m`);
check('輪子跟著轉（零件自己的操作程式）', wheel0 !== null && Math.abs(wheel1 - wheel0) > 1, `wheel_fl ${wheel0?.toFixed(2)} → ${wheel1?.toFixed(2)}`);
await page.screenshot({ path: path.join(OUT, 'c01-drive.png') });
const yaw0 = (await session()).yaw;
await holdJoystick(0.75, -0.75, 1200);
const s2 = await session();
check('搖桿往右上 → 右轉', yaw0 - s2.yaw > 0.3, `車頭轉了 ${(((yaw0 - s2.yaw) * 180) / Math.PI).toFixed(0)}°`);
await page.tap('#btnAction');
await page.waitForTimeout(120);
const flame = await ws(() => {
  let on = false;
  window.__ws.engine.session.obj.traverse((o) => {
    if (/火焰|flame|plume|nitro/i.test(o.name) && o.visible) on = true;
  });
  return on;
});
check('按 ⚡ → 噴出氮氣火焰', flame);
await page.waitForTimeout(2500); // 放開搖桿後車子會滑行一段，等它慢下來
const preExit = await session();
await page.tap('#ctlExit');
await page.waitForTimeout(400);
const parked = await ws((id) => {
  const o = window.__ws.instances.get(id).object;
  return { x: o.position.x, z: o.position.z, controlling: document.body.classList.contains('controlling') };
}, kartId);
const drift = Math.hypot(parked.x - preExit.x, parked.z - preExit.z);
const fromStart = Math.hypot(parked.x - s0.x, parked.z - s0.z);
check(
  '✕ 離開 → 回到一般畫面，車子停在開到的地方',
  !parked.controlling && drift < 1 && fromStart > 5,
  `離開時還在滑 ${drift.toFixed(2)} m、離起點 ${fromStart.toFixed(1)} m`,
);

// ---- 換模式：讓卡丁車飛 ----
await page.tap('#mobileBar [data-act=control]');
await page.waitForTimeout(300);
await page.tap('#ctlSwitch');
await page.waitForTimeout(200);
check('換模式 → 跳出「要怎麼操作它？」', await page.isVisible('#ctlChooser'));
await page.screenshot({ path: path.join(OUT, 'c04-chooser.png') });
await page.tap('#ctlChooser [data-mode=fly]');
await page.waitForTimeout(300);
check('選 🛸 飛行 → 出現 ▲▼', (await page.isVisible('#btnUp')) && (await page.isVisible('#btnDown')));
const f0 = await session();
await holdButton('#btnUp', 1300);
const f1 = await session();
check('按住 ▲ → 升空', f1.y - f0.y > 1.5, `高度 ${f0.y.toFixed(2)} → ${f1.y.toFixed(2)} m`);
await holdJoystick(0, -1, 800);
await page.screenshot({ path: path.join(OUT, 'c02-fly.png') });
await page.tap('#ctlExit');
await page.waitForTimeout(400);
const landed = await ws((id) => window.__ws.worldBox(window.__ws.instances.get(id)).min.y, kartId);
check('離開 → 降回地面', Math.abs(landed) < 0.05, `底部 ${landed.toFixed(3)} m`);

// ---- 穿戴 ----
const gloveId = await spawn('鋼鐵手套');
await page.tap('#mobileBar [data-act=control]');
await page.waitForTimeout(400);
const w0 = await session();
check('▶ 操作 → 手套戴在手上（跟著鏡頭）', w0?.mode === 'wear' && w0.parentIsCamera && (await page.isVisible('#btnSpin')));
await page.tap('#btnAction');
await page.waitForTimeout(500);
check('按 ⚡ → 手套自己的動作程式正常（握拳）', (await session()).hook === true);
const camA = await ws(() => window.__ws.camera.position.clone().toArray());
await holdJoystick(0, -1, 1000);
const camB = await ws(() => window.__ws.camera.position.clone().toArray());
check('戴著手套用搖桿走路', Math.hypot(camB[0] - camA[0], camB[2] - camA[2]) > 1);
await page.screenshot({ path: path.join(OUT, 'c03-wear.png') });
const q0 = await ws(() => window.__ws.engine.session.obj.quaternion.toArray());
await page.tap('#btnSpin');
const q1 = await ws(() => window.__ws.engine.session.obj.quaternion.toArray());
check('⟲ 轉一下手上的東西', q0.some((v, i) => Math.abs(v - q1[i]) > 0.01));
await page.tap('#ctlExit');
await page.waitForTimeout(400);
// 物理開著時手套是「掉」回地上的：等它停穩再量（軟體算圖每秒只有幾格，掉落比真機慢）
await page
  .waitForFunction((id) => {
    const w = window.__ws;
    return !w.physics?.ready || w.physics.bodyOf(w.instances.get(id))?.sleeping;
  }, gloveId, { timeout: 8000 })
  .catch(() => {});
const back = await ws((id) => {
  const o = window.__ws.instances.get(id).object;
  return { inWorld: o.parent?.name === 'world', scale: o.scale.x, bottom: window.__ws.worldBox(window.__ws.instances.get(id)).min.y };
}, gloveId);
// 物理開著時手套落地會躺平，外框底部會略低於 0；在 ±8 公分內就是「放回地上」
check('離開 → 手套放回地上、恢復原本大小', back.inWorld && Math.abs(back.scale - 1) < 1e-6 && Math.abs(back.bottom) < 0.08, JSON.stringify(back));

// ---- 沒宣告的東西 → 跳出選單 ----
await ws(() => window.__ws.clearSelection());
const cubeId = await spawn('藍光能量方塊');
await page.tap('#mobileBar [data-act=control]');
await page.waitForTimeout(300);
check('不知道怎麼操作的東西 → 讓你選模式', await page.isVisible('#ctlChooser'));
await page.tap('#ctlChooser [data-mode=wear]');
await page.waitForTimeout(300);
check('選 🧤 穿戴 → 方塊也能拿在手上', (await session())?.mode === 'wear');

// ---- 彈指（無限手套）：一半的東西化成灰，5 秒後回來 ----
const total = await ws(() => window.__ws.instances.size);
await ws((id) => {
  const w = window.__ws;
  w.stopControl();
  w.engine.start(w.instances.get(id), 'wear', { name: '無限手套' });
  w.engine.pressAction(true);
  w.engine.pressAction(false);
}, cubeId);
await page.waitForTimeout(400);
const hidden = await ws(() => [...window.__ws.instances.values()].filter((i) => !i.object.visible).length);
const expected = Math.floor((total - 1) / 2);
check('無限手套彈指 → 一半的東西消失', hidden === expected, `${hidden}／${total - 1}`);
await page.waitForTimeout(5300);
const hiddenAfter = await ws(() => [...window.__ws.instances.values()].filter((i) => !i.object.visible).length);
check('5 秒後全部回來', hiddenAfter === 0);
await ws(() => window.__ws.stopControl() ?? window.__ws.engine.stop());
await page.waitForTimeout(200);
check('結束後沒有東西卡在手上', (await session()) === null);

// ---- 重新整理：位置有存起來 ----
await page.waitForTimeout(700);
const kartBefore = await ws((id) => window.__ws.instances.get(id).object.position.toArray(), kartId);
await page.reload();
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
const kartAfter = await ws((id) => window.__ws.instances.get(id)?.object.position.toArray(), kartId);
check('重新整理後，車子還在開過去的位置', !!kartAfter && Math.hypot(kartAfter[0] - kartBefore[0], kartAfter[2] - kartBefore[2]) < 0.05);

// ---- 電腦鍵盤（次要） ----
// 先關掉手機頁：兩頁同時開著，兩邊都在跑物理、都在存檔（使用上也一樣，同一時間只開一台）
await page.close();
const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } });
desk.on('pageerror', (e) => errors.push(`desktop pageerror: ${e.message}`));
await desk.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
await desk.goto(BASE.replace(lanIp, 'localhost'));
await desk.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
await desk.evaluate((id) => {
  window.__ws.selectOnly(id);
  window.__ws.openControl();
}, kartId);
const d0 = await desk.evaluate(() => window.__ws.engine.session.obj.position.toArray());
await desk.keyboard.down('w');
// 軟體算圖每秒只有幾格：等它真的開出 1 公尺，不死等固定時間
await desk
  .waitForFunction((p) => { const o = window.__ws.engine.session?.obj.position; return o && Math.hypot(o.x - p[0], o.z - p[2]) > 1; }, d0, { timeout: 10000 })
  .catch(() => {});
await desk.keyboard.up('w');
const d1 = await desk.evaluate(() => window.__ws.engine.session.obj.position.toArray());
await desk.keyboard.press('Escape');
check('電腦：按住 W 開車、Esc 離開', Math.hypot(d1[0] - d0[0], d1[2] - d0[2]) > 1 && !(await desk.evaluate(() => window.__ws.engine.active)));

const real = errors.filter((e) => !/favicon/.test(e));
check('沒有瀏覽器錯誤', real.length === 0, real.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
