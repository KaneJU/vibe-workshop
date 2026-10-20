// VR 模式測試：用 Meta 的頭盔模擬器 IWER（假裝是一台 Quest 3）真的進入 WebXR，用手把指著東西扣扳機、移動、轉手腕、放開，
// 再換成手勢模式用「捏」抓一次。物理開著（究極手）和關著（掛在手把上）各跑一輪。
// 會改動場景，只能對測試用資料夾跑（同 smoke.mjs）：
//   rm -rf /tmp/vw-test-data && DATA_DIR=/tmp/vw-test-data PORT=5311 HOST=0.0.0.0 npm start &
//   npm run test:xr
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = await import(PW);
const IWER = createRequire(import.meta.url).resolve('iwer/build/iwer.min.js');
const BASE = process.env.BASE || 'http://localhost:5311';
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：這個測試會改動場景，請對測試用資料夾（預設 :5311）跑。');
  process.exit(2);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const f2 = (v) => Number(v).toFixed(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });

async function round(physics) {
  const tag = physics ? '物理開' : '物理關';
  // IWER 會把瀏覽器偽裝成 Quest，用桌面視窗跑（不要用 iPhone 模擬）
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await page.addInitScript({ path: IWER });
  await page.addInitScript(() => {
    localStorage.setItem('vw_help_seen', '1');
    const d = new IWER.XRDevice(IWER.metaQuest3);
    d.installRuntime({ forceInstall: true }); // 要在工坊問「支不支援 VR」之前裝好
    window.xrDevice = d;
  });
  await page.goto(`${BASE}/?physics=${physics ? 1 : 0}`);
  await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
  if (physics) await page.waitForFunction(() => window.__ws.physics.ready, null, { timeout: 30000 });
  // 手把的按鍵、位置在下一個 XR 畫格才生效：每一步之後都等幾格
  const frames = (n = 4) => page.evaluate((n) => new Promise((r) => { const f = (k) => (k ? requestAnimationFrame(() => f(k - 1)) : r()); f(n); }), n);
  await frames(20);
  await page.locator('#vrBtn').click();
  const inVr = await page
    .waitForFunction(() => window.__ws.renderer?.xr?.isPresenting ?? document.querySelector('#vrBtn').textContent.includes('離開'), null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check(`${tag}：按「進入 VR」→ 進入 WebXR（模擬 Quest 3）`, inVr);
  await frames(10);

  // 挑最近的東西，把右手把放在它前面 0.4 公尺、指著它的中心（座標是 rig 底下的 local-floor）
  const target = await page.evaluate(() => {
    const { THREE, instances, camera, worldBox } = window.__ws;
    const rig = camera.parent;
    const at = rig.getWorldPosition(new THREE.Vector3());
    let best = null;
    for (const inst of instances.values()) {
      const b = worldBox(inst);
      const c = b.getCenter(new THREE.Vector3());
      const d = Math.hypot(c.x - at.x, c.z - at.z);
      if (!best || d < best.d) best = { inst, b, c, d };
    }
    const size = best.b.getSize(new THREE.Vector3());
    const toUser = new THREE.Vector3(at.x - best.c.x, 0, at.z - best.c.z).normalize();
    const start = best.c.clone().addScaledVector(toUser, Math.max(size.x, size.z) / 2 + 0.4);
    const L = rig.worldToLocal(start.clone());
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), rig.worldToLocal(best.c.clone()).sub(L).normalize());
    const c = window.xrDevice.controllers.right;
    c.position.set(L.x, L.y, L.z);
    c.quaternion.set(q.x, q.y, q.z, q.w);
    window.__xt = { id: best.inst.id, L: L.toArray(), q: q.toArray() };
    return { id: best.inst.id, name: window.__ws.runtime.parts.get(best.inst.partId)?.name };
  });
  const state = () =>
    page.evaluate(() => {
      const { THREE, instances, camera } = window.__ws;
      const o = instances.get(window.__xt.id).object;
      const p = o.getWorldPosition(new THREE.Vector3());
      const yaw = new THREE.Euler().setFromQuaternion(o.getWorldQuaternion(new THREE.Quaternion()), 'YXZ').y;
      return { p: p.toArray(), yaw, onController: o.parent?.parent === camera.parent, holding: !!window.__ws.physics.holding };
    });
  await frames(6);
  const s0 = await state();
  await page.evaluate(() => window.xrDevice.controllers.right.updateButtonValue('trigger', 1));
  await frames(8);
  const s1 = await state();
  const jump = Math.hypot(...s1.p.map((v, i) => v - s0.p[i]));
  const grabbed = physics ? s1.holding : s1.onController;
  check(`${tag}：手把指著「${target.name}」扣扳機 → 抓起來，而且不會跳開`, grabbed && jump < 0.1, `${physics ? '究極手' : '掛在手把上'}，抓起瞬間移動 ${f2(jump)} m`);

  // 手把往右 0.3、往上 0.25 公尺 → 東西跟著走同樣的距離
  await page.evaluate(() => {
    const [x, y, z] = window.__xt.L;
    window.xrDevice.controllers.right.position.set(x + 0.3, y + 0.25, z);
  });
  await frames(70);
  const s2 = await state();
  const d = s2.p.map((v, i) => v - s1.p[i]);
  const follows = Math.abs(d[1] - 0.25) < 0.06 && Math.abs(Math.hypot(d[0], d[2]) - 0.3) < 0.06;
  check(`${tag}：手把移動 → 東西跟著走`, follows, `手把動 (0.30, 0.25)，東西動 (${f2(Math.hypot(d[0], d[2]))}, ${f2(d[1])})`);

  // 手腕往左轉 60° → 東西跟著轉
  await page.evaluate(() => {
    const c = window.xrDevice.controllers.right;
    const [qx, qy, qz, qw] = window.__xt.q;
    const turn = new window.__ws.THREE.Quaternion().setFromAxisAngle(new window.__ws.THREE.Vector3(0, 1, 0), Math.PI / 3);
    const q = turn.multiply(new window.__ws.THREE.Quaternion(qx, qy, qz, qw));
    c.quaternion.set(q.x, q.y, q.z, q.w);
  });
  await frames(70);
  const s3 = await state();
  const turned = Math.abs(Math.atan2(Math.sin(s3.yaw - s2.yaw), Math.cos(s3.yaw - s2.yaw)));
  check(`${tag}：轉手腕 → 東西跟著轉`, Math.abs(turned - Math.PI / 3) < 0.25, `轉了 ${Math.round((turned * 180) / Math.PI)}°（手腕轉 60°）`);
  await page.screenshot({ path: path.join(OUT, `x-${physics ? 'physics' : 'classic'}-held.png`) });

  // 放開 → 不再抓著，落回地面或下面的東西上
  await page.evaluate(() => window.xrDevice.controllers.right.updateButtonValue('trigger', 0));
  await frames(physics ? 120 : 10);
  const s4 = await state();
  const landed = await page.evaluate(() => window.__ws.worldBox(window.__ws.instances.get(window.__xt.id)).min.y);
  check(`${tag}：放開 → 放下、落回地上`, !s4.holding && !s4.onController && landed < 0.6, `底部高度 ${f2(landed)} m`);

  // 手勢模式：用捏的抓
  await page.evaluate(() => {
    const d = window.xrDevice;
    d.primaryInputMode = 'hand';
    const h = d.hands.right;
    const [x, y, z] = window.__xt.L;
    const [qx, qy, qz, qw] = window.__xt.q;
    h.position.set(x, y, z);
    h.quaternion.set(qx, qy, qz, qw);
  });
  await frames(10);
  // 重新瞄準（東西可能動過了）
  await page.evaluate(() => {
    const { THREE, instances, camera, worldBox } = window.__ws;
    const rig = camera.parent;
    const c = worldBox(instances.get(window.__xt.id)).getCenter(new THREE.Vector3());
    const h = window.xrDevice.hands.right;
    const L = new THREE.Vector3(h.position.x, h.position.y, h.position.z);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), rig.worldToLocal(c.clone()).sub(L).normalize());
    h.quaternion.set(q.x, q.y, q.z, q.w);
  });
  await frames(6);
  await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(1));
  await frames(10);
  const s5 = await state();
  const pinched = physics ? s5.holding : s5.onController;
  await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(0));
  await frames(10);
  const s6 = await state();
  check(`${tag}：手勢模式「捏」→ 抓起來，鬆開 → 放下`, pinched && !(physics ? s6.holding : s6.onController));

  check(`${tag}：過程中沒有任何錯誤`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

await round(false);
await round(true);
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
