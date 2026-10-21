// 眼鏡模式（瀏覽器）測試。自己開只聽 127.0.0.1 的測試伺服器（暫存資料夾、Codex 不存在），不碰正式 5310。
// A. 合成手勢（直接注入關鍵點，只算狀態機／接線測試）：進出眼鏡模式、雙眼不同視點與投影、每格物理只更新一次、
//    轉頭、捏住抓 → 移動 → 放下、追丟安全放下（不甩）、視線按鈕離開、存檔重開、反覆進出不累積
// B. 真模型推論：Chromium 假鏡頭播放 tests/fixtures/hands 的影像（不是 iPhone 後鏡頭），worker 裡跑 MediaPipe：
//    辨識得到手、張開／捏住的捏合比分得開、全部連線只到本機、切背景暫停／恢復只開一條串流、離開時鏡頭與 worker 全關
// C. 伺服器沒有模型檔：顯示原因、工坊照常能用
//   node tests/headset.mjs          輸出 tests/out/headset/（截圖、report.json）
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'out', 'headset');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = { at: new Date().toISOString(), checks: results, notes: {} };
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const SW = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];

const tmpDirs = [];
const servers = [];
async function startServer(port, env = {}) {
  const data = mkdtempSync(path.join(os.tmpdir(), 'vw-headset-'));
  tmpDirs.push(data);
  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, CODEX_BIN: '/nonexistent/codex', ...env },
    stdio: 'ignore',
  });
  servers.push(srv);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i += 1) {
    if (await fetch(`${base}/api/state`).then((r) => r.ok, () => false)) return base;
    await sleep(200);
  }
  throw new Error(`測試伺服器 ${port} 沒有起來`);
}
function cleanup() {
  for (const s of servers) s.kill();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
}

const LANDSCAPE = { ...devices['iPhone 15 landscape'], viewport: { width: 844, height: 390 } };

