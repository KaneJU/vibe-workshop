// 眼鏡模式的純邏輯測試（Node，不開瀏覽器）：雙眼視差與每眼投影、轉頭（橫放、回正）、手勢狀態機（捏合遲滯／防抖、
// 主手穩定、沒上膛不抓、追丟安全取消）、鏡頭與動作感測的錯誤路徑（非安全連線、拒絕、找不到鏡頭、模型檔壞掉）。
// 手勢這段餵的是「合成的關鍵點」：只驗狀態機，不代表真的模型推論（那在 tests/headset.mjs 用假鏡頭＋真模型驗）。
//   node tests/headset-unit.mjs
import * as THREE from 'three';
import { eyeViews, eyeFrustum, cleanStereo, STEREO_DEFAULTS, distortScale } from '../public/stereo.mjs';
import { deviceQuaternion, yawOf, createHeadPose, physicallyLandscape } from '../public/headpose.mjs';
import { createGesture, analyzeHand, pinchRatio, imageToCamera, intrinsics, adjustLandmarks } from '../public/hands.mjs';
import { createHandTracker, cameraErrorCode } from '../public/handtrack.mjs';
import { loadModel, VISION } from '../public/handinfer.mjs';
import { cleanCam, loadSettings, wrapLines } from '../public/headset.mjs';
import { HAND_ERRORS } from '../public/handtrack.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const DEG = Math.PI / 180;

// ---------------- 雙眼 ----------------
{
  const s = cleanStereo({});
  const [L, R] = eyeViews(844, 390, s);
  check('左右眼各占半個畫面', L.vp.x === 0 && R.vp.x === 422 && L.vp.w === 422 && R.vp.w === 422 && L.vp.h === 390);
  // 鏡片中心距 60mm×6.03px/mm ≈ 362 px：左眼中心在左半邊偏右（靠近鼻子）、右眼在右半邊偏左
  check('鏡片中心依鏡片中心距放（60 mm × 6.03 px/mm）', near(L.center.x, 422 - 180.9, 0.05) && near(R.center.x, 180.9, 0.05), `L ${L.center.x.toFixed(1)} R ${R.center.x.toFixed(1)}`);
  const flat = cleanStereo({ distortion: false });
  const gl = eyeFrustum(L, flat);
  const gr = eyeFrustum(R, flat);
  check('兩眼投影左右鏡像（偏軸，不是同一張複製）', near(gl.left, -gr.right, 1e-9) && near(gl.right, -gr.left, 1e-9) && !near(gl.left, gr.left, 1e-3), `L[${gl.left.toFixed(3)},${gl.right.toFixed(3)}] R[${gr.left.toFixed(3)},${gr.right.toFixed(3)}]`);
  check('偏軸：每眼左右不對稱（鏡片中心不在半邊中央）', !near(Math.abs(gl.left), Math.abs(gl.right), 1e-3));
  const fl = eyeFrustum(L, s);
  const lim = Math.tan((s.maxHalfFovDeg * Math.PI) / 180);
  check('有畸變校正時，視野以鏡片可視角為界', near(fl.right, lim, 1e-9) && near(fl.left, -lim, 1e-9), `±${lim.toFixed(3)}`);
  const f0 = gl;
  const aspect = (f0.right - f0.left) / (f0.top - f0.bottom);
  check('不校正畸變時，每眼投影的長寬比＝半邊畫面的長寬比', near(aspect, 422 / 390, 1e-6), aspect.toFixed(4));
  check('畸變校正把視野往外拉（比不校正寬）', fl.right - fl.left > f0.right - f0.left);
  check('畸變多項式 t×(1+k1·t²+k2·t⁴)', near(distortScale(0.25, 0.441, 0.156), 1 + 0.441 * 0.25 + 0.156 * 0.0625));
  const bad = cleanStereo({ ipdMm: 500, k1: -3, renderScale: 99, preset: 'nope' });
  check('不合理的設定被擋回範圍內', bad.ipdMm === 76 && bad.k1 === 0 && bad.renderScale === 3 && bad.preset === STEREO_DEFAULTS.preset);
}

