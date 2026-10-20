// 手機眼鏡模式（紙盒頭戴）：把雙眼畫面（stereo）、轉頭（headpose）、後鏡頭手勢（handtrack＋hands）、
// 頭戴介面（headsethud）接到工坊「同一個世界、同一套物理」上——抓的是既有作品，放下後照常存檔，不是另一個 demo。
// - 鏡頭姿勢只有一個主人：進來時關掉 OrbitControls，每格由這裡依頭部姿勢設定；離開時全部還原
// - 世界、物理每格只更新一次（主迴圈）；這裡只負責「頭、手 → 抓、放」與「畫兩隻眼睛」
// - 坐著轉頭（3DoF）：眼睛位置固定，不是空間定位
// - 安全放下：追丟、低信心、關鏡頭、切到背景、手機轉直、離開 → phys.release({ fling: false })，不會把東西甩出去；
//   之後要先把手張開（重新上膛）才抓得起來
// - 手的遠近是單眼估計（看手在畫面上多大），不是絕對定位：抓著時「手往前／往後」只用相對變化推拉東西
import { createStereo, cleanStereo, LENS_PRESETS, STEREO_DEFAULTS, STEREO_RANGE, fovSummary } from './stereo.mjs';
import { createHeadPose } from './headpose.mjs';
import { createHandTracker, HAND_ERRORS } from './handtrack.mjs';
import { analyzeHand, createGesture, OneEuro, imageToCamera, wrapAngle } from './hands.mjs';
import { createHud } from './headsethud.mjs';

const STORE = 'vw_headset';
export const CAM_DEFAULTS = {
  rotation: 0, // 鏡頭畫面要轉幾度才跟螢幕同方向
  mirror: false, // 後鏡頭不用鏡像
  hfovDeg: 64, // 後鏡頭水平視角（iPhone 主鏡頭 4:3 約 64°）
  depthScale: 1, // 手的遠近比例（手特別大／小的人調這個）
  offsetX: 0, // 鏡頭在眼睛中間的左右偏移（公尺）：iPhone 橫放時後鏡頭在一側
  prefer: 'auto', // 主手：自動（最靠近鏡頭的那隻）／左／右
  hz: 20, // 每秒辨識幾次
};
const CAM_RANGE = { hfovDeg: [40, 100], depthScale: [0.5, 2], offsetX: [-0.1, 0.1], hz: [5, 30] };
const EYE_TO_CAM_Z = -0.07; // 後鏡頭大約在眼睛前方 7 公分（鏡片＋紙盒＋手機）
const DEPTH_GAIN = 3; // 抓著時，手往前／往後 1 公分，東西跟著移動 3 公分
const ROLL_DEAD = (8 * Math.PI) / 180; // 手轉不到 8° 不轉東西（手勢辨識會抖）
const CALIB_MS = 8000; // 校正圖顯示多久（戴著摸不到按鈕，時間到自己回到世界）
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 頭戴裡的長句子切成幾行（每行約 18 個中文字寬）：英文字、指令不從中間斷，標點不放行首；最多 3 行
export function wrapLines(text, width = 18, max = 3) {
  const units = String(text).match(/[\x21-\x7e]+|\s+|./gu) || [];
  const uw = (u) => (/^[\x00-\xff]+$/.test(u) ? u.length * 0.55 : [...u].length);
  const lines = [];
  let cur = '';
  let curW = 0;
  for (const u of units) {
    const w = uw(u);
    if (curW + w > width && cur.trim() && !/^[，。：；、！？）」』…]$/.test(u)) {
      lines.push(cur.trimEnd());
      cur = '';
      curW = 0;
      if (/^\s+$/.test(u)) continue;
    }
    cur += u;
    curW += w;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  if (lines.length > max) {
    lines.length = max;
    lines[max - 1] = `${lines[max - 1].slice(0, -1)}…`;
  }
  return lines;
}

export function cleanCam(raw = {}) {
  const c = { ...CAM_DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const [k, [lo, hi]] of Object.entries(CAM_RANGE)) if (Number.isFinite(raw[k])) c[k] = clamp(raw[k], lo, hi);
    if ([0, 90, 180, 270].includes(raw.rotation)) c.rotation = raw.rotation;
    if (typeof raw.mirror === 'boolean') c.mirror = raw.mirror;
    if (['auto', 'left', 'right'].includes(raw.prefer)) c.prefer = raw.prefer;
  }
  return c;
}

export function loadSettings(storage) {
  let raw = {};
  try {
    raw = JSON.parse(storage?.getItem(STORE) || '{}') || {};
  } catch {
    raw = {};
  }
  return { stereo: cleanStereo(raw.stereo), cam: cleanCam(raw.cam), diag: raw.diag === true, calibFirst: raw.calibFirst === true };
}

