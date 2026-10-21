// 手勢（純邏輯，不碰瀏覽器、不碰物理）：手部辨識的 21 個關鍵點 →
// 「捏的位置、捏了沒、手離鏡頭多遠、手轉了多少」，再用狀態機決定什麼時候抓、放、安全放下。
// - 主手要穩：每次推論找「離上一次主手最近」的那隻；不見超過 lostGraceMs 才算追丟，換一隻手要先重新張開
// - 捏合有遲滯（捏到 pinchOn 以下才算捏、張到 pinchOff 以上才算放）＋防抖（連續幾次、至少多久）
// - 安全：一開始、追丟、低信心、暫停之後都是「未上膛」——要先看到張開的手，捏下去才會抓（避免幽靈抓取）
// 單眼估計手的遠近：MediaPipe 的世界座標（公尺，用一般人的手大小估的）跟畫面上的大小比，所以是「大概」，不是絕對定位；
// 手掌特別大或小的人可以在校正面板調「手的遠近比例」。
// 關鍵點格式：Float32Array(63)，每點 x、y、z（畫面座標 0–1；世界座標公尺）。

export const LM = { WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_TIP: 8, MIDDLE_MCP: 9, RING_MCP: 13, PINKY_MCP: 17 };

export const HAND_DEFAULTS = {
  pinchOn: 0.3, // 拇指尖到食指尖的距離 ÷ 手掌長（手腕到中指根）：小於這個才算捏（實測：捏著約 0.2、張開約 0.75）
  pinchOff: 0.45, // 大於這個才算放開
  onFrames: 2, // 連續幾次推論都捏著才算數
  onMs: 40,
  offFrames: 2,
  offMs: 60,
  armFrames: 3, // 看到幾次張開的手才「上膛」（可以抓）
  lostGraceMs: 300, // 主手短暫不見（被擋、模糊）多久以內還算同一隻；超過就安全放下
  maxJump: 0.22, // 兩次推論之間，主手的手掌中心最多移動多少（畫面寬的比例）
  edge: 0.015, // 捏的位置貼到畫面邊緣：手只拍到一部分，低信心
  minPalm: 0.035, // 手掌太小（太遠、誤判）：低信心
};

const X = (a, i) => a[i * 3];
const Y = (a, i) => a[i * 3 + 1];
const Z = (a, i) => a[i * 3 + 2];

// 鏡頭畫面的旋轉（0／90／180／270）與鏡像：手機鏡頭拍出來的方向跟螢幕不一致時，在校正面板調
export function adjustLandmarks(src, { rotation = 0, mirror = false } = {}, isWorld = false) {
  const out = new Float32Array(src.length);
  const r = ((rotation % 360) + 360) % 360;
  for (let i = 0; i < src.length; i += 3) {
    let x = src[i];
    let y = src[i + 1];
    const c = isWorld ? 0 : 0.5;
    let dx = x - c;
    let dy = y - c;
    if (r === 90) [dx, dy] = [-dy, dx];
    else if (r === 180) [dx, dy] = [-dx, -dy];
    else if (r === 270) [dx, dy] = [dy, -dx];
    x = c + dx;
    y = c + dy;
    if (mirror) x = isWorld ? -x : 1 - x;
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = src[i + 2];
  }
  return out;
}

// 鏡頭內參：水平視角 → 畫面座標 1 單位等於多少 tan 角
export function intrinsics(width, height, hfovDeg, rotation = 0) {
  const swap = rotation % 180 !== 0;
  const w = swap ? height : width;
  const h = swap ? width : height;
  const tanX = Math.tan((hfovDeg * Math.PI) / 360);
  return { w, h, tanX, tanY: (tanX * h) / w };
}

// 畫面座標（0–1，y 往下）＋離鏡頭的深度（公尺，沿著鏡頭正前方）→ 鏡頭座標（x 右、y 上、-z 前）
export function imageToCamera(u, v, depth, intr, out = { x: 0, y: 0, z: 0 }) {
  out.x = (u - 0.5) * 2 * intr.tanX * depth;
  out.y = -(v - 0.5) * 2 * intr.tanY * depth;
  out.z = -depth;
  return out;
}

const DEPTH_PAIRS = [
  [0, 5],
  [0, 17],
  [5, 17],
  [0, 9],
  [0, 13],
  [5, 9],
  [9, 13],
  [13, 17],
];
// 手離鏡頭多遠：每一對關鍵點「世界座標的長度 ÷ 畫面上的長度（tan 角）」，取畫面上最長的五對的中位數
// （太短的那幾對是斜看、被壓扁的，誤差大）
export function estimateDepth(lm, world, intr) {
  const est = [];
  for (const [a, b] of DEPTH_PAIRS) {
    const di = Math.hypot((X(lm, a) - X(lm, b)) * 2 * intr.tanX, (Y(lm, a) - Y(lm, b)) * 2 * intr.tanY);
    const dw = Math.hypot(X(world, a) - X(world, b), Y(world, a) - Y(world, b));
    if (di > 1e-4 && dw > 1e-4) est.push({ di, z: dw / di });
  }
  if (!est.length) return null;
  est.sort((p, q) => q.di - p.di);
  const top = est.slice(0, 5).map((e) => e.z).sort((p, q) => p - q);
  return top[top.length >> 1];
}