// ---------------- 轉頭 ----------------
{
  const fwd = (q) => new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const up = (q) => new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  // 直拿、手機立起來（beta 90）：看水平前方
  const q0 = deviceQuaternion(THREE, 0, 90, 0, 0);
  check('直拿立起：看向水平前方、沒有側傾', near(fwd(q0).y, 0, 1e-6) && near(up(q0).y, 1, 1e-6));
  // 橫拿（螢幕轉 90°）：手機往左躺（gamma -90）、螢幕朝自己
  const q1 = deviceQuaternion(THREE, 0, 0, -90, 90);
  check('橫放（螢幕 90°）：看向水平前方、地平線是平的', near(fwd(q1).y, 0, 1e-6) && near(up(q1).y, 1, 1e-6), `fwd ${fwd(q1).toArray().map((v) => v.toFixed(3))}`);
  const q2 = deviceQuaternion(THREE, 30, 0, -90, 90);
  check('橫放時往左轉頭 30°（alpha +30）→ 視角 yaw +30°', near(yawOf(THREE, q2) - yawOf(THREE, q1), 30 * DEG, 1e-6));
  const q3 = deviceQuaternion(THREE, 0, 0, -70, 90);
  check('橫放時上下轉 20°（gamma -90 → -70）→ 視線俯仰 20°、地平線不歪', near(Math.abs(fwd(q3).y), Math.sin(20 * DEG), 1e-6) && near(new THREE.Vector3(1, 0, 0).applyQuaternion(q3).y, 0, 1e-6), `y ${fwd(q3).y.toFixed(3)}`);
  check('判斷手機實際是不是橫著（直向鎖定提示用）', physicallyLandscape(0, -90) && !physicallyLandscape(90, 0));

  // 回正只轉水平：上下仍跟著重力
  const listeners = {};
  const win = {
    isSecureContext: true,
    DeviceOrientationEvent: function DOE() {},
    screen: { orientation: { angle: 90 } },
    addEventListener: (n, f) => (listeners[n] = f),
    removeEventListener: (n) => delete listeners[n],
  };
  let t = 0;
  const hp = createHeadPose({ THREE, win, now: () => t });
  await hp.request();
  hp.start();
  listeners.deviceorientation({ alpha: 50, beta: 0, gamma: -70 });
  check('收到感測就變成 active', hp.state === 'active');
  hp.recenter(0);
  const qa = hp.get(new THREE.Quaternion());
  check('回正：水平方向歸零、俯仰角度保留', near(yawOf(THREE, qa), 0, 1e-6) && near(Math.abs(fwd(qa).y), Math.sin(20 * DEG), 1e-6), `yaw ${yawOf(THREE, qa).toFixed(4)} y ${fwd(qa).y.toFixed(3)}`);
  hp.stop();
  check('停止後移除監聽', !listeners.deviceorientation && hp.state === 'idle');
  t = 0;
  hp.start();
  t = 2000;
  hp.tick();
  check('等不到感測 → nosignal（改用拖曳）', hp.state === 'nosignal' && hp.usingFallback);
  hp.stop();
  const insecure = createHeadPose({ THREE, win: { ...win, isSecureContext: false } });
  check('非安全連線 → insecure（不硬要權限）', (await insecure.request()) === 'insecure' && insecure.state === 'insecure');
  const denyWin = { ...win, DeviceOrientationEvent: { requestPermission: async () => 'denied' } };
  const denied = createHeadPose({ THREE, win: denyWin });
  check('iPhone 拒絕動作感測 → denied、改用拖曳', (await denied.request()) === 'denied' && denied.usingFallback);
}