const CSS = `
.hs-sheet{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(2,6,12,.72);font:14px/1.5 -apple-system,BlinkMacSystemFont,'PingFang TC','Noto Sans TC',sans-serif;color:#d9f6ff}
.hs-card{width:min(560px,94vw);max-height:92vh;overflow:auto;background:#0b1622;border:1px solid rgba(56,225,255,.4);border-radius:14px;padding:16px 18px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.hs-card h2{margin:0 0 6px;font-size:18px}
.hs-card p{margin:6px 0;color:#9fb8c8}
.hs-warn{color:#ffd166!important}
.hs-row{display:flex;align-items:center;gap:8px;margin:6px 0}
.hs-row label{flex:0 0 132px;color:#bfe9ff}
.hs-row input[type=range]{flex:1}
.hs-row output{flex:0 0 58px;text-align:right;color:#9fb8c8;font-variant-numeric:tabular-nums}
.hs-card details{margin:8px 0;border-top:1px solid rgba(56,225,255,.2);padding-top:6px}
.hs-card summary{cursor:pointer;color:#38e1ff}
.hs-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.hs-btns button,.hs-card select{font:inherit;padding:8px 14px;border-radius:9px;border:1px solid rgba(56,225,255,.45);background:#10263a;color:#d9f6ff}
.hs-btns .hs-go{background:#1b8fb5;border-color:#38e1ff;font-weight:700}
.hs-overlay{position:fixed;inset:0;z-index:55;touch-action:none;display:flex;align-items:center;justify-content:center;text-align:center;color:#d9f6ff;font:20px/1.6 -apple-system,'PingFang TC',sans-serif}
.hs-overlay[data-portrait="1"]{background:#000}
body.headset>*:not(#app):not(.hs-overlay):not(.hs-sheet){display:none!important}
#hsBtn .short{display:none}
@media (max-width:760px){#hsBtn .long{display:none}#hsBtn .short{display:inline}}
`;