async function openWorkshop(browser, base, ctxOpts = {}) {
  const ctx = await browser.newContext({ ...LANDSCAPE, ...ctxOpts });
  const page = await ctx.newPage();
  // 註：Playwright 的 landscape 裝置回報螢幕角度 0°，截圖時也會重設裝置模擬；所以模擬的動作感測一律依「當下的螢幕角度」反解
  //（橫放 iPhone 90° 的公式在 tests/headset-unit.mjs 驗）
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // MediaPipe 的 WASM 把 INFO 訊息寫到 console.error（例如「Created TensorFlow Lite XNNPACK delegate」），不算錯誤
  page.on('console', (m) => m.type() === 'error' && !/^INFO:|XNNPACK/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await page.addInitScript(() => {
    // 記下每一條 getUserMedia 交出來的串流：用真的 MediaStreamTrack.readyState 檢查有沒有被關掉（不只看 tracker 的狀態）
    window.__gum = [];
    const md = navigator.mediaDevices;
    if (md?.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async (c) => {
        const st = await orig(c);
        window.__gum.push(st);
        return st;
      };
    }
    window.__trackStates = () => window.__gum.map((st) => st.getTracks().map((t) => t.readyState).join('+'));
    localStorage.setItem('vw_help_seen', '1');
    // 跟 iPhone Safari 一樣沒有元素全螢幕（不然 Chromium 會全螢幕＋鎖方向，模擬的螢幕角度跟著變）
    Element.prototype.requestFullscreen = undefined;
  });
  page.setDefaultTimeout(60000);
  await page.goto(`${base}/?ws`);
  await page.waitForFunction(() => window.__ws?.loaded && window.__ws.instances.size > 0 && window.__ws.physics.ready);
  await page.addScriptTag({ content: HAND_HELPERS });
  return { ctx, page, errors };
}

// 每格計數：主迴圈跑了幾格、物理 update 被叫幾次、兩眼畫了幾次
async function frameCounts(page, n = 30) {
  return page.evaluate(async (n) => {
    const ws = window.__ws;
    const ph = ws.physics;
    const orig = ph.update;
    let calls = 0;
    ph.update = function wrapped(...a) {
      calls += 1;
      return orig.apply(this, a);
    };
    const eyes0 = ws.headset.state().stereo?.eyesRendered ?? 0;
    let frames = 0;
    await new Promise((res) => {
      const tick = () => {
        frames += 1;
        if (frames >= n) res();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    ph.update = orig;
    const eyes1 = ws.headset.state().stereo?.eyesRendered ?? 0;
    return { frames, physCalls: calls, eyes: eyes1 - eyes0 };
  }, n);
}

// 在頁面裡：做一隻合成的手（張開 open=1／捏住 open=0），讓「眼睛 → 捏點」的射線穿過 target（世界座標）
const HAND_HELPERS = `
  window.__hand = async (open, target, nudge = [0, 0]) => {
    const { analyzeHand, intrinsics } = await import('/hands.mjs');
    const THREE = window.__ws.THREE;
    const st = window.__ws.headset.state();
    const settings = window.__ws.headset.settings.cam;
    const size = 0.22;
    const k = 0.09;
    const make = (cx, cy) => {
      const lm = new Float32Array(63);
      const world = new Float32Array(63);
      const set = (i, x, y) => { lm.set([cx + x * size, cy + y * size, 0], i * 3); world.set([x * k, -y * k, 0], i * 3); };
      set(0, 0, 0.5); set(5, -0.25, -0.4); set(9, 0, -0.5); set(13, 0.2, -0.45); set(17, 0.38, -0.35);
      const gap = 0.12 + open * 0.68;
      set(8, -0.3, -1.05); set(4, -0.3 - gap * 0.8, -1.05 + gap * 0.6);
      for (const i of [1, 2, 3, 6, 7, 10, 11, 12, 14, 15, 16, 18, 19, 20]) set(i, 0, 0);
      return { lm, world, handedness: 'Right', score: 0.95 };
    };
    const cam = { ...settings, width: 640, height: 480 };
    const a = analyzeHand(make(0.5, 0.5), cam);
    const intr = intrinsics(640, 480, settings.hfovDeg, settings.rotation);
    // 目標方向轉到鏡頭座標
    const eye = new THREE.Vector3().fromArray(st.eye);
    const q = new THREE.Quaternion().fromArray(st.cameraQuat);
    const c = new THREE.Vector3().fromArray(target).sub(eye).applyQuaternion(q.clone().invert());
    const d = a.pinchDepth;
    const zt = d + settings.offsetZ; // 鏡頭在眼睛前方多遠（預設 7 公分，可調）
    const u = 0.5 + ((c.x / -c.z) * zt - settings.offsetX) / (2 * intr.tanX * d) + nudge[0];
    const v = 0.5 - ((c.y / -c.z) * zt - settings.offsetY) / (2 * intr.tanY * d) + nudge[1];
    const h = make(0.5 + (u - a.pinch.x), 0.5 + (v - a.pinch.y));
    window.__lastHand = h;
    window.__ws.headset.injectResult({ hands: [h] });
    return { u, v };
  };
  // 截圖要花時間：期間持續送同一隻手（不然會被當成追丟）
  window.__keep = (on) => {
    clearInterval(window.__keepTimer);
    if (on) window.__keepTimer = setInterval(() => window.__ws.headset.injectResult({ hands: window.__lastHand ? [window.__lastHand] : [] }), 50);
  };
  // 轉頭看向某一點：算出「現在的螢幕角度下」手機感測要送的 alpha／beta／gamma（反解 headpose 的公式），
  // 讓鏡頭看過去、沒有側傾。回正造成的水平偏移用「目前鏡頭 yaw − 感測 yaw」量出來
  window.__lookAt = async (target) => {
    const { deviceQuaternion, yawOf, screenAngle } = await import('/headpose.mjs');
    const THREE = window.__ws.THREE;
    const A = screenAngle(window);
    const st = window.__ws.headset.state();
    const eye = new THREE.Vector3().fromArray(st.eye);
    const d = new THREE.Vector3().fromArray(target).sub(eye).normalize();
    const yaw = Math.atan2(-d.x, -d.z);
    const pitch = Math.asin(d.y);
    let offset = 0;
    if (window.__sensor) {
      const s0 = window.__sensor;
      offset = yawOf(THREE, new THREE.Quaternion().fromArray(st.cameraQuat)) - yawOf(THREE, deviceQuaternion(THREE, s0.alpha, s0.beta, s0.gamma, A));
    }
    const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw - offset, 0, 'YXZ'));
    const q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
    const q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (-A * Math.PI) / 180);
    const e = new THREE.Euler().setFromQuaternion(want.multiply(q0.invert()).multiply(q1.invert()), 'YXZ');
    const R = 180 / Math.PI;
    window.__sensor = { alpha: e.y * R, beta: e.x * R, gamma: -e.z * R };
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', window.__sensor));
    // 真的感測器一直送（約 60 次／秒）：這裡每 50 ms 重送一次，不然 3 秒沒訊號就會改成拖曳
    window.__sensorTimer ??= setInterval(() => window.__sensor && window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', window.__sensor)), 50);
  };
  window.__stopSensor = () => {
    clearInterval(window.__sensorTimer);
    window.__sensorTimer = null;
    window.__sensor = null;
  };
  window.__frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
`;

const browser = await chromium.launch({ args: SW });
try {
  // ======================= A. 合成手勢 =======================
  const baseA = await startServer(5341);
  const A = await openWorkshop(browser, baseA);
  const { page } = A;
  const before = await page.evaluate(() => {
    const ws = window.__ws;
    return { pr: ws.renderer.getPixelRatio(), cam: ws.camera.position.toArray(), controls: ws.controls.enabled, robot: ws.instances.get('i_demo_robot').object.position.toArray() };
  });
  check('工坊頂列有 👓 眼鏡按鈕', await page.locator('#hsBtn').isVisible());
  await page.locator('#hsBtn').tap();
  await page.locator('#hsSheet').waitFor();
  await page.screenshot({ path: path.join(OUT, 'a-01-sheet.png') });
  check('設定面板標示「未校正」且有開始按鈕', (await page.locator('#hsSheet').innerText()).includes('未校正') && (await page.locator('#hsGo').isVisible()));
  await page.locator('#hsGo').tap();
  await page.waitForFunction(() => window.__ws.headset.active);
  await page.evaluate(() => window.__frames(20));
  let st = await page.evaluate(() => window.__ws.headset.state());
  check('進入眼鏡模式：一般 DOM 介面藏起來（戴著不會看到單眼的按鈕）', !(await page.locator('.hud.top').isVisible()) && !(await page.locator('#prompt').isVisible()));
  check('OrbitControls 關掉（鏡頭只有一個主人）', (await page.evaluate(() => window.__ws.controls.enabled)) === false);
  check('沒給鏡頭權限：手勢辨識停在錯誤狀態並有中文說明', st.tracker.state === 'error' && !!st.tracker.error, `${st.tracker.error}`);
  const E = st.stereo.eyes;
  const sep = Math.hypot(E[0].pos[0] - E[1].pos[0], E[0].pos[1] - E[1].pos[1], E[0].pos[2] - E[1].pos[2]);
  check('左右眼不同視點（相距＝瞳距 63 mm）', Math.abs(sep - 0.063) < 1e-4, `${(sep * 1000).toFixed(2)} mm`);
  const projDiff = E[0].proj.some((v, i) => Math.abs(v - E[1].proj[i]) > 1e-6);
  check('每眼有自己的投影（不是同一張複製）', projDiff || st.stereo.mode === 'distort', `mode ${st.stereo.mode}`);
  let fc = await frameCounts(page, 40);
  check('每格物理只更新一次、雙眼各畫一次', fc.physCalls === fc.frames && fc.eyes === fc.frames * 2, JSON.stringify(fc));
  check('眼鏡模式解析度上限（renderScale 1.5）', st.pixelRatio <= 1.5, `pr ${st.pixelRatio}`);
  await page.screenshot({ path: path.join(OUT, 'a-02-stereo.png') });
  await page.evaluate(() => window.__ws.headset.showCalibration(3000));
  await page.evaluate(() => window.__frames(5));
  await page.screenshot({ path: path.join(OUT, 'a-03-calibration.png') });
  await page.evaluate(() => window.__ws.headset.showCalibration(0));

  // 轉頭：模擬動作感測事件（第一筆會自動回正到「面向作品」）
  const yawOf = (q) => {
    const [x, y, z, w] = q;
    const fx = -2 * (x * z + w * y);
    const fz = -(1 - 2 * (x * x + y * y));
    return Math.atan2(-fx, -fz);
  };
  await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', (window.__sensor = { alpha: 0, beta: 0, gamma: -90 }))));
  await page.evaluate(() => window.__frames(3));
  const y0 = yawOf((await page.evaluate(() => window.__ws.headset.state())).cameraQuat);
  await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', (window.__sensor = { alpha: 30, beta: 0, gamma: -90 }))));
  await page.evaluate(() => window.__frames(3));
  st = await page.evaluate(() => window.__ws.headset.state());
  const y1 = yawOf(st.cameraQuat);
  check('轉頭 30° → 視角跟著轉 30°（動作感測 active）', st.head.state === 'active' && Math.abs(y1 - y0 - Math.PI / 6) < 0.02, `Δyaw ${(((y1 - y0) * 180) / Math.PI).toFixed(1)}° state ${st.head.state}`);
  await page.evaluate(() => window.__ws.headset.recenter());
  await page.evaluate(() => window.__frames(3));
  const y2 = yawOf((await page.evaluate(() => window.__ws.headset.state())).cameraQuat);
  check('回正 → 回到面向作品的方向', Math.abs(y2 - y0) < 0.02, `${((y2 * 180) / Math.PI).toFixed(1)}°`);

  // 抓 → 移動 → 放下（合成手勢）
  const target = await page.evaluate(() => {
    const ws = window.__ws;
    const b = ws.worldBox(ws.instances.get('i_demo_robot'));
    return b.getCenter(new ws.THREE.Vector3()).toArray();
  });
  await page.evaluate((t) => window.__lookAt(t), target); // 先轉頭看它（後鏡頭視角只有 ±32°）
  await page.evaluate(() => window.__frames(3));
  for (let i = 0; i < 7; i += 1) {
    await page.evaluate((t) => window.__hand(1, t), target);
    await page.evaluate(() => window.__frames(3));
  }
  st = await page.evaluate(() => window.__ws.headset.state());
  check('指向機器人：張開手後上膛、射線指到它', st.gesture.armed && st.hover === 'i_demo_robot', `armed ${st.gesture.armed} hover ${st.hover}`);
  await page.evaluate(() => window.__keep(true));
  await page.screenshot({ path: path.join(OUT, 'a-04-hover.png') });
  await page.evaluate(() => window.__keep(false));
  await sleep(120); // 真的辨識結果大約每 50 ms 一筆：剛停止重送就馬上送下一筆，狀態機會用幾毫秒的間隔算出暴衝的速度
  for (let i = 0; i < 8; i += 1) {
    await page.evaluate((t) => window.__hand(0, t), target);
    await page.evaluate(() => window.__frames(3));
    if (i >= 2 && (await page.evaluate(() => window.__ws.headset.state().holding))) break;
  }
  st = await page.evaluate(() => window.__ws.headset.state());
  const held = await page.evaluate(() => window.__ws.holding?.inst.id ?? null);
  check('捏下去 → 物理抓起來（同一套究極手）', st.holding === 'i_demo_robot' && held === 'i_demo_robot', `holding ${st.holding} phys ${held}`);
  const p0 = await page.evaluate(() => window.__ws.holding.finger.toArray());
  report.notes.moveTrace = [];
  for (let i = 1; i <= 10; i += 1) {
    await page.evaluate(([t, i]) => window.__hand(0, t, [-0.012 * i, 0]), [target, i]);
    await page.evaluate(() => window.__frames(3));
    report.notes.moveTrace.push(await page.evaluate(() => ({ a: screen.orientation.angle, sensor: window.__sensor, s: window.__ws.headset.state().gesture.status, f: window.__ws.holding?.finger.toArray().map((v) => +v.toFixed(3)), q: window.__ws.headset.state().cameraQuat.map((v) => +v.toFixed(3)) })));
  }
  const p1 = await page.evaluate(() => window.__ws.holding?.finger.toArray() ?? null);
  report.notes.move = await page.evaluate(() => ({ st: window.__ws.headset.state().gesture, ev: window.__ws.headset.state().stats.events }));
  check('手往左移 → 抓著的東西跟著往左', p1 && p1[0] < p0[0] - 0.1, `x ${p0[0].toFixed(2)} → ${p1?.[0].toFixed(2)}`);
  await page.evaluate(() => window.__keep(true));
  await page.screenshot({ path: path.join(OUT, 'a-05-holding.png') });
  await page.evaluate(() => window.__keep(false));
  await sleep(120);
  const flings0 = st.stats.flings;
  // 張開手指（防抖：要連續幾次、至少 60 ms 才算放開；SwiftShader 一格可能很慢，最多送 10 次）
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate(([t]) => window.__hand(1, t, [-0.12, 0]), [target]);
    await page.evaluate(() => window.__frames(3));
    if (i >= 3 && !(await page.evaluate(() => window.__ws.headset.state().holding))) break;
  }
  st = await page.evaluate(() => window.__ws.headset.state());
  const physHold = await page.evaluate(() => window.__ws.holding?.inst.id ?? null);
  check('張開手指 → 放下（正常放手）', !st.holding && !physHold && st.stats.flings === flings0 + 1, `holding ${st.holding} phys ${physHold} flings ${flings0}→${st.stats.flings} safe ${st.stats.safeDrops} ${JSON.stringify(st.stats.events)} ${st.gesture.status}`);
  await sleep(1200);
  const dropped = await page.evaluate(() => window.__ws.instances.get('i_demo_robot').object.position.toArray());
  check('機器人被搬到新位置', Math.hypot(dropped[0] - before.robot[0], dropped[2] - before.robot[2]) > 0.1, `${before.robot.map((v) => v.toFixed(2))} → ${dropped.map((v) => v.toFixed(2))}`);

  // 追丟：抓著時手不見 → 安全放下（不甩），之後要重新張開才抓得起來
  const target2 = await page.evaluate(() => {
    const ws = window.__ws;
    return ws.worldBox(ws.instances.get('i_demo_robot')).getCenter(new ws.THREE.Vector3()).toArray();
  });
  await page.evaluate((t) => window.__lookAt(t), target2);
  await page.evaluate(() => window.__frames(3));
  for (let i = 0; i < 7; i += 1) {
    await page.evaluate((t) => window.__hand(1, t), target2);
    await page.evaluate(() => window.__frames(3));
  }
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate((t) => window.__hand(0, t), target2);
    await page.evaluate(() => window.__frames(3));
  }
  const grabbed2 = (await page.evaluate(() => window.__ws.headset.state())).holding;
  // 快速往右甩，然後手不見了
  for (let i = 1; i <= 4; i += 1) {
    await page.evaluate(([t, i]) => window.__hand(0, t, [0.03 * i, -0.01 * i]), [target2, i]);
    await page.evaluate(() => window.__frames(1));
  }
  const safe0 = (await page.evaluate(() => window.__ws.headset.state())).stats.safeDrops;
  await page.evaluate(() => window.__ws.headset.injectResult({ hands: [] }));
  for (let i = 0; i < 8; i += 1) {
    await page.evaluate(() => window.__ws.headset.injectResult({ hands: [] }));
    await page.evaluate(() => window.__frames(4));
  }
  st = await page.evaluate(() => window.__ws.headset.state());
  check('抓著時追丟 → 安全放下（safeDrop，不走甩放）', grabbed2 === 'i_demo_robot' && !st.holding && st.stats.safeDrops === safe0 + 1, `safeDrops ${safe0}→${st.stats.safeDrops}`);
  // 回來還捏著：不能自己又抓起來
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate((t) => window.__hand(0, t), target2);
    await page.evaluate(() => window.__frames(3));
  }
  st = await page.evaluate(() => window.__ws.headset.state());
  check('追丟後手回來還捏著 → 不會幽靈抓取', !st.holding && !st.gesture.armed);

  // 物理層：release({ fling:false }) 原地放下；一般 release() 會甩出去
  const flingTest = await page.evaluate(async () => {
    const ws = window.__ws;
    const THREE = ws.THREE;
    const out = {};
    for (const mode of ['safe', 'fling']) {
      const inst = ws.instances.get('i_demo_tower');
      const b = ws.worldBox(inst);
      const c = b.getCenter(new THREE.Vector3());
      ws.physics.grab(inst, c.clone());
      const p = c.clone().setY(c.y + 0.6);
      for (let i = 0; i < 30; i += 1) {
        p.x += mode === 'safe' || i < 25 ? 0.002 : 0.12; // 最後幾格用力甩
        ws.physics.moveHold(p.clone());
        await window.__frames(1);
      }
      const x0 = ws.worldBox(inst).getCenter(new THREE.Vector3()).x;
      ws.physics.release(mode === 'safe' ? { fling: false } : {});
      await new Promise((r) => setTimeout(r, 900));
      out[mode] = ws.worldBox(inst).getCenter(new THREE.Vector3()).x - x0;
    }
    return out;
  });
  check('物理：安全放下不帶拋力；一般放手會順著手勢甩出去', Math.abs(flingTest.safe) < 0.15 && flingTest.fling > Math.abs(flingTest.safe) + 0.3, `安全 ${flingTest.safe.toFixed(2)} m、甩 ${flingTest.fling.toFixed(2)} m`);

  // 視線按鈕：低頭盯著「離開」1.5 秒（沒有動作感測時用拖曳轉頭：真的觸控拖曳）
  await page.evaluate(() => window.__stopSensor());
  // 選單平常收成「☰ 選單」頁籤：要先盯著頁籤展開，再盯著「✕ 離開」
  const aimOf = (id) =>
    page.evaluate((x) => {
      const ws = window.__ws;
      const THREE = ws.THREE;
      const menu = ws.scene.getObjectByName('headset-menu');
      menu.updateMatrixWorld(true);
      let btn = null;
      menu.traverse((o) => o.userData.buttonId === x && (btn = o));
      const p = btn.getWorldPosition(new THREE.Vector3());
      const eye = new THREE.Vector3().fromArray(ws.headset.state().eye);
      const d = p.sub(eye).normalize();
      return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(d.y) };
    }, id);
  const aim = await aimOf('sys:exit');
  const aimTab = await aimOf('menu:open');
  report.notes.gazeAim = aim;
  check('低頭看得到視線選單（在面前下方）', aim.pitch < -0.4 && aim.pitch > -0.9, `pitch ${((aim.pitch * 180) / Math.PI).toFixed(0)}°`);

  // ---- 存檔重開 ----
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__ws.headset.active);
  const after = await page.evaluate(() => {
    const ws = window.__ws;
    return { pr: ws.renderer.getPixelRatio(), cam: ws.camera.position.toArray(), controls: ws.controls.enabled, headsetClass: document.body.classList.contains('headset'), overlay: !!document.querySelector('.hs-overlay'), st: ws.headset.state() };
  });
  check('Esc 離開：鏡頭位置、OrbitControls、解析度、介面全部還原', after.controls && after.pr === before.pr && after.cam.every((v, i) => Math.abs(v - before.cam[i]) < 1e-6) && !after.headsetClass && !after.overlay && (await page.locator('.hud.top').isVisible()));
  check('離開後沒有鏡頭串流、沒有 video 元素', after.st.liveTracks === 0 && !after.st.video && after.st.tracker.state === 'off');
  fc = await frameCounts(page, 20);
  check('離開後回到單眼畫面（不再畫雙眼）、物理照常每格一次', fc.eyes === 0 && fc.physCalls === fc.frames, JSON.stringify(fc));
  // 反覆進出三次：不累積迴圈或監聽
  for (let i = 0; i < 3; i += 1) {
    await page.locator('#hsBtn').tap();
    await page.locator('#hsGo').tap();
    await page.waitForFunction(() => window.__ws.headset.active);
    await page.evaluate(() => window.__frames(5));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__ws.headset.active);
  }
  await page.locator('#hsBtn').tap();
  await page.locator('#hsGo').tap();
  await page.waitForFunction(() => window.__ws.headset.active);
  fc = await frameCounts(page, 30);
  st = await page.evaluate(() => window.__ws.headset.state());
  check('反覆進出 4 次後：每格仍只更新一次物理、雙眼各一次', fc.physCalls === fc.frames && fc.eyes === fc.frames * 2 && st.stats.enters === 5 && st.stats.exits === 4, JSON.stringify(fc));
  // 用視線離開（拖曳轉頭：先盯「☰ 選單」1.5 秒展開，再盯「✕ 離開」1.5 秒）
  await page.evaluate(() => window.__frames(100)); // 等動作感測判定沒有訊號（改用拖曳）
  const hs = (await page.evaluate(() => window.__ws.headset.state())).head.state;
  const PX = 1 / 0.006;
  await page.mouse.move(422, 195);
  await page.mouse.down();
  await page.mouse.move(422 + aimTab.yaw * PX * 0.5, 195 + aimTab.pitch * PX * 0.5, { steps: 5 });
  await page.mouse.move(422 + aimTab.yaw * PX, 195 + aimTab.pitch * PX, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__ws.headset.state().menuOpen, null, { timeout: 6000 }).catch(() => {});
  const opened = await page.evaluate(() => window.__ws.headset.state().menuOpen);
  await page.mouse.move(422, 195);
  await page.mouse.down();
  await page.mouse.move(422 + (aim.yaw - aimTab.yaw) * PX * 0.5, 195 + (aim.pitch - aimTab.pitch) * PX * 0.5, { steps: 5 });
  await page.mouse.move(422 + (aim.yaw - aimTab.yaw) * PX, 195 + (aim.pitch - aimTab.pitch) * PX, { steps: 5 });
  await page.mouse.up();
  await page.screenshot({ path: path.join(OUT, 'a-06-gaze-menu.png') });
  await page.waitForFunction(() => !window.__ws.headset.active, null, { timeout: 6000 }).catch(() => {});
  check('視線盯著「☰ 選單」展開、再盯著「✕ 離開」1.5 秒 → 離開眼鏡模式', opened && !(await page.evaluate(() => window.__ws.headset.active)), `head ${hs}；展開 ${opened}`);
  await page.evaluate(() => window.__ws.saveNow());
  await page.reload();
  await page.waitForFunction(() => window.__ws?.loaded && window.__ws.instances.size > 0);
  await page.addScriptTag({ content: HAND_HELPERS });
  const reopened = await page.evaluate(() => window.__ws.instances.get('i_demo_robot').object.position.toArray());
  check('存檔重開：機器人在搬過去的位置', Math.hypot(reopened[0] - dropped[0], reopened[2] - dropped[2]) < 0.35, `${reopened.map((v) => v.toFixed(2))}`);
  check('A 段沒有頁面錯誤', A.errors.length === 0, A.errors.slice(0, 3).join(' | '));
  await A.ctx.close();

  // ======================= B. 真模型推論（假鏡頭） =======================
  const y4m = path.join(mkdtempSync(path.join(os.tmpdir(), 'vw-cam-')), 'hands.y4m');
  tmpDirs.push(path.dirname(y4m));
  const F = path.join(HERE, 'fixtures', 'hands');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y',
    '-loop', '1', '-t', '2', '-i', path.join(F, 'open-palm.jpg'),
    '-loop', '1', '-t', '2', '-i', path.join(F, 'pinch.jpg'),
    '-filter_complex', '[0:v]scale=448:336,pad=640:480:96:72:white,setsar=1,fps=30[a];[1:v]scale=512:288,pad=640:480:64:96:white,setsar=1,fps=30[b];[a][b]concat=n=2:v=1[v]',
    '-map', '[v]', '-pix_fmt', 'yuv420p', y4m]);
  // 真推論這段用本機 GPU 畫畫面（SwiftShader 用 CPU 畫雙眼會跟推論搶 CPU，推論慢到結果全部過期）
  const camBrowser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] });
  try {
    const B = await openWorkshop(camBrowser, baseA, { permissions: ['camera'] });
    const pb = B.page;
    const reqs = new Set();
    B.ctx.on('request', (r) => reqs.add(new URL(r.url()).origin));
    await pb.evaluate(() => window.__ws.headset.setSettings({ diag: true }));
    await pb.locator('#hsBtn').tap();
    await pb.locator('#hsGo').tap();
    await pb.waitForFunction(() => window.__ws.headset.state().tracker.state === 'running', null, { timeout: 60000 });
    // 收集 8 秒的辨識結果（影片：張開 2 秒、捏住 2 秒，循環）
    const samples = await pb.evaluate(async () => {
      const out = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 8000) {
        await new Promise((r) => setTimeout(r, 50));
        const s = window.__ws.headset.state();
        if (s.lastHand) out.push({ t: Math.round(performance.now() - t0), ratio: s.lastHand.ratio, depth: s.lastHand.depth, results: s.stats.results, handed: s.lastHand.handedness, score: s.lastHand.score });
      }
      return out;
    });
    st = await pb.evaluate(() => window.__ws.headset.state());
    const ratios = samples.map((s) => s.ratio);
    const open = ratios.filter((r) => r > 0.45).length;
    const pinch = ratios.filter((r) => r < 0.3).length;
    report.notes.realInference = { tracker: st.tracker, events: st.stats.events, results: st.stats.results, ratioMin: Math.min(...ratios), ratioMax: Math.max(...ratios), openSamples: open, pinchSamples: pinch, samples: samples.length };
    check('真模型：假鏡頭串流（不是 iPhone）經 worker 推論，辨識到手', st.tracker.results > 20 && samples.length > 20, `results ${st.tracker.results}、平均推論 ${st.tracker.inferMs.toFixed(0)} ms、${st.tracker.hz} 次/秒、延遲 ${st.tracker.latencyMs.toFixed(0)} ms、delegate ${st.tracker.delegate}`);
    check('真模型：張開與捏住的捏合比分得開（>0.45 與 <0.3 都出現）', open > 3 && pinch > 3, `min ${Math.min(...ratios).toFixed(2)} max ${Math.max(...ratios).toFixed(2)}；張開 ${open}、捏住 ${pinch} 筆`);
    check('真模型：狀態機看到「找到手、上膛」', (st.stats.events.acquire || 0) > 0 && (st.stats.events.armed || 0) > 0, JSON.stringify(st.stats.events));
    await pb.screenshot({ path: path.join(OUT, 'b-01-real-hand.png') });
    check('真模型：全部連線只到本機伺服器（模型、WASM 不連外、不上傳）', [...reqs].every((o) => o === baseA), [...reqs].join(', '));
    let ts = await pb.evaluate(() => window.__trackStates());
    check('辨識中：getUserMedia 給的串流只有一條、而且是 live', ts.length === 1 && ts[0] === 'live', ts.join(','));
    // 切到背景：鏡頭停；回來只開一條
    const opened0 = st.tracker.streamsOpened;
    await pb.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pb.evaluate(() => window.__frames(5));
    st = await pb.evaluate(() => window.__ws.headset.state());
    ts = await pb.evaluate(() => window.__trackStates());
    check('切到背景：鏡頭關掉（真的 track 都是 ended）、手勢暫停', st.tracker.state === 'paused' && st.liveTracks === 0 && ts.every((x) => x === 'ended'), ts.join(','));
    await pb.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pb.waitForFunction(() => window.__ws.headset.state().tracker.state === 'running');
    st = await pb.evaluate(() => window.__ws.headset.state());
    ts = await pb.evaluate(() => window.__trackStates());
    check('回到前景：恢復辨識，只多開一條串流（舊的 ended、新的 live）', st.liveTracks === 1 && st.tracker.streamsOpened === opened0 + 1 && ts.length === 2 && ts[0] === 'ended' && ts[1] === 'live', `streams ${opened0}→${st.tracker.streamsOpened} tracks ${ts.join(',')}`);
    await pb.keyboard.press('Escape');
    await pb.waitForFunction(() => !window.__ws.headset.active);
    st = await pb.evaluate(() => window.__ws.headset.state());
    ts = await pb.evaluate(() => window.__trackStates());
    check('離開：getUserMedia 給過的每一條 track 都 ended、video 移除、worker 關閉', st.liveTracks === 0 && !st.video && st.tracker.state === 'off' && ts.length >= 2 && ts.every((x) => x === 'ended') && !(await pb.evaluate(() => !!document.getElementById('handCam'))), ts.join(','));
    check('B 段沒有頁面錯誤', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
    await B.ctx.close();

    // ======================= C. 伺服器沒有模型檔 =======================
    const emptyModels = mkdtempSync(path.join(os.tmpdir(), 'vw-nomodel-'));
    tmpDirs.push(emptyModels);
    const baseC = await startServer(5342, { MODELS_DIR: emptyModels });
    const C = await openWorkshop(camBrowser, baseC, { permissions: ['camera'] });
    await C.page.locator('#hsBtn').tap();
    await C.page.locator('#hsGo').tap();
    await C.page.waitForFunction(() => window.__ws.headset.state().tracker.state === 'error', null, { timeout: 30000 });
    st = await C.page.evaluate(() => window.__ws.headset.state());
    await sleep(1500); // 等可能晚到的 getUserMedia
    const tsC = await C.page.evaluate(() => window.__trackStates());
    check('模型檔不在伺服器 → 錯誤 model-missing；鏡頭真的有開過、拿到的 track 全部 ended（沒有洩漏）', st.tracker.error === 'model-missing' && st.liveTracks === 0 && tsC.length >= 1 && tsC.every((x) => x === 'ended'), `${st.tracker.error} tracks ${tsC.join(',')}`);
    await C.page.evaluate(() => window.__frames(10));
    await C.page.screenshot({ path: path.join(OUT, 'c-01-model-missing.png') });
    await C.page.keyboard.press('Escape');
    await C.page.waitForFunction(() => !window.__ws.headset.active);
    const okAfter = await C.page.evaluate(() => {
      const ws = window.__ws;
      ws.selectOnly('i_demo_bench');
      return ws.selection.has('i_demo_bench') && ws.controls.enabled;
    });
    check('模型失敗不影響工坊：離開後照常選取、操作', okAfter && (await C.page.locator('#prompt').isVisible()));
    check('C 段沒有頁面錯誤', C.errors.filter((e) => !/404/.test(e)).length === 0, C.errors.slice(0, 3).join(' | '));
    await C.ctx.close();
  } finally {
    await camBrowser.close();
  }
} catch (e) {
  check('測試流程沒有例外', false, e.stack || e.message);
} finally {
  await browser.close();
  cleanup();
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過（輸出：${OUT}）`);
process.exit(failed.length ? 1 : 0);