export function pinchRatio(lm, world, intr) {
  if (world) {
    const tip = Math.hypot(X(world, 4) - X(world, 8), Y(world, 4) - Y(world, 8), Z(world, 4) - Z(world, 8));
    const palm = Math.hypot(X(world, 0) - X(world, 9), Y(world, 0) - Y(world, 9), Z(world, 0) - Z(world, 9));
    if (palm > 1e-4) return tip / palm;
  }
  const ax = intr ? intr.tanX : 1;
  const ay = intr ? intr.tanY : 1;
  const tip = Math.hypot((X(lm, 4) - X(lm, 8)) * ax, (Y(lm, 4) - Y(lm, 8)) * ay);
  const palm = Math.hypot((X(lm, 0) - X(lm, 9)) * ax, (Y(lm, 0) - Y(lm, 9)) * ay);
  return palm > 1e-6 ? tip / palm : 1;
}

// 一隻手的分析結果：捏的位置（拇指尖與食指尖中間）、捏合程度、遠近、轉角（指根連線的角度）、信心
export function analyzeHand(raw, cam) {
  const adj = { rotation: cam.rotation || 0, mirror: !!cam.mirror };
  const lm = adjustLandmarks(raw.lm, adj);
  const world = raw.world ? adjustLandmarks(raw.world, adj, true) : null;
  const intr = intrinsics(cam.width, cam.height, cam.hfovDeg, adj.rotation);
  let palmX = 0;
  let palmY = 0;
  for (const i of [0, 5, 9, 13, 17]) {
    palmX += X(lm, i) / 5;
    palmY += Y(lm, i) / 5;
  }
  const pinch = { x: (X(lm, 4) + X(lm, 8)) / 2, y: (Y(lm, 4) + Y(lm, 8)) / 2 };
  const palmSize = Math.hypot(X(lm, 0) - X(lm, 9), ((Y(lm, 0) - Y(lm, 9)) * intr.h) / intr.w);
  const ratio = pinchRatio(lm, world, intr);
  let depth = world ? estimateDepth(lm, world, intr) : null;
  if (depth == null) depth = 0.09 / Math.max(palmSize * 2 * intr.tanX, 1e-3); // 沒有世界座標：用一般人的手掌長 9 公分估
  depth *= cam.depthScale || 1;
  // 捏的位置比手的中心近或遠一點（世界座標的 z 是相對手的中心）
  const pinchDepth = depth + (world ? (Z(world, 4) + Z(world, 8)) / 2 : 0);
  const roll = Math.atan2(-(Y(lm, 17) - Y(lm, 5)) * intr.tanY, (X(lm, 17) - X(lm, 5)) * intr.tanX);
  const e = cam.edge ?? HAND_DEFAULTS.edge;
  let why = null;
  if (pinch.x < e || pinch.x > 1 - e || pinch.y < e || pinch.y > 1 - e) why = 'edge';
  else if (palmSize < (cam.minPalm ?? HAND_DEFAULTS.minPalm)) why = 'small';
  else if (!(depth > 0.05 && depth < 2.5)) why = 'depth';
  return {
    lm,
    world,
    intr,
    palm: { x: palmX, y: palmY },
    pinch,
    palmSize,
    ratio,
    depth: Math.min(1.5, Math.max(0.12, depth)),
    pinchDepth: Math.min(1.5, Math.max(0.1, pinchDepth)),
    roll,
    handedness: raw.handedness || null,
    score: raw.score ?? null,
    lowConf: !!why,
    why,
  };
}

// One Euro 濾波：慢的時候很穩、快的時候跟得上（Casiez 2012）
export class OneEuro {
  constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() {
    this.t = null;
    this.x = 0;
    this.dx = 0;
  }
  filter(x, tSec) {
    if (this.t == null || !Number.isFinite(this.x)) {
      this.t = tSec;
      this.x = x;
      this.dx = 0;
      return x;
    }
    const dt = Math.max(1e-3, tSec - this.t);
    const a = (cutoff) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.dx += a(this.dCutoff) * ((x - this.x) / dt - this.dx);
    this.x += a(this.minCutoff + this.beta * Math.abs(this.dx)) * (x - this.x);
    this.t = tSec;
    return this.x;
  }
}