// ---------------- 手勢（合成關鍵點） ----------------
// 做一隻手：手掌中心 (cx, cy)、大小 size（畫面寬的比例）、捏合程度 open（0＝捏緊、1＝張開）
function fakeHand(cx, cy, size, open) {
  const lm = new Float32Array(63);
  const world = new Float32Array(63);
  // 以手掌長為 1 的畫面座標（x 右、y 下）；世界座標（公尺，手掌長 9 公分，y 上）由它換算
  const k = 0.09;
  const set = (i, x, y) => {
    lm.set([cx + x * size, cy + y * size, 0], i * 3);
    world.set([x * k, -y * k, 0], i * 3);
  };
  set(0, 0, 0.5);
  set(5, -0.25, -0.4);
  set(9, 0, -0.5);
  set(13, 0.2, -0.45);
  set(17, 0.38, -0.35);
  const gap = 0.12 + open * 0.68; // 拇指尖到食指尖（手掌長的倍數）
  set(8, -0.3, -1.05);
  set(4, -0.3 - gap * 0.8, -1.05 + gap * 0.6);
  for (const i of [1, 2, 3, 6, 7, 10, 11, 12, 14, 15, 16, 18, 19, 20]) set(i, 0, 0);
  return { lm, world, handedness: 'Right', score: 0.95 };
}
const CAM = { width: 640, height: 480, hfovDeg: 64, rotation: 0, mirror: false };
{
  const a = analyzeHand(fakeHand(0.5, 0.5, 0.25, 1), CAM);
  const b = analyzeHand(fakeHand(0.5, 0.5, 0.25, 0), CAM);
  check('張開的手捏合比 > 0.45、捏緊 < 0.3', a.ratio > 0.45 && b.ratio < 0.3, `open ${a.ratio.toFixed(2)} pinch ${b.ratio.toFixed(2)}`);
  check('手越大（越近）估計越近', analyzeHand(fakeHand(0.5, 0.5, 0.35, 1), CAM).depth < a.depth);
  check('捏點貼到畫面邊緣 → 低信心', analyzeHand(fakeHand(0.02, 0.6, 0.25, 0), CAM).lowConf);
  const intr = intrinsics(640, 480, 64);
  const p = imageToCamera(0.5, 0.5, 0.4, intr);
  check('畫面中央的捏點在鏡頭正前方', near(p.x, 0) && near(p.y, 0) && near(p.z, -0.4));
  const rot = adjustLandmarks(new Float32Array([0.8, 0.5, 0]), { rotation: 90 });
  check('鏡頭畫面旋轉 90°', near(rot[0], 0.5, 1e-6) && near(rot[1], 0.8, 1e-6));
  check('worldLandmarks 的捏合比不受畫面大小影響', near(pinchRatio(fakeHand(0.5, 0.5, 0.2, 1).lm, fakeHand(0.5, 0.5, 0.2, 1).world), pinchRatio(fakeHand(0.5, 0.5, 0.4, 1).lm, fakeHand(0.5, 0.5, 0.4, 1).world), 1e-6));
}
{
  const g = createGesture();
  let t = 0;
  const step = (hands, dt = 50) => {
    t += dt;
    return g.update({ t, hands: hands.map((h) => analyzeHand(h, CAM)) });
  };
  const evs = (out) => out.events.map((e) => e.type);
  let out = step([fakeHand(0.5, 0.5, 0.25, 0)]);
  check('第一次看到手：acquire，還沒上膛', evs(out).includes('acquire') && !out.armed);
  let seen = [];
  for (let i = 0; i < 3; i += 1) seen.push(...evs(step([fakeHand(0.5, 0.5, 0.25, 0)])));
  check('一開始就捏著（沒先張開）→ 不抓、不上膛（防幽靈抓取）', !seen.includes('pinch-start') && !g.state().armed && g.state().status === 'paused');
  for (let i = 0; i < 6; i += 1) out = step([fakeHand(0.5, 0.5, 0.25, 1)]);
  check('張開幾次之後上膛', g.state().armed);
  out = step([fakeHand(0.5, 0.5, 0.25, 0.1)]);
  check('防抖：捏一格還不算', !evs(out).includes('pinch-start'));
  out = step([fakeHand(0.5, 0.5, 0.25, 0.1)]);
  check('連續兩格捏著 → pinch-start', evs(out).includes('pinch-start'));
  g.markGrab(true);
  out = step([fakeHand(0.5, 0.5, 0.25, 0.3)]);
  check('遲滯：稍微鬆開（在 pinchOn 與 pinchOff 之間）不算放開', !evs(out).includes('pinch-end') && g.state().grabbing);
  // 第二隻手出現在旁邊：主手不換
  const id = g.state().primaryId;
  out = step([fakeHand(0.52, 0.5, 0.25, 0.1), fakeHand(0.2, 0.5, 0.4, 1)]);
  check('第二隻（更大的）手出現：主手不換', g.state().primaryId === id && g.state().grabbing);
  // 主手被擋住一下（< 300 ms）：還算同一隻
  out = step([], 100);
  check('短暫不見：holding-lost、不取消', out.status === 'holding-lost' && !evs(out).includes('cancel'));
  out = step([fakeHand(0.52, 0.5, 0.25, 0.1)], 100);
  check('回來了：繼續抓著', out.status === 'grabbing');
  // 追丟超過 300 ms → cancel（外面要安全放下，不甩）
  seen = [];
  for (const dt of [100, 150, 150, 100]) seen.push(...evs(step([], dt)));
  check('追丟超過寬限 → cancel（安全放下）', seen.includes('cancel') && seen.includes('lost') && !g.state().grabbing, seen.join(','));
  // 回來之後要重新上膛
  out = step([fakeHand(0.5, 0.5, 0.25, 0.1)]);
  out = step([fakeHand(0.5, 0.5, 0.25, 0.1)]);
  check('追丟後回來還捏著 → 不會自己又抓起來', !evs(out).includes('pinch-start'));
  // 手跳太遠（另一隻手的位置）：不是同一隻
  for (let i = 0; i < 6; i += 1) step([fakeHand(0.5, 0.5, 0.25, 1)]);
  step([fakeHand(0.5, 0.5, 0.25, 0)]);
  out = step([fakeHand(0.5, 0.5, 0.25, 0)]);
  g.markGrab(true);
  out = step([fakeHand(0.9, 0.5, 0.25, 0)]);
  check('畫面上手突然跳很遠：不當成同一隻（不跟著跳）', out.status === 'holding-lost');
  check('外面取消（關鏡頭、切背景）：回傳原本有抓著，之後要重新上膛', g.cancel('background') === true && !g.state().armed);
  g.reset();
  check('暫停後 reset：忘掉主手', g.state().primaryId === null);
}

