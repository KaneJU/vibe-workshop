// 眼鏡模式＋創作世界的瀏覽器測試替身（tests/headset-create.mjs、tests/headset-real.mjs 共用）：只換掉「硬體」——
// 鏡頭（canvas 假畫面）、手勢 worker（回傳合成關鍵點）、語音辨識（測試推結果）、動作感測（測試送事件）；
// 伺服器、沙盒、connector、作品程式都是真的。這些替身不代表真手機、真模型推論或真麥克風。
// ---------------- 頁面裡的測試替身 ----------------
export function INIT() {
  if (window.top !== window) return; // 沙盒 iframe 不用
  localStorage.setItem('vw_help_seen', '1');
  Element.prototype.requestFullscreen = undefined; // 跟 iPhone Safari 一樣沒有元素全螢幕
  // 事件監聽計數（只算 window／document）：反覆進出後要回到原來
  window.__listeners = {};
  const wrapAdd = EventTarget.prototype.addEventListener;
  const wrapRemove = EventTarget.prototype.removeEventListener;
  const key = (t, type, opt) => `${t === window ? 'win' : 'doc'}:${type}:${opt === true || opt?.capture ? 'c' : ''}`;
  const live = new Map();
  EventTarget.prototype.addEventListener = function add(type, fn, opt) {
    if ((this === window || this === document) && fn) {
      const k = key(this, type, opt);
      const set = live.get(k) || new Set();
      set.add(fn);
      live.set(k, set);
    }
    return wrapAdd.call(this, type, fn, opt);
  };
  EventTarget.prototype.removeEventListener = function remove(type, fn, opt) {
    if (this === window || this === document) live.get(key(this, type, opt))?.delete(fn);
    return wrapRemove.call(this, type, fn, opt);
  };
  window.__listenerCounts = () => Object.fromEntries([...live].map(([k, s]) => [k, s.size]).filter(([, n]) => n));
  // 假的語音辨識：記錄 start 時有沒有使用者手勢；__srRejectNoGesture＝模擬「不是使用者手勢就拒絕」的瀏覽器
  window.__sr = null;
  window.__srLog = { starts: 0, gestureStarts: 0, nonGesture: 0, aborts: 0, stops: 0 };
  class FakeSR {
    constructor() {
      window.__sr = this;
      this.dead = false;
    }
    start() {
      const g = navigator.userActivation ? navigator.userActivation.isActive : null;
      window.__srLog.starts += 1;
      if (g) window.__srLog.gestureStarts += 1;
      else window.__srLog.nonGesture += 1;
      if (window.__srRejectNoGesture && !g) {
        setTimeout(() => {
          this.onerror?.({ error: 'not-allowed' });
          this.onend?.();
        }, 5);
      }
    }
    stop() {
      window.__srLog.stops += 1;
      setTimeout(() => this.onend?.(), 10);
    }
    abort() {
      window.__srLog.aborts += 1;
      setTimeout(() => this.onend?.(), 10);
    }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
  // 推辨識結果（就算辨識器已經被取消，也照樣推——模擬瀏覽器晚到的結果）
  window.__say = (text, isFinal, sr = window.__sr) => {
    const r = Object.assign([{ transcript: text }], { isFinal });
    sr?.onresult?.({ resultIndex: 0, results: [r] });
    if (isFinal) setTimeout(() => sr?.onend?.(), 20);
  };
  // 假鏡頭：canvas 畫面一直在動（captureStream）；每一條串流都記下來，用真的 track.readyState 檢查有沒有被關掉
  window.__gum = [];
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const cx = canvas.getContext('2d');
  let f = 0;
  setInterval(() => {
    f += 1;
    cx.fillStyle = `hsl(${(f * 7) % 360},40%,30%)`;
    cx.fillRect(0, 0, 640, 480);
    cx.fillStyle = '#fff';
    cx.fillRect((f * 9) % 600, 200, 40, 40);
  }, 33);
  if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
  const fakeGum = async (c) => {
    if (!c?.video) throw Object.assign(new Error('no audio here'), { name: 'NotFoundError' });
    const st = canvas.captureStream(30);
    const tr = st.getVideoTracks()[0];
    const real = tr.getSettings.bind(tr);
    tr.getSettings = () => ({ ...real(), width: 640, height: 480, facingMode: 'environment' });
    window.__gum.push(st);
    return st;
  };
  // WebKit 不認在 navigator.mediaDevices 上直接指定的方法：蓋在原型上（兩種引擎都一樣）
  const proto = Object.getPrototypeOf(navigator.mediaDevices);
  Object.defineProperty(proto && proto !== Object.prototype ? proto : navigator.mediaDevices, 'getUserMedia', { value: fakeGum, configurable: true, writable: true });
  window.__trackStates = () => window.__gum.map((st) => st.getTracks().map((t) => t.readyState).join('+'));
  // 假的手勢 worker：每次 detect 回傳 window.__fakeHands（合成關鍵點）
  window.__fakeHands = [];
  window.__workers = { created: 0, terminated: 0 };
  const RealWorker = window.Worker;
  window.Worker = function FakeOrReal(url, opts) {
    if (!String(url).includes('handworker')) return new RealWorker(url, opts);
    window.__workers.created += 1;
    const w = {
      onmessage: null,
      onerror: null,
      dead: false,
      postMessage(m) {
        if (w.dead) return;
        if (m.type === 'init') setTimeout(() => !w.dead && w.onmessage?.({ data: { type: 'ready', delegate: 'CPU' } }), 5);
        else if (m.type === 'detect') {
          m.bitmap?.close?.();
          const hands = window.__fakeHands.map((h) => ({ lm: new Float32Array(h.lm), world: new Float32Array(h.world), handedness: h.handedness, score: h.score }));
          // __fakeHandDelayMs：模擬辨識比較慢（例如軟體繪圖下只有 7 Hz）；手的位置照送出那一格（像真的鏡頭延遲）
          setTimeout(() => !w.dead && w.onmessage?.({ data: { type: 'result', seq: m.seq, ms: 2, hands } }), window.__fakeHandDelayMs ?? 3);
        }
      },
      terminate() {
        if (!w.dead) window.__workers.terminated += 1;
        w.dead = true;
      },
    };
    return w;
  };
  // WebKit 桌面沒有 DeviceOrientationEvent：補一個最小的（只給測試送感測事件用）
  if (!window.DeviceOrientationEvent) {
    window.DeviceOrientationEvent = class extends Event {
      constructor(type, init = {}) {
        super(type);
        this.alpha = init.alpha ?? null;
        this.beta = init.beta ?? null;
        this.gamma = init.gamma ?? null;
      }
    };
  }
}

export const HELPERS = `
  window.__frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // 合成一隻手（open=1 張開、0 捏住），讓「眼睛 → 捏點」的射線穿過 target（世界座標）；照目前的鏡頭偏移（左右、上下、前後）反解
  window.__handAt = async (open, target, extraEye = [0, 0, 0]) => {
    const { analyzeHand, intrinsics } = await import('/hands.mjs');
    const THREE = window.__ws.THREE;
    const hs = window.__ws.headset;
    const st = hs.state();
    const cam = hs.settings.cam;
    const make = (cx, cy) => {
      const lm = new Float32Array(63);
      const world = new Float32Array(63);
      const set = (i, x, y) => { lm.set([cx + x * 0.22, cy + y * 0.22, 0], i * 3); world.set([x * 0.09, -y * 0.09, 0], i * 3); };
      set(0, 0, 0.5); set(5, -0.25, -0.4); set(9, 0, -0.5); set(13, 0.2, -0.45); set(17, 0.38, -0.35);
      const gap = 0.12 + open * 0.68;
      set(8, -0.3, -1.05); set(4, -0.3 - gap * 0.8, -1.05 + gap * 0.6);
      for (const i of [1, 2, 3, 6, 7, 10, 11, 12, 14, 15, 16, 18, 19, 20]) set(i, 0, 0);
      return { lm: Array.from(lm), world: Array.from(world), handedness: 'Right', score: 0.95 };
    };
    const a = analyzeHand({ ...make(0.5, 0.5), lm: new Float32Array(make(0.5, 0.5).lm), world: new Float32Array(make(0.5, 0.5).world) }, { ...cam, width: 640, height: 480 });
    const intr = intrinsics(640, 480, cam.hfovDeg, cam.rotation);
    const eye = new THREE.Vector3().fromArray(st.eye);
    const c = new THREE.Vector3().fromArray(target).sub(eye).applyQuaternion(new THREE.Quaternion().fromArray(st.cameraQuat).invert());
    const d = a.pinchDepth;
    const zt = d + cam.offsetZ;
    // 捏點（眼睛座標）要在射線上：x/(−z) 相同；extraEye：故意讓手偏一點（對位檢查用）
    const px = (c.x / -c.z) * zt - cam.offsetX + extraEye[0];
    const py = (c.y / -c.z) * zt - cam.offsetY + extraEye[1];
    const u = 0.5 + px / (2 * intr.tanX * d);
    const v = 0.5 - py / (2 * intr.tanY * d);
    window.__fakeHands = [make(0.5 + (u - a.pinch.x), 0.5 + (v - a.pinch.y))];
    // 記下最後一次放手的位置（等待逾時時印出來：手是不是放到鏡頭畫面外、被當成低信心）
    const h = window.__fakeHands[0];
    const chk = analyzeHand({ ...h, lm: new Float32Array(h.lm), world: new Float32Array(h.world) }, { ...cam, width: 640, height: 480 });
    window.__lastHandAt = { open, u: +u.toFixed(3), v: +v.toFixed(3), lowConf: !!chk.lowConf, at: Math.round(performance.now()) };
    return { u, v, d };
  };
  // 直接指定捏點在鏡頭畫面上的位置（u、v：0–1）
  window.__handImage = async (open, u, v) => {
    const { analyzeHand } = await import('/hands.mjs');
    const cam = window.__ws.headset.settings.cam;
    const make = (cx, cy) => {
      const lm = new Float32Array(63);
      const world = new Float32Array(63);
      const set = (i, x, y) => { lm.set([cx + x * 0.22, cy + y * 0.22, 0], i * 3); world.set([x * 0.09, -y * 0.09, 0], i * 3); };
      set(0, 0, 0.5); set(5, -0.25, -0.4); set(9, 0, -0.5); set(13, 0.2, -0.45); set(17, 0.38, -0.35);
      const gap = 0.12 + open * 0.68;
      set(8, -0.3, -1.05); set(4, -0.3 - gap * 0.8, -1.05 + gap * 0.6);
      for (const i of [1, 2, 3, 6, 7, 10, 11, 12, 14, 15, 16, 18, 19, 20]) set(i, 0, 0);
      return { lm, world, handedness: 'Right', score: 0.95 };
    };
    const a = analyzeHand(make(0.5, 0.5), { ...cam, width: 640, height: 480 });
    const h = make(0.5 + (u - a.pinch.x), 0.5 + (v - a.pinch.y));
    window.__fakeHands = [{ lm: Array.from(h.lm), world: Array.from(h.world), handedness: 'Right', score: 0.95 }];
    return { u, v };
  };
  window.__noHand = () => { window.__fakeHands = []; };
  // 轉頭看向某一點（模擬動作感測；依當下螢幕角度反解 headpose 的公式）
  window.__lookAt = async (target) => {
    const { deviceQuaternion, yawOf, screenAngle } = await import('/headpose.mjs');
    const THREE = window.__ws.THREE;
    const A = screenAngle(window);
    const st = window.__ws.headset.state();
    const d = new THREE.Vector3().fromArray(target).sub(new THREE.Vector3().fromArray(st.eye)).normalize();
    let offset = 0;
    if (window.__sensor) offset = yawOf(THREE, new THREE.Quaternion().fromArray(st.cameraQuat)) - yawOf(THREE, deviceQuaternion(THREE, window.__sensor.alpha, window.__sensor.beta, window.__sensor.gamma, A));
    const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.asin(d.y), Math.atan2(-d.x, -d.z) - offset, 0, 'YXZ'));
    const q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
    const q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (-A * Math.PI) / 180);
    const e = new THREE.Euler().setFromQuaternion(want.multiply(q0.invert()).multiply(q1.invert()), 'YXZ');
    window.__sensor = { alpha: (e.y * 180) / Math.PI, beta: (e.x * 180) / Math.PI, gamma: (-e.z * 180) / Math.PI };
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', window.__sensor));
    window.__sensorTimer ??= setInterval(() => window.__sensor && window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', window.__sensor)), 50);
    await window.__frames(3);
  };
  window.__stopSensor = () => { clearInterval(window.__sensorTimer); window.__sensorTimer = null; window.__sensor = null; };
  const P = (o) => o.getWorldPosition(new window.__ws.THREE.Vector3()).toArray();
  window.__menuPos = (id) => { const m = window.__ws.scene.getObjectByName('headset-menu'); m.updateMatrixWorld(true); let b = null; m?.traverse((c) => c.userData.buttonId === id && (b = c)); return b ? P(b) : null; };
  window.__menuTabPos = () => window.__menuPos('menu:open');
  // 看選單時視線停的地方：標題那一帶（在底板上、不在任何按鈕上），盯著不會把按鈕按下去
  window.__menuGazeSpot = () => { const m = window.__ws.scene.getObjectByName('headset-menu'); m.updateMatrixWorld(true); return m.localToWorld(new window.__ws.THREE.Vector3(0, 0.15, 0)).toArray(); };
  window.__menuCenter = () => P(window.__ws.scene.getObjectByName('headset-menu'));
  window.__padPos = (k) => { const pad = window.__ws.scene.getObjectByName('headset-pad'); window.__ws.camera.updateMatrixWorld(true); const b = pad?.children.find((c) => c.userData.padKey === k); return b ? P(b) : null; };
  window.__entityPos = (hostId, ent) => {
    const g = window.__ws.scene.getObjectByName('creation-items').children.find((c) => c.userData.instId === hostId);
    let m = null;
    g?.traverse((o) => o.userData?.entityId === ent && (m = o));
    return m ? P(m) : null;
  };
  window.__entities = (hostId, prefix) => {
    const g = window.__ws.scene.getObjectByName('creation-items').children.find((c) => c.userData.instId === hostId);
    const out = [];
    g?.traverse((o) => typeof o.userData?.entityId === 'string' && o.userData.entityId.startsWith(prefix) && o.visible && out.push({ id: o.userData.entityId, pos: P(o) }));
    return out;
  };
`;