export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// 狀態機。update(obs) 的 obs：{ t（拍下那一格的時間，ms）, hands: analyzeHand 的結果 }，
// 回傳這次的事件：acquire（找到主手）、armed（看到張開的手，可以抓了）、pinch-start（上膛後捏下去）、
// pinch-blocked（沒上膛就捏著：不抓）、pinch-end（放開；grabbing＝那時有沒有抓著）、cancel（追丟／換手：要安全放下）、lost
export function createGesture(options = {}) {
  const o = { ...HAND_DEFAULTS, ...options };
  let primary = null;
  let armed = false;
  let grabbing = false;
  let nextId = 1;
  let prefer = o.prefer || 'auto';

  function choose(hands) {
    if (prefer === 'right') return hands.reduce((a, b) => (b.palm.x > a.palm.x ? b : a));
    if (prefer === 'left') return hands.reduce((a, b) => (b.palm.x < a.palm.x ? b : a));
    return hands.reduce((a, b) => (b.palmSize > a.palmSize ? b : a)); // 自動：離鏡頭最近（看起來最大）的那隻
  }

  function drop(events, reason) {
    if (grabbing) events.push({ type: 'cancel', reason });
    grabbing = false;
    armed = false;
  }

  function update(obs) {
    const t = obs.t;
    const events = [];
    const hands = (obs.hands || []).filter((h) => !h.lowConf);
    let match = null;
    if (primary) {
      const dt = Math.min(0.2, Math.max(0, (t - primary.t) / 1000));
      const px = primary.palm.x + primary.vel.x * dt;
      const py = primary.palm.y + primary.vel.y * dt;
      let best = Infinity;
      for (const h of hands) {
        // 離「照速度預測的位置」或「上一次的位置」近的都算：手移動後突然停住、下一格又隔比較久（卡頓、辨識變慢）時，
        // 預測會衝過頭，停住的手不能因此被當成另一隻（那樣捏下去會被擋成「先把手張開」）
        const d = Math.min(Math.hypot(h.palm.x - px, h.palm.y - py), Math.hypot(h.palm.x - primary.palm.x, h.palm.y - primary.palm.y));
        if (d < best) {
          best = d;
          match = h;
        }
      }
      if (best > o.maxJump) match = null;
      if (!match) {
        primary.missingSince ??= t;
        if (t - primary.missingSince > o.lostGraceMs) {
          drop(events, 'lost');
          events.push({ type: 'lost', id: primary.id });
          primary = null;
        }
      }
    }
    if (!primary && hands.length) {
      match = choose(hands);
      primary = { id: nextId++, palm: { ...match.palm }, vel: { x: 0, y: 0 }, t, missingSince: null, pinched: match.ratio < o.pinchOn, onCount: 0, onSince: null, offCount: 0, offSince: null, openCount: 0 };
      armed = false; // 新的一隻手：要先看到它張開
      events.push({ type: 'acquire', id: primary.id });
    }
    if (primary && match) {
      const p = primary;
      const dt = Math.max(1e-3, (t - p.t) / 1000);
      if (t > p.t) {
        p.vel.x = 0.5 * p.vel.x + 0.5 * ((match.palm.x - p.palm.x) / dt);
        p.vel.y = 0.5 * p.vel.y + 0.5 * ((match.palm.y - p.palm.y) / dt);
      }
      p.palm = { ...match.palm };
      p.t = t;
      p.missingSince = null;
      const r = match.ratio;
      if (!p.pinched) {
        if (r < o.pinchOn) {
          p.onCount += 1;
          p.onSince ??= t;
          if (p.onCount >= o.onFrames && t - p.onSince >= o.onMs) {
            p.pinched = true;
            p.onCount = 0;
            p.onSince = null;
            events.push({ type: armed ? 'pinch-start' : 'pinch-blocked' });
          }
        } else {
          p.onCount = 0;
          p.onSince = null;
        }
      } else if (r > o.pinchOff) {
        p.offCount += 1;
        p.offSince ??= t;
        if (p.offCount >= o.offFrames && t - p.offSince >= o.offMs) {
          p.pinched = false;
          p.offCount = 0;
          p.offSince = null;
          events.push({ type: 'pinch-end', grabbing });
          grabbing = false;
        }
      } else {
        p.offCount = 0;
        p.offSince = null;
      }
      if (!p.pinched && r > o.pinchOff) {
        p.openCount += 1;
        if (!armed && p.openCount >= o.armFrames) {
          armed = true;
          events.push({ type: 'armed' });
        }
      } else p.openCount = 0;
    }
    return { t, events, fresh: !!match, hand: match, ...snapshot() };
  }

  function snapshot() {
    let status = 'none';
    if (primary) {
      if (grabbing) status = primary.missingSince != null ? 'holding-lost' : 'grabbing';
      else if (primary.missingSince != null || (primary.pinched && !armed)) status = 'paused';
      else status = 'tracking';
    }
    return { status, armed, grabbing, primaryId: primary?.id ?? null, pinched: !!primary?.pinched };
  }

  return {
    update,
    // 外面真的抓起來了（捏下去時剛好指著東西、物理也接受）
    markGrab(ok = true) {
      grabbing = !!ok && !!primary;
    },
    // 外面要安全放下（關鏡頭、切背景、轉直、離開、物理被關）：之後要重新張開手才能抓
    cancel(reason = 'cancel') {
      const was = grabbing;
      grabbing = false;
      armed = false;
      if (primary) primary.openCount = 0;
      return was;
    },
    // 暫停（不再有影像進來）：連主手都忘掉，恢復後重新找、重新上膛
    reset() {
      grabbing = false;
      armed = false;
      primary = null;
    },
    setPrefer(p) {
      prefer = ['left', 'right'].includes(p) ? p : 'auto';
    },
    get options() {
      return o;
    },
    state: snapshot,
  };
}