// ---------------- 鏡頭／模型錯誤路徑 ----------------
{
  check('getUserMedia 錯誤分類', cameraErrorCode({ name: 'NotAllowedError' }) === 'denied' && cameraErrorCode({ name: 'NotFoundError' }) === 'no-camera' && cameraErrorCode({ name: 'NotReadableError' }) === 'busy');
  const states = [];
  const mk = (win) => createHandTracker({ win, doc: {}, makeWorker: () => ({ postMessage() {}, terminate() {} }), onState: (s, e) => states.push([s, e?.code]) });
  const tr1 = mk({ isSecureContext: false });
  await tr1.start();
  check('非安全連線：不開鏡頭，錯誤 insecure', tr1.state === 'error' && tr1.error.code === 'insecure');
  const tr2 = mk({ isSecureContext: true, navigator: {} });
  await tr2.start();
  check('沒有 getUserMedia：錯誤 unsupported', tr2.error.code === 'unsupported');
  const denyErr = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  let workerKilled = 0;
  const tr3 = createHandTracker({
    win: { isSecureContext: true, navigator: { mediaDevices: { getUserMedia: async () => Promise.reject(denyErr) } } },
    doc: {},
    makeWorker: () => {
      const w = { postMessage(m) { if (m.type === 'init') setTimeout(() => w.onmessage({ data: { type: 'ready', delegate: 'CPU' } }), 1); }, terminate() { workerKilled += 1; } };
      return w;
    },
  });
  await tr3.start();
  check('拒絕鏡頭權限：錯誤 denied（有中文說明）', tr3.error.code === 'denied' && /權限/.test(tr3.error.message));
  tr3.stop();
  check('停止時把 worker 關掉', workerKilled === 1 && tr3.state === 'off');
  // 模型檔：404、大小不對
  const r404 = await loadModel(async () => ({ status: 404, ok: false })).catch((e) => e.code);
  const rBad = await loadModel(async () => ({ status: 200, ok: true, arrayBuffer: async () => new ArrayBuffer(10) })).catch((e) => e.code);
  const rNet = await loadModel(async () => Promise.reject(new Error('offline'))).catch((e) => e.code);
  check('模型檔不在伺服器 → model-missing', r404 === 'model-missing');
  check('模型檔大小不對 → model-corrupt', rBad === 'model-corrupt');
  check('連不到伺服器 → model-network', rNet === 'model-network');
  check('模型鎖定 float16 v1 的雜湊', VISION.model.sha256.startsWith('fbc2a300') && VISION.model.bytes === 7819105 && VISION.version === '0.10.35');
}

// ---------------- 設定 ----------------
{
  const st = new Map();
  const storage = { getItem: (k) => st.get(k) ?? null, setItem: (k, v) => st.set(k, v) };
  storage.setItem('vw_headset', JSON.stringify({ cam: { rotation: 45, hfovDeg: 999, prefer: 'left' }, stereo: { ipdMm: 70 } }));
  const s = loadSettings(storage);
  check('鏡頭設定：不合法的旋轉擋掉、視角夾在範圍內', s.cam.rotation === 0 && s.cam.hfovDeg === 100 && s.cam.prefer === 'left' && s.stereo.ipdMm === 70);
  check('壞掉的設定字串 → 預設值', loadSettings({ getItem: () => '{oops' }).cam.hfovDeg === cleanCam().hfovDeg);
}

// ---------------- 頭戴裡的說明文字 ----------------
{
  const all = Object.values(HAND_ERRORS).map((m) => wrapLines(m));
  check('每一則鏡頭／模型錯誤說明都切成 ≤3 行、不會被截斷', all.every((l) => l.length <= 3 && !l.join('').endsWith('…')), `最多 ${Math.max(...all.map((l) => l.length))} 行`);
  const m = wrapLines(HAND_ERRORS['model-missing']).join('|');
  check('英文指令不從中間斷開、標點不放行首', m.includes('npm run fetch:models') && !/\|[，。：]/.test(m), m);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