export function createHeadset({ THREE, renderer, scene, camera, controls, phys, pick, hooks = {}, win = window, doc = document, storage = win.localStorage, makeWorker }) {
  const h = {
    toast: () => {}, // 一般畫面的提示（進眼鏡模式前）
    canEnter: () => true, // 回傳字串＝不能進來的原因
    onEnter: () => {},
    onExit: () => {},
    beforeGrab: () => {}, // 抓之前（記復原點、選取）
    afterRelease: () => {}, // 放下之後（存檔）
    nameOf: () => '東西',
    ...hooks,
  };
  const now = () => win.performance.now();
  let settings = loadSettings(storage);
  let active = false;
  let stereo = null;
  let hud = null;
  let overlay = null;
  let sheet = null;
  let wakeLock = null;
  let wentFullscreen = false;
  const saved = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), target: new THREE.Vector3(), fov: 60, controls: true, pr: 1 };
  const eye = new THREE.Vector3();
  let yaw0 = 0;
  let needRecenter = false;
  const qHead = new THREE.Quaternion();

  // ---- 手 ----
  let pending = null; // 最新一筆辨識結果：留到主迴圈再處理（物理只在主迴圈動）
  let lastObsT = -Infinity;
  let lastEmptyT = -Infinity;
  let syntheticUntil = 0;
  let lastOut = null;
  let lastHands = [];
  let handSeenAt = -Infinity;
  const filt = { u: new OneEuro(), v: new OneEuro(), d: new OneEuro({ minCutoff: 0.8, beta: 0.4 }), r: new OneEuro({ minCutoff: 1, beta: 0.05 }) };
  let rollRaw = null;
  let roll = 0;
  let handOn = false; // 這一刻有沒有手的位置可以用
  const pinchWorld = new THREE.Vector3();
  const dirWorld = new THREE.Vector3(0, 0, -1);
  const points = Array.from({ length: 21 }, () => new THREE.Vector3());
  const rayEnd = new THREE.Vector3();
  let hover = null; // { inst, point }
  let holding = null; // { inst, dist0, hand0, roll0, q0 }
  let portrait = false;
  let calibUntil = 0;
  let lastNote = '';
  let noteAt = 0;
  const stats = { frames: 0, frameMs: 0, eyesAtEnter: 0, safeDrops: 0, flings: 0, grabs: 0, enters: 0, exits: 0, results: 0, events: {} };
  const tmp = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const camPt = { x: 0, y: 0, z: 0 };

  const head = createHeadPose({ THREE, win });
  const gesture = createGesture({ prefer: settings.cam.prefer });
  ensureStyle();
  const tracker = createHandTracker({
    win,
    doc,
    makeWorker,
    onResult: (r) => {
      pending = r;
    },
    onState: (state) => {
      if (!active) return;
      if (state !== 'running') {
        // 鏡頭停了／壞了：手上的東西安全放下，之後重新找手、重新上膛
        safeDrop(state === 'error' ? 'camera-error' : 'camera-paused');
        gesture.reset();
        handOn = false;
      }
    },
  });

  function save() {
    try {
      storage?.setItem(STORE, JSON.stringify(settings));
    } catch {
      /* 私密瀏覽：存不了就算了 */
    }
  }

  function note(text, ms = 2500) {
    if (!hud || !text) return;
    const t = now();
    if (text === lastNote && t - noteAt < 4000) return; // 同一句話不要一直跳
    lastNote = text;
    noteAt = t;
    hud.toast(text, ms, t);
  }

  // 鏡頭座標（x 右、y 上、-z 前，單位公尺）→ 世界座標：用「拍下那一刻」的頭部姿勢，轉頭時手不會跟著飄
  function toWorld(p, q, out) {
    return out.set(p.x + settings.cam.offsetX, p.y, p.z + EYE_TO_CAM_Z).applyQuaternion(q).add(eye);
  }

  function observe(r) {
    if (!r.empty) lastObsT = now();
    const cam = { ...settings.cam, width: r.width || 640, height: r.height || 480 };
    const hands = (r.hands || []).map((raw) => analyzeHand(raw, cam));
    lastHands = r.hands || [];
    const out = gesture.update({ t: r.t, hands });
    lastOut = out;
    if (!r.empty) stats.results += 1;
    for (const ev of out.events) stats.events[ev.type] = (stats.events[ev.type] || 0) + 1;
    if (out.hand) {
      placeHand(out.hand, r.headQ || qHead, r.t);
      handSeenAt = now();
    } else if (!out.primaryId) handOn = false;
    for (const ev of out.events) onGesture(ev);
    if (!r.empty && hud && tracker.video) hud.drawPreview(tracker.video, lastHands, { mirror: settings.cam.mirror });
  }

  function placeHand(hand, q, tMs) {
    const ts = tMs / 1000;
    const u = filt.u.filter(hand.pinch.x, ts);
    const v = filt.v.filter(hand.pinch.y, ts);
    const d = filt.d.filter(hand.pinchDepth, ts);
    // 角度要連續（不在 ±180° 那裡跳）再濾波
    rollRaw = rollRaw == null ? hand.roll : rollRaw + wrapAngle(hand.roll - rollRaw);
    roll = filt.r.filter(rollRaw, ts);
    toWorld(imageToCamera(u, v, d, hand.intr, camPt), q, pinchWorld);
    dirWorld.copy(pinchWorld).sub(eye).normalize();
    // 骨架：每個關節用畫面位置＋（手的深度＋關節相對手中心的前後）
    const L = hand.lm;
    const W = hand.world;
    for (let i = 0; i < 21; i += 1) {
      const z = hand.depth + (W ? W[i * 3 + 2] : 0);
      toWorld(imageToCamera(L[i * 3], L[i * 3 + 1], Math.max(0.08, z), hand.intr, camPt), q, points[i]);
    }
    // 讓骨架的捏點跟濾波後的捏點對齊（不然看起來抖）
    tmp.copy(points[4]).add(points[8]).multiplyScalar(0.5).sub(pinchWorld);
    for (const p of points) p.sub(tmp);
    handOn = true;
    if (!holding) {
      const hit = pick(eye, dirWorld);
      hover = hit && hit.point.distanceTo(eye) < 30 ? hit : null;
    }
  }

  function onGesture(ev) {
    if (ev.type === 'pinch-start') tryGrab();
    else if (ev.type === 'pinch-blocked') note('先把手張開，再捏');
    else if (ev.type === 'pinch-end' && ev.grabbing && holding) releaseHold(true);
    else if (ev.type === 'cancel') safeDrop(ev.reason || 'lost');
    else if (ev.type === 'lost') handOn = false;
  }

  function tryGrab() {
    if (!hover) {
      gesture.markGrab(false);
      return;
    }
    if (!phys.ready) {
      gesture.markGrab(false);
      note('物理還在準備，等一下再抓');
      return;
    }
    h.beforeGrab(hover.inst);
    if (!phys.grab(hover.inst, hover.point)) {
      gesture.markGrab(false);
      note('這個現在抓不起來');
      return;
    }
    gesture.markGrab(true);
    stats.grabs += 1;
    holding = { inst: hover.inst, dist0: hover.point.distanceTo(eye), hand0: pinchWorld.distanceTo(eye), roll0: roll, q0: phys.holdQuaternion };
    hover = null;
  }

  // fling：正常放開手指＝順著手勢丟（手勢會抖，所以門檻比觸控高）；其他情況一律原地放下
  function releaseHold(fling) {
    if (!holding) return;
    holding = null;
    if (phys.holding) phys.release(fling ? { fling: true, minThrow: 1.2 } : { fling: false });
    if (fling) stats.flings += 1;
    h.afterRelease();
  }

  function safeDrop(reason) {
    gesture.cancel(reason);
    if (!holding) return;
    stats.safeDrops += 1;
    releaseHold(false);
    const why = { lost: '手不見了', 'camera-error': '鏡頭停了', 'camera-paused': '鏡頭暫停', background: '切到背景', portrait: '手機轉直了', exit: '' }[reason] ?? '';
    if (why) note(`${why}：東西已經原地放下`);
  }

  // 每格：抓著的東西跟著手走（方向＝眼睛看出去穿過捏點；遠近＝抓起來那一刻的距離＋手前後移動的放大量）
  function driveHold() {
    if (!holding) return;
    if (!phys.holding) {
      holding = null; // 被別的東西接手了（例如物理被關掉）
      gesture.cancel('external');
      return;
    }
    if (!handOn || lastOut?.status === 'holding-lost') return; // 短暫追不到：東西停在原地等
    const dist = clamp(holding.dist0 + (pinchWorld.distanceTo(eye) - holding.hand0) * DEPTH_GAIN, 0.35, 20);
    tmp.copy(eye).addScaledVector(dirWorld, dist);
    tmp.y = Math.max(tmp.y, 0.05);
    phys.moveHold(tmp);
    const dr = roll - holding.roll0;
    const a = Math.sign(dr) * Math.max(0, Math.abs(dr) - ROLL_DEAD);
    tmpQ.setFromAxisAngle(dirWorld, -a).multiply(holding.q0);
    phys.setHoldQuaternion(tmpQ);
  }

  function setPortrait(on) {
    portrait = on;
    if (overlay) {
      overlay.dataset.portrait = on ? '1' : '0';
      overlay.textContent = on ? '請把手機橫放（如果畫面沒有轉，關掉「直向鎖定」）' : '';
    }
    if (on) {
      safeDrop('portrait');
      gesture.reset();
      tracker.pause();
    } else if ((tracker.state === 'paused' || tracker.state === 'off') && doc.visibilityState !== 'hidden') tracker.start(trackerOpts());
  }

  function onVisibility() {
    if (!active) return;
    if (doc.visibilityState === 'hidden') {
      safeDrop('background');
      gesture.reset();
      tracker.pause();
    } else if (!portrait && tracker.state === 'paused') tracker.start(trackerOpts());
  }

  const trackerOpts = () => ({ hz: settings.cam.hz });

  // ---- 戴著時的觸控：點一下＝校正圖（鏡頭壞了就是重試鏡頭）、按住 1.2 秒＝離開；沒有動作感測時拖曳看四周 ----
  let touch = null;
  function onPointerDown(e) {
    touch = { id: e.pointerId, x: e.clientX, y: e.clientY, t: now(), moved: false };
    overlay.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e) {
    if (!touch || e.pointerId !== touch.id) return;
    const dx = e.clientX - touch.x;
    const dy = e.clientY - touch.y;
    if (!touch.moved && Math.hypot(dx, dy) < 8) return;
    touch.moved = true;
    if (head.usingFallback) head.dragBy(dx * 0.006, dy * 0.006);
    touch.x = e.clientX;
    touch.y = e.clientY;
  }
  function onPointerUp(e) {
    if (!touch || e.pointerId !== touch.id) return;
    const held = now() - touch.t;
    const moved = touch.moved;
    touch = null;
    if (moved) return;
    if (held > 1200) return exit('long-press');
    if (tracker.state === 'error') tracker.start(trackerOpts());
    else calibUntil = calibUntil > now() ? 0 : now() + CALIB_MS;
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      exit('escape');
    }
  }

  function enter() {
    if (active) return false;
    const why = h.canEnter();
    if (typeof why === 'string') {
      h.toast(why);
      return false;
    }
    closeSheet();
    ensureStyle();
    // 權限都要在按鈕的 click 裡「直接」要（iPhone 才會跳出視窗）：動作感測、鏡頭
    const perm = head.request();
    active = true;
    stats.enters += 1;
    saved.pos.copy(camera.position);
    saved.quat.copy(camera.quaternion);
    saved.target.copy(controls.target);
    saved.fov = camera.fov;
    saved.controls = controls.enabled;
    saved.pr = renderer.getPixelRatio();
    controls.enabled = false;
    // 坐著：眼睛放在「看得到作品」的距離（目前看的那一點前方 1.2–2.4 公尺），面向它
    const tgt = controls.target;
    const flat = tmp.set(camera.position.x - tgt.x, 0, camera.position.z - tgt.z);
    const dist = flat.length();
    if (dist < 1e-3) flat.set(0, 0, 1);
    else flat.multiplyScalar(1 / dist);
    yaw0 = Math.atan2(flat.x, flat.z);
    eye.set(tgt.x + flat.x * clamp(dist, 1.2, 2.4), 1.3, tgt.z + flat.z * clamp(dist, 1.2, 2.4));
    camera.position.copy(eye);
    head.recenter(yaw0);
    needRecenter = true;
    stereo = createStereo({ THREE, renderer });
    stereo.setSettings(settings.stereo);
    renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, settings.stereo.renderScale));
    hud = createHud({ THREE, camera, scene });
    hud.placeMenu(eye, yaw0);
    hud.setDiag(null);
    phys.setBeamOrigin((v) => {
      if (handOn) v.copy(pinchWorld);
    });
    overlay = doc.createElement('div');
    overlay.className = 'hs-overlay';
    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('pointercancel', () => (touch = null));
    doc.body.appendChild(overlay);
    doc.body.classList.add('headset');
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pagehide', onVisibility);
    win.addEventListener('keydown', onKey, true);
    gesture.reset();
    gesture.setPrefer(settings.cam.prefer);
    tracker.hz = settings.cam.hz;
    // 這兩個也要在 click 裡：Android 全螢幕＋鎖橫向（iPhone 不支援，會直接失敗，沒關係）
    try {
      const fs = doc.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
      if (fs) {
        wentFullscreen = true;
        fs.then(() => win.screen?.orientation?.lock?.('landscape')).catch(() => {});
      }
    } catch {
      /* 不支援 */
    }
    win.navigator.wakeLock
      ?.request('screen')
      .then((l) => (active ? (wakeLock = l) : l.release()))
      .catch(() => {});
    portrait = win.innerHeight > win.innerWidth;
    setPortrait(portrait); // 橫著：開鏡頭；直著：先提示，轉橫了才開
    perm.then(() => {
      if (active) head.start();
    });
    calibUntil = settings.calibFirst ? now() + CALIB_MS : 0;
    stats.eyesAtEnter = 0;
    h.onEnter();
    return true;
  }

  function exit(reason = 'exit') {
    if (!active) return;
    safeDrop('exit');
    gesture.reset();
    tracker.stop();
    head.stop();
    active = false;
    stats.exits += 1;
    pending = null;
    hover = null;
    handOn = false;
    phys.setBeamOrigin(null);
    stereo?.dispose();
    stereo = null;
    hud?.dispose();
    hud = null;
    overlay?.remove();
    overlay = null;
    doc.body.classList.remove('headset');
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onVisibility);
    win.removeEventListener('keydown', onKey, true);
    wakeLock?.release?.().catch?.(() => {});
    wakeLock = null;
    if (wentFullscreen && doc.fullscreenElement) doc.exitFullscreen?.().catch?.(() => {});
    wentFullscreen = false;
    renderer.setPixelRatio(saved.pr);
    renderer.setScissorTest(false);
    camera.position.copy(saved.pos);
    camera.quaternion.copy(saved.quat);
    camera.fov = saved.fov;
    camera.updateProjectionMatrix();
    controls.target.copy(saved.target);
    controls.enabled = saved.controls;
    h.onExit(reason);
  }

  function statusText() {
    const s = lastOut?.status || 'none';
    const err = tracker.error;
    if (err) return { text: '手勢辨識停了（看下面的說明）', color: '#ffd166', hand: 'paused' };
    if (tracker.state !== 'running') return { text: tracker.state === 'starting' ? '鏡頭啟動中…' : '鏡頭暫停', color: '#9fb8c8', hand: 'paused' };
    if (holding) return s === 'holding-lost' ? { text: '手不見了…東西停在原地', color: '#ffd166', hand: 'paused' } : { text: `抓著「${h.nameOf(holding.inst)}」：張開手指就放下`, color: '#9dff5c', hand: 'grabbing' };
    if (s === 'none' || !handOn) return { text: '把手伸到手機後面（鏡頭前）', color: '#d9f6ff', hand: 'tracking' };
    if (s === 'paused' || !lastOut.armed) return { text: '先把手張開', color: '#d9f6ff', hand: 'paused' };
    if (hover) return { text: `捏下去抓「${h.nameOf(hover.inst)}」`, color: '#fff36b', hand: 'hover' };
    return { text: '用手指向想抓的東西，捏下去就抓起來', color: '#d9f6ff', hand: 'tracking' };
  }

  // 鏡頭／動作感測的狀態：短的一行放狀態板，長的說明（為什麼、怎麼辦）放三行的說明板
  function cameraText() {
    const err = tracker.error;
    const hs = head.state;
    const headHelp = { insecure: '這是 http 連線：手機不給動作感測。拖曳畫面看四周。', denied: '動作感測被拒絕：拖曳畫面看四周。', nosignal: '沒有動作感測訊號：拖曳畫面看四周。', unsupported: '這台裝置沒有動作感測：拖曳畫面看四周。' }[hs];
    if (err) return { text: '鏡頭／手勢辨識有問題', warn: true, help: wrapLines(`${err.message || HAND_ERRORS[err.code] || err.code}${headHelp && hs !== 'insecure' ? headHelp : ''}`) };
    if (headHelp) return { text: '沒有動作感測：拖曳畫面看四周', warn: true, help: hs === 'nosignal' ? null : wrapLines(headHelp) };
    const st = tracker.stats();
    if (tracker.state === 'running') return { text: `鏡頭辨識中 ${st.hz || 0} 次／秒 · 按住螢幕 1.2 秒離開`, warn: false };
    return { text: '', warn: false };
  }

  let diagAt = 0;
  function updateHud(dt) {
    const t = now();
    const fired = hud.gaze(dt);
    if (fired === 'exit') return exit('gaze');
    if (fired === 'recenter') recenter();
    if (fired === 'calib') calibUntil = now() + CALIB_MS;
    hud.tick(t);
    const st = statusText();
    hud.setStatus(st.text, st.color);
    const ct = cameraText();
    hud.setCamera(ct.text, ct.warn);
    hud.setHelp(ct.help);
    if (handOn) {
      const to = holding ? null : hover ? hover.point : rayEnd.copy(pinchWorld).addScaledVector(dirWorld, 3);
      hud.setHand(points, st.hand, pinchWorld, to);
    } else hud.setHand(null);
    hud.showPreview(tracker.state === 'running' && t - handSeenAt > 1500);
    if (settings.diag && t - diagAt > 500) {
      diagAt = t;
      const s = tracker.stats();
      const hs = head.stats();
      hud.setDiag([
        `畫面 ${stats.frameMs.toFixed(1)} ms（${Math.round(1000 / Math.max(1, stats.frameMs))} fps）`,
        `每格畫 ${stereo ? 2 : 0} 眼 · 解析度 ×${renderer.getPixelRatio().toFixed(2)}`,
        `辨識 ${s.inferMs.toFixed(0)} ms · ${s.hz}/${s.hzTarget} 次/秒`,
        `延遲 ${s.latencyMs.toFixed(0)} ms · 過期 ${s.stale}`,
        `頭部 ${hs.state} ${hs.hz} Hz`,
        `鏡頭 ${s.camera ? `${s.camera.width}×${s.camera.height}` : '—'} ${s.delegate || ''}`,
      ]);
    } else if (!settings.diag) hud.setDiag(null);
  }

  function recenter() {
    head.recenter(yaw0);
    hud?.placeMenu(eye, yaw0);
  }

  // 主迴圈每格呼叫（在物理之前）：頭 → 鏡頭、手 → 抓放
  function update(dt) {
    if (!active) return;
    const t = now();
    stats.frames += 1;
    stats.frameMs = stats.frameMs ? stats.frameMs * 0.9 + dt * 1000 * 0.1 : dt * 1000;
    head.tick();
    if (needRecenter && head.state === 'active') {
      head.recenter(yaw0); // 第一次收到感測：把「現在看的方向」對到作品那邊
      needRecenter = false;
    }
    head.get(qHead);
    camera.position.copy(eye);
    camera.quaternion.copy(qHead);
    camera.updateMatrixWorld(true);
    const p = win.innerHeight > win.innerWidth;
    if (p !== portrait) setPortrait(p);
    if (!portrait) tracker.pump(qHead);
    if (pending) {
      const r = pending;
      pending = null;
      observe(r);
    } else if (t > syntheticUntil && t - lastObsT > 400 && t - lastEmptyT > 100) {
      // 辨識結果斷了（鏡頭停、worker 慢）：當作「沒看到手」，交給狀態機判斷追丟
      lastEmptyT = t;
      observe({ t, hands: [], empty: true });
    }
    driveHold();
    if (active) updateHud(dt);
  }

  // 主迴圈最後呼叫：畫左右眼（直著的時候畫黑畫面＋提示）
  function render() {
    if (!active || !stereo) return;
    if (portrait) {
      renderer.setScissorTest(false);
      renderer.setRenderTarget(null);
      renderer.clear();
      return;
    }
    stereo.render(scene, camera, { calibration: calibUntil > now() });
    stats.eyesAtEnter = stereo.info.eyesRendered;
  }

  // ---- 進來之前的設定面板（一般 DOM：還沒戴上） ----
  function closeSheet() {
    sheet?.remove();
    sheet = null;
  }
  function ensureStyle() {
    if (doc.getElementById('hs-style')) return;
    const st = doc.createElement('style');
    st.id = 'hs-style';
    st.textContent = CSS;
    doc.head.appendChild(st);
  }
  function open() {
    if (active) return;
    ensureStyle();
    closeSheet();
    sheet = doc.createElement('div');
    sheet.className = 'hs-sheet';
    sheet.id = 'hsSheet';
    const card = doc.createElement('div');
    card.className = 'hs-card';
    sheet.appendChild(card);
    const secure = win.isSecureContext;
    const fov = fovSummary(win.innerWidth > win.innerHeight ? win.innerWidth : win.innerHeight, win.innerWidth > win.innerHeight ? win.innerHeight : win.innerWidth, settings.stereo);
    card.innerHTML = `
      <h2>👓 手機眼鏡模式（紙盒）</h2>
      <p>把手機<b>橫放</b>進紙盒眼鏡、坐著轉頭看四周。手伸到手機背面的鏡頭前：<b>張開手→指向東西→拇指捏食指</b>就抓起來，張開手指放下。</p>
      <p>戴著時：低頭盯著按鈕 1.5 秒可以「回正／校正圖／離開」；按住螢幕 1.2 秒也會離開。</p>
      ${secure ? '' : '<p class="hs-warn">⚠️ 現在是 http 連線：iPhone 不會給鏡頭和動作感測（要 https 或這台電腦本機），只能拖曳畫面看。</p>'}
      <p class="hs-warn">未校正：手機型號、鏡片還沒指定，下面是可調的預設值（每眼約 ${fov.horizontal}°×${fov.vertical}°）。</p>
      <div class="hs-btns"><button class="hs-go" id="hsGo">開始（橫放手機）</button><button id="hsClose">取消</button></div>
      <details id="hsLens"><summary>鏡片與畫面</summary></details>
      <details id="hsCam"><summary>鏡頭與手</summary></details>
      <div class="hs-row"><label><input type="checkbox" id="hsCalib" ${settings.calibFirst ? 'checked' : ''}/> 進去先看校正圖</label></div>
      <div class="hs-row"><label><input type="checkbox" id="hsDiag" ${settings.diag ? 'checked' : ''}/> 顯示診斷（幀時間、辨識）</label></div>
      <div class="hs-btns"><button id="hsReset">全部恢復預設</button></div>`;
    const lens = card.querySelector('#hsLens');
    const camBox = card.querySelector('#hsCam');
    const presetRow = doc.createElement('div');
    presetRow.className = 'hs-row';
    presetRow.innerHTML = `<label>鏡片類型</label><select id="hsPreset">${Object.entries(LENS_PRESETS)
      .map(([k, p]) => `<option value="${k}" ${settings.stereo.preset === k ? 'selected' : ''}>${p.name}</option>`)
      .join('')}<option value="custom" ${settings.stereo.preset === 'custom' ? 'selected' : ''}>自訂</option></select>`;
    lens.appendChild(presetRow);
    const slider = (box, group, key, label, [lo, hi], step, fmt = (v) => v) => {
      const row = doc.createElement('div');
      row.className = 'hs-row';
      row.innerHTML = `<label>${label}</label><input type="range" min="${lo}" max="${hi}" step="${step}" data-k="${key}"/><output></output>`;
      const input = row.querySelector('input');
      const outEl = row.querySelector('output');
      input.value = settings[group][key];
      outEl.textContent = fmt(settings[group][key]);
      input.oninput = () => {
        const v = Number(input.value);
        if (group === 'stereo') {
          settings.stereo = cleanStereo({ ...settings.stereo, [key]: v, preset: 'custom' });
          card.querySelector('#hsPreset').value = 'custom';
        } else settings.cam = cleanCam({ ...settings.cam, [key]: v });
        outEl.textContent = fmt(settings[group][key]);
        save();
      };
      box.appendChild(row);
    };
    const R = STEREO_RANGE;
    slider(lens, 'stereo', 'ipdMm', '瞳距（公釐）', R.ipdMm, 0.5);
    slider(lens, 'stereo', 'lensSepMm', '鏡片中心距', R.lensSepMm, 0.5);
    slider(lens, 'stereo', 'screenToLensMm', '鏡片到螢幕', R.screenToLensMm, 0.5);
    slider(lens, 'stereo', 'centerY', '鏡片中心高度', R.centerY, 0.01);
    slider(lens, 'stereo', 'k1', '畸變 k1', R.k1, 0.01);
    slider(lens, 'stereo', 'k2', '畸變 k2', R.k2, 0.01);
    slider(lens, 'stereo', 'maxHalfFovDeg', '可視半角（°）', R.maxHalfFovDeg, 1);
    slider(lens, 'stereo', 'pxPerMm', '螢幕密度 px/mm', R.pxPerMm, 0.01);
    slider(lens, 'stereo', 'renderScale', '解析度倍數', R.renderScale, 0.25);
    const distRow = doc.createElement('div');
    distRow.className = 'hs-row';
    distRow.innerHTML = `<label><input type="checkbox" id="hsDistort" ${settings.stereo.distortion ? 'checked' : ''}/> 鏡片畸變校正</label>`;
    lens.appendChild(distRow);
    const rotRow = doc.createElement('div');
    rotRow.className = 'hs-row';
    rotRow.innerHTML = `<label>鏡頭畫面旋轉</label><select id="hsRot">${[0, 90, 180, 270].map((r) => `<option value="${r}" ${settings.cam.rotation === r ? 'selected' : ''}>${r}°</option>`).join('')}</select>
      <label style="flex:0 0 auto"><input type="checkbox" id="hsMirror" ${settings.cam.mirror ? 'checked' : ''}/> 鏡像</label>`;
    camBox.appendChild(rotRow);
    slider(camBox, 'cam', 'hfovDeg', '鏡頭水平視角', CAM_RANGE.hfovDeg, 1);
    slider(camBox, 'cam', 'depthScale', '手的遠近比例', CAM_RANGE.depthScale, 0.05);
    slider(camBox, 'cam', 'offsetX', '鏡頭左右偏移 m', CAM_RANGE.offsetX, 0.005);
    slider(camBox, 'cam', 'hz', '每秒辨識次數', CAM_RANGE.hz, 1);
    const handRow = doc.createElement('div');
    handRow.className = 'hs-row';
    handRow.innerHTML = `<label>主手</label><select id="hsPrefer"><option value="auto">自動（離鏡頭近的）</option><option value="right">右手</option><option value="left">左手</option></select>`;
    camBox.appendChild(handRow);
    card.querySelector('#hsPrefer').value = settings.cam.prefer;
    card.querySelector('#hsPreset').onchange = (e) => {
      const k = e.target.value;
      if (LENS_PRESETS[k]) settings.stereo = cleanStereo({ ...settings.stereo, ...LENS_PRESETS[k], preset: k });
      save();
      open(); // 重畫數值
      sheet.querySelector('#hsLens').open = true;
    };
    card.querySelector('#hsDistort').onchange = (e) => {
      settings.stereo = cleanStereo({ ...settings.stereo, distortion: e.target.checked });
      save();
    };
    card.querySelector('#hsRot').onchange = (e) => {
      settings.cam = cleanCam({ ...settings.cam, rotation: Number(e.target.value) });
      save();
    };
    card.querySelector('#hsMirror').onchange = (e) => {
      settings.cam = cleanCam({ ...settings.cam, mirror: e.target.checked });
      save();
    };
    card.querySelector('#hsPrefer').onchange = (e) => {
      settings.cam = cleanCam({ ...settings.cam, prefer: e.target.value });
      save();
    };
    card.querySelector('#hsCalib').onchange = (e) => {
      settings.calibFirst = e.target.checked;
      save();
    };
    card.querySelector('#hsDiag').onchange = (e) => {
      settings.diag = e.target.checked;
      save();
    };
    card.querySelector('#hsReset').onclick = () => {
      settings = { stereo: { ...STEREO_DEFAULTS }, cam: { ...CAM_DEFAULTS }, diag: false, calibFirst: false };
      save();
      open();
    };
    card.querySelector('#hsClose').onclick = closeSheet;
    card.querySelector('#hsGo').onclick = () => enter(); // 直接在 click 裡（權限）
    sheet.addEventListener('pointerdown', (e) => e.target === sheet && closeSheet());
    doc.body.appendChild(sheet);
  }

  return {
    open,
    enter,
    exit,
    update,
    render,
    recenter,
    get active() {
      return active;
    },
    get settings() {
      return settings;
    },
    setSettings(next = {}) {
      settings = { stereo: cleanStereo({ ...settings.stereo, ...(next.stereo || {}) }), cam: cleanCam({ ...settings.cam, ...(next.cam || {}) }), diag: next.diag ?? settings.diag, calibFirst: next.calibFirst ?? settings.calibFirst };
      stereo?.setSettings(settings.stereo);
      gesture.setPrefer(settings.cam.prefer);
      save();
    },
    showCalibration(ms = CALIB_MS) {
      calibUntil = now() + ms;
    },
    // 合成測試用：直接餵一筆「辨識結果」（跟 worker 回來的格式一樣）；不能拿來代替真的鏡頭＋模型
    injectResult(r) {
      pending = { width: 640, height: 480, headQ: qHead.clone(), ...r, t: r.t ?? now() };
      syntheticUntil = now() + 1500;
    },
    state() {
      return {
        active,
        portrait,
        eye: eye.toArray(),
        cameraQuat: camera.quaternion.toArray(),
        head: head.stats(),
        tracker: tracker.stats(),
        liveTracks: tracker.liveTracks(),
        video: !!tracker.video,
        gesture: gesture.state(),
        handOn,
        pinch: handOn ? pinchWorld.toArray() : null,
        hover: hover?.inst.id ?? null,
        lastHand: lastOut?.hand ? { ratio: lastOut.hand.ratio, pinch: lastOut.hand.pinch, depth: lastOut.hand.depth, palmSize: lastOut.hand.palmSize, handedness: lastOut.hand.handedness, score: lastOut.hand.score } : null,
        holding: holding?.inst.id ?? null,
        calibration: calibUntil > now(),
        stereo: stereo
          ? {
              mode: stereo.info.mode,
              rt: stereo.info.rt,
              eyesRendered: stereo.info.eyesRendered,
              frustums: stereo.info.lastFrustums,
              eyes: stereo.eyes.map((e) => ({ pos: e.position.toArray(), proj: Array.from(e.projectionMatrix.elements) })),
            }
          : null,
        pixelRatio: renderer.getPixelRatio(),
        stats: { ...stats },
      };
    },
  };
}
