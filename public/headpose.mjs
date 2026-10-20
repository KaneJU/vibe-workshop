// 眼鏡模式的轉頭：手機的方向感測（deviceorientation）→ 鏡頭的姿勢。坐著轉頭看四周，不是空間定位（沒有 6DoF）。
// iPhone 要在使用者按下按鈕的那一刻請求「動作與方向」權限，而且只有安全連線（https 或本機）才給；
// 拒絕、不支援、沒有訊號時改用手指／滑鼠拖曳看四周（開發備援，不能代替真的感測）。
// 回正只轉水平方向（yaw）：上下與側傾一定跟著重力，不然地平線會歪。
// deviceQuaternion 和 yawOf 是純數學，Node 測試直接驗。

const DEG = Math.PI / 180;

// W3C 的 alpha／beta／gamma（Z-X'-Y'' 內旋）→ three.js 鏡頭的四元數：
// 鏡頭從手機背面看出去（繞 x 轉 -90°），再依螢幕方向（直拿 0°、橫拿 ±90°）轉回來
export function deviceQuaternion(THREE, alpha, beta, gamma, orientDeg, out = new THREE.Quaternion()) {
  const euler = new THREE.Euler(beta * DEG, alpha * DEG, -gamma * DEG, 'YXZ');
  out.setFromEuler(euler);
  out.multiply(new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2));
  out.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -orientDeg * DEG));
  return out;
}

// 看出去的方向在水平面上的角度（0＝看向 -Z）
export function yawOf(THREE, q) {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return Math.atan2(-f.x, -f.z);
}

// 手機實際是不是橫著（重力在手機的左右方向）：直向鎖定時畫面不會轉，要提醒使用者
export function physicallyLandscape(beta, gamma) {
  const b = beta * DEG;
  const g = gamma * DEG;
  // 重力在手機座標的方向（x 往右、y 往上）
  const gx = Math.cos(b) * Math.sin(g);
  const gy = Math.sin(b);
  return Math.abs(gx) > Math.abs(gy) * 1.2;
}

export function screenAngle(win = globalThis) {
  const a = win.screen?.orientation?.angle;
  if (Number.isFinite(a)) return a;
  const o = win.orientation; // 舊的 iOS
  return Number.isFinite(o) ? o : 0;
}

export function createHeadPose({ THREE, win = globalThis, now = () => performance.now(), signalTimeoutMs = 1500 }) {
  let state = 'idle'; // idle → waiting → active｜denied｜insecure｜unsupported｜nosignal
  let last = null;
  let listening = false;
  let startedAt = 0;
  let yawOffset = 0;
  const drag = { yaw: 0, pitch: 0 };
  const stats = { events: 0, hz: 0, windowStart: 0, windowCount: 0 };
  const qDev = new THREE.Quaternion();
  const qYaw = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);

  function onOrientation(e) {
    if (e.alpha == null && e.beta == null && e.gamma == null) return; // 沒有感測器的電腦會送全部 null
    last = { alpha: e.alpha || 0, beta: e.beta || 0, gamma: e.gamma || 0, t: now() };
    stats.events += 1;
    stats.windowCount += 1;
    if (last.t - stats.windowStart > 1000) {
      stats.hz = Math.round((stats.windowCount * 1000) / (last.t - stats.windowStart || 1));
      stats.windowStart = last.t;
      stats.windowCount = 0;
    }
    if (state === 'waiting' || state === 'nosignal') state = 'active';
  }

  function devicePose(out) {
    return deviceQuaternion(THREE, last.alpha, last.beta, last.gamma, screenAngle(win), out);
  }

  return {
    get state() {
      return state;
    },
    // 有沒有在用拖曳代替感測
    get usingFallback() {
      return state !== 'active';
    },
    // 一定要在按鈕的 click 裡「直接」呼叫（前面不能先 await 別的東西），iPhone 才會跳出權限視窗
    request() {
      if (!win.isSecureContext) {
        state = 'insecure';
        return Promise.resolve('insecure');
      }
      const DOE = win.DeviceOrientationEvent;
      if (!DOE) {
        state = 'unsupported';
        return Promise.resolve('unsupported');
      }
      if (typeof DOE.requestPermission !== 'function') return Promise.resolve('granted'); // Android、電腦：不用問
      return DOE.requestPermission().then(
        (r) => {
          if (r !== 'granted') state = 'denied';
          return r === 'granted' ? 'granted' : 'denied';
        },
        () => {
          state = 'denied';
          return 'denied';
        },
      );
    },
    start() {
      if (listening) return;
      if (state === 'insecure' || state === 'denied' || state === 'unsupported') return;
      win.addEventListener('deviceorientation', onOrientation);
      listening = true;
      startedAt = now();
      state = last ? 'active' : 'waiting';
    },
    stop() {
      if (listening) win.removeEventListener('deviceorientation', onOrientation);
      listening = false;
      last = null;
      if (state === 'active' || state === 'waiting' || state === 'nosignal') state = 'idle';
    },
    // 每格呼叫：等太久沒有訊號就改成拖曳（從最後的姿勢接著拖，畫面不會跳）
    tick() {
      if (state === 'waiting' && now() - startedAt > signalTimeoutMs) state = 'nosignal';
      if (state === 'active' && last && now() - last.t > 3000) {
        const e = new THREE.Euler().setFromQuaternion(this.get(new THREE.Quaternion()), 'YXZ');
        drag.pitch = Math.max(-1.35, Math.min(1.35, e.x));
        drag.yaw = e.y;
        state = 'nosignal';
      }
    },
    // 目前的頭部姿勢（已回正）
    get(out) {
      if (state === 'active' && last) {
        devicePose(qDev);
        return out.copy(qYaw.setFromAxisAngle(UP, yawOffset)).multiply(qDev);
      }
      return out.setFromEuler(new THREE.Euler(drag.pitch, drag.yaw, 0, 'YXZ'));
    },
    // 回正：現在看的方向變成 yaw（只轉水平）；拖曳模式直接看向 yaw、抬頭低頭歸零
    recenter(yaw = 0) {
      if (state === 'active' && last) yawOffset = yaw - yawOf(THREE, devicePose(qDev));
      drag.yaw = yaw;
      drag.pitch = 0;
    },
    // 拖曳看四周（弧度）
    dragBy(dYaw, dPitch) {
      drag.yaw += dYaw;
      drag.pitch = Math.max(-1.35, Math.min(1.35, drag.pitch + dPitch));
    },
    // 手機橫著，但畫面還是直的（直向鎖定）
    get lockedPortrait() {
      if (!last) return false;
      const a = screenAngle(win);
      return (a === 0 || a === 180) && physicallyLandscape(last.beta, last.gamma);
    },
    stats() {
      return { state, hz: stats.hz, events: stats.events, lastAgeMs: last ? Math.round(now() - last.t) : null };
    },
  };
}
