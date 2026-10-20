// 冒險模式「小紅的信號塔」：把工坊的基本功串成一個有開頭、有結局的小遊戲（手機直拿優先，電腦一樣能玩）
//   第 1 關 點亮能量塔：按住能量方塊、拖到充電座（學會：拖曳搬東西）
//   第 2 關 組裝探險車：把輪子、操縱桿拖到木板旁邊裝上，按 ⚡ 試車（學會：組合零件、啟動裝置）
//   第 3 關 開到信號塔：用搖桿開自己組的車，穿過兩個能量環，抵達信號塔（學會：駕駛）
// 只用內建零件（examples/starter），完全不需要 AI。進度存在伺服器的 adventure.json，跟自由工坊的場景、工具箱分開。
// 過關一定要靠玩家自己操作：輔助只做「吸附對準」與「救援歸位」（回到起點或檢查點），不會替玩家判定過關。

export const PART = {
  cube: 'p_mvf5xgk6a7157a', // 藍光能量方塊
  tower: 'c_mvf61nt4b1daa6', // 能量塔（兩個能量方塊疊成）
  robot: 'p_mvf636ce28ed26', // 轉頭小機器人＝小紅
  board: 'p_mvfvu5sya31395', // 木板
  wheel: 'p_mvfvsvqx27ac2d', // 輪子（馬達）
  steer: 'p_mvfvtn2i4926fc', // 操縱桿
};
export const ADVENTURE_PARTS = Object.values(PART);

const LEVELS = [
  { n: 1, name: '點亮能量塔', learn: '按住拖曳，就能搬東西' },
  { n: 2, name: '組裝探險車', learn: '把零件拖到車身旁邊就能組裝；⚡ 會啟動裝置' },
  { n: 3, name: '開到信號塔', learn: '用搖桿開自己組的車' },
];

// ---- 場地（公尺；+Z 朝向一開始的鏡頭，車子往 -Z 開） ----
// 第 1 關在最靠近鏡頭的地方（+Z），之後的關卡往 -Z 走，前一關的東西不會擋到下一關的鏡頭
const L1 = { cube: [-0.8, 0, 13.0], pad: [0.78, 0, 12.1], padR: 0.62, tower: [1.15, 0, 10.65], cam: [0, 2.35, 16.1], look: [0, 0.45, 10.9] };
const ROBOT = { 1: [-0.55, 0, 10.25, 0.5], 2: [-1.55, 0, -0.3, 0.7], 3: [-3.0, 0, -17.6, 0.6] }; // 小紅跟著你走：每一關站的位置（最後一個是轉向）
const L2 = {
  board: [0, 0.314, 0.6], // 木板底部離地＝輪子半徑 × 0.9（跟 tests/physics.mjs 的小車一樣，實測能開）
  yaw: Math.PI, // 車頭朝 -Z（往信號塔）
  tray: { w0: [-1.2, 0, 2.45], w1: [1.2, 0, 2.45], w2: [-1.2, 0, 3.35], w3: [1.2, 0, 3.35], st: [0, 0, 2.95] },
  lineZ: -2.0, // 試車要開過的起跑線
  cam: [0, 4.0, 7.3],
  look: [0, 0.2, 1.4],
};
const L3 = {
  start: [0, 0.314, -2.7],
  cps: [
    [-3.0, 0, -7.5],
    [2.8, 0, -13.0],
  ],
  goal: [0, 0, -18.6],
  cpR: 2.3,
  goalR: 2.5,
  cam: [0.6, 3.4, 2.6],
  look: [-0.8, 0.3, -5.5],
};
// 車子的藍圖（木板自己的座標；木板原點在底面中心、長邊沿 Z、+Z 是車頭）
const SOCKETS = [
  { key: 'w0', kind: 'wheel', pos: [-0.689, -0.314, 0.7] },
  { key: 'w1', kind: 'wheel', pos: [0.689, -0.314, 0.7] },
  { key: 'w2', kind: 'wheel', pos: [-0.689, -0.314, -0.7] },
  { key: 'w3', kind: 'wheel', pos: [0.689, -0.314, -0.7] },
  { key: 'st', kind: 'steer', pos: [0, 0.12, -0.15] },
];
const LOOSE = ['w0', 'w1', 'w2', 'w3', 'st']; // 第 2 關散在地上的零件（存檔的 ids 用這幾個名字）
const kindOfSlot = (slot) => (slot === 'st' ? 'steer' : 'wheel');
const PART_OF_KIND = { wheel: PART.wheel, steer: PART.steer };
const KIND_LABEL = { wheel: '輪子', steer: '操縱桿' };
const SNAP_SOCKET = 0.75; // 放在空位 75 公分內就吸上去
const SNAP_CART = 1.5; // 或放在車身中心 1.5 公尺內（自動找最近的空位）
const SNAP_PAD = 1.1; // 能量方塊放在充電座 1.1 公尺內就吸到中間

const fmt = (s) => {
  const t = Math.max(0, Math.round(s || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export function createAdventure(env) {
  const { THREE, scene, camera, controls, renderer, runtime, instances, phys, engine, isTouch } = env;
  const $ = (s) => document.querySelector(s);
  const UP = new THREE.Vector3(0, 1, 0);
  const ONE = new THREE.Vector3(1, 1, 1);
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const yawQ = (yaw) => new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  const flatDist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

  const fx = new THREE.Group();
  fx.name = 'adventure';
  scene.add(fx);

  let P = null; // 進度（存到伺服器）
  let lastHeld = null;
  let anim = null; // 吸附動畫
  let card = null; // 目前打開的卡片
  let hudTimer = 0;
  let trouble = null; // 偵測到的問題（按鈕會閃）
  let troubleT = 0;
  let testT = 0;
  let lastProgressT = 0;
  let bestTargetDist = Infinity;
  let handT = 0;
  let firstGrabDone = false;
  const decorUpdaters = [];

  // ---------------- 小工具 ----------------

  const get = (slot) => (P?.ids?.[slot] ? instances.get(P.ids[slot]) : null);
  function spawn(slot, partId, pos, yaw = 0) {
    const id = env.newInstanceId();
    const inst = env.addInstance({ id, partId, position: [...pos], quaternion: yawQ(yaw).toArray(), scale: [1, 1, 1] }, { save: false });
    P.ids[slot] = id;
    return inst;
  }
  function centerOf(inst) {
    return env.worldBox(inst).getCenter(new THREE.Vector3());
  }
  function groupCenter(inst) {
    const b = new THREE.Box3();
    for (const m of env.glueMembers(inst)) b.union(env.worldBox(m));
    return b.getCenter(new THREE.Vector3());
  }
  const uprightness = (inst) => UP.clone().applyQuaternion(inst.object.quaternion).y;
  // 整組（黏在一起的）一起搬：算出錨點要去的位置，其他成員照原本的相對位置跟著走（物理引擎會跟過去）
  function moveGroup(anchor, pos, yaw) {
    const members = env.glueMembers(anchor);
    anchor.object.updateMatrixWorld(true);
    const target = new THREE.Matrix4().compose(V(pos), yawQ(yaw), ONE);
    const delta = target.multiply(anchor.object.matrixWorld.clone().invert());
    const s = new THREE.Vector3();
    for (const m of members) {
      m.object.updateMatrixWorld(true);
      new THREE.Matrix4().multiplyMatrices(delta, m.object.matrixWorld).decompose(m.object.position, m.object.quaternion, s);
      m.object.updateMatrixWorld(true);
    }
  }
  function setPose(inst, pos, q) {
    inst.object.position.copy(pos);
    inst.object.quaternion.copy(q);
    inst.object.updateMatrixWorld(true);
  }
  function socketMatrix(board, s) {
    board.object.updateMatrixWorld(true);
    return new THREE.Matrix4().multiplyMatrices(board.object.matrixWorld, new THREE.Matrix4().makeTranslation(...s.pos));
  }

  // ---------------- 音效（很小聲；沒有 WebAudio 就算了） ----------------

  let audio = null;
  function sfx(kind) {
    try {
      audio ??= new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const notes = { snap: [880, 1320], ok: [660, 880, 1320], clear: [523, 659, 784, 1046], win: [523, 659, 784, 1046, 1318, 1568] }[kind] || [660];
      notes.forEach((f, i) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = 'triangle';
        o.frequency.value = f;
        const t0 = audio.currentTime + i * 0.09;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        o.connect(g).connect(audio.destination);
        o.start(t0);
        o.stop(t0 + 0.35);
      });
    } catch {
      /* 沒有聲音也能玩 */
    }
  }

  // ---------------- 場景裝飾（不是物件：點不到、沒有物理、不存檔） ----------------

  function glowMat(color, opacity = 0.85) {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  }
  function captureGlow(obj) {
    obj.traverse((o) => {
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        if (m.emissive && m.userData.e0 === undefined) m.userData.e0 = m.emissiveIntensity;
      }
    });
  }
  function setGlow(obj, k) {
    obj.traverse((o) => {
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        if (m.userData.e0 !== undefined) m.emissiveIntensity = m.userData.e0 * k;
      }
    });
  }
  function decorPart(partId, pos, yaw = 0) {
    const built = runtime.instantiate(partId);
    const o = built.object;
    o.position.copy(V(pos));
    o.quaternion.copy(yawQ(yaw));
    o.traverse((m) => {
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    fx.add(o);
    for (const u of built.updaters) decorUpdaters.push(u);
    return o;
  }
  // 半透明的「這裡裝一個」預覽
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.22, depthWrite: false });
  const ghostHot = new THREE.MeshBasicMaterial({ color: 0x9dff5c, transparent: true, opacity: 0.55, depthWrite: false });
  function ghostOf(partId) {
    const o = runtime.instantiate(partId).object;
    o.traverse((m) => {
      if (m.isMesh) {
        m.material = ghostMat;
        m.castShadow = false;
      }
    });
    fx.add(o);
    return o;
  }
  function setGhostHot(g, hot) {
    g.traverse((m) => {
      if (m.isMesh) m.material = hot ? ghostHot : ghostMat;
    });
  }
  function ring(radius, tube, color, opacity = 0.9) {
    return new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 72), glowMat(color, opacity));
  }
  function beam(height, radius, color, opacity = 0.18) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 16, 1, true), glowMat(color, opacity));
    m.position.y = height / 2;
    return m;
  }
  function boltTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#7cecff';
    g.beginPath();
    for (const [x, y] of [[74, 8], [30, 70], [60, 70], [48, 120], [98, 52], [66, 52], [82, 8]]) g.lineTo(x, y);
    g.closePath();
    g.fill();
    return new THREE.CanvasTexture(c);
  }

  const D = {}; // 所有裝飾
  function buildDecor() {
    // 第 1 關：充電座、能量塔、小紅
    D.pad = new THREE.Group();
    D.pad.position.copy(V(L1.pad));
    const disk = new THREE.Mesh(new THREE.CircleGeometry(L1.padR, 48), new THREE.MeshStandardMaterial({ color: 0x0c2433, emissive: 0x0b6f8f, emissiveIntensity: 0.5, roughness: 0.6 }));
    disk.rotation.x = -Math.PI / 2;
    disk.position.y = 0.004;
    disk.receiveShadow = true;
    const bolt = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshBasicMaterial({ map: boltTexture(), transparent: true, depthWrite: false }));
    bolt.rotation.x = -Math.PI / 2;
    bolt.position.y = 0.008;
    D.padRing = new THREE.Mesh(new THREE.RingGeometry(L1.padR, L1.padR + 0.09, 72), glowMat(0x38e1ff, 0.9));
    D.padRing.rotation.x = -Math.PI / 2;
    D.padRing.position.y = 0.01;
    D.padBeam = beam(2.4, L1.padR * 0.92, 0x38e1ff, 0.07);
    D.pad.add(disk, bolt, D.padRing, D.padBeam);
    fx.add(D.pad);
    D.tower = decorPart(PART.tower, L1.tower, -0.5);
    captureGlow(D.tower);
    D.cable = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 8), new THREE.MeshStandardMaterial({ color: 0x0d2030, emissive: 0x38e1ff, emissiveIntensity: 0.1 }));
    const a = V(L1.pad);
    const b = V(L1.tower);
    D.cable.position.copy(a).add(b).multiplyScalar(0.5).setY(0.03);
    D.cable.scale.y = flatDist(a, b) - L1.padR;
    D.cable.rotation.set(Math.PI / 2, 0, -Math.atan2(b.x - a.x, b.z - a.z));
    fx.add(D.cable);
    D.towerBeam = beam(14, 0.16, 0x7cecff, 0.0);
    D.towerBeam.position.copy(V(L1.tower)).setY(7);
    fx.add(D.towerBeam);
    D.robot = decorPart(PART.robot, ROBOT[1], ROBOT[1][3]);

    // 第 2 關：組裝台、零件預覽、起跑線
    D.jig = new THREE.Group();
    const jigPos = V(L2.board).setY(0);
    D.jig.position.copy(jigPos);
    const frame = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.33, 4, 1), glowMat(0x38e1ff, 0.55));
    frame.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
    frame.scale.set(1.15, 1.45, 1);
    frame.position.y = 0.006;
    D.jig.add(frame);
    fx.add(D.jig);
    D.ghosts = {};
    for (const s of SOCKETS) D.ghosts[s.key] = ghostOf(PART_OF_KIND[s.kind]);
    D.line = new THREE.Mesh(new THREE.PlaneGeometry(5, 0.22), glowMat(0xffd166, 0.75));
    D.line.rotation.x = -Math.PI / 2;
    D.line.position.set(0, 0.01, L2.lineZ);
    fx.add(D.line);

    // 第 3 關：路線光點、兩個能量環、信號塔
    const pts = [V(L3.start).setY(0), ...L3.cps.map(V), V(L3.goal)];
    const dots = [];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const n = Math.max(2, Math.round(pts[i].distanceTo(pts[i + 1]) / 0.9));
      for (let k = 1; k < n; k += 1) dots.push(pts[i].clone().lerp(pts[i + 1], k / n));
    }
    const dotGeo = new THREE.CircleGeometry(0.09, 12);
    dotGeo.rotateX(-Math.PI / 2);
    D.path = new THREE.InstancedMesh(dotGeo, glowMat(0x38e1ff, 0.55), dots.length);
    dots.forEach((p, i) => D.path.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, 0.012, p.z)));
    fx.add(D.path);
    D.cps = L3.cps.map((c, i) => {
      const g = new THREE.Group();
      g.position.copy(V(c));
      const prev = i === 0 ? V(L3.start) : V(L3.cps[i - 1]);
      g.rotation.y = Math.atan2(c[0] - prev.x, c[2] - prev.z);
      const r = ring(1.6, 0.09, 0x38e1ff);
      r.position.y = 1.65;
      const glow = ring(1.6, 0.22, 0x38e1ff, 0.15);
      glow.position.y = 1.65;
      const base = new THREE.Mesh(new THREE.RingGeometry(L3.cpR - 0.12, L3.cpR, 64), glowMat(0x38e1ff, 0.35));
      base.rotation.x = -Math.PI / 2;
      base.position.y = 0.011;
      g.add(r, glow, base, beam(10, 0.08, 0x38e1ff, 0.22));
      g.userData = { r, glow, base };
      fx.add(g);
      return g;
    });
    D.goal = new THREE.Group();
    D.goal.position.copy(V(L3.goal));
    const goalPad = new THREE.Mesh(new THREE.RingGeometry(L3.goalR - 0.15, L3.goalR, 72), glowMat(0xffd166, 0.6));
    goalPad.rotation.x = -Math.PI / 2;
    goalPad.position.y = 0.012;
    const mast = new THREE.Group();
    mast.position.z = -L3.goalR - 0.6;
    const steel = new THREE.MeshStandardMaterial({ color: 0x31475c, metalness: 0.7, roughness: 0.35 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xffc94d, emissiveIntensity: 0.15 });
    const baseM = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 0.4, 24), steel);
    baseM.position.y = 0.2;
    mast.add(baseM);
    for (let k = 0; k < 4; k += 1) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 5.6, 0.1), steel);
      const ang = (k / 4) * Math.PI * 2 + Math.PI / 4;
      leg.position.set(Math.cos(ang) * 0.42, 3.0, Math.sin(ang) * 0.42);
      leg.rotation.set(Math.sin(ang) * 0.07, 0, -Math.cos(ang) * 0.07);
      mast.add(leg);
    }
    for (const y of [1.6, 3.0, 4.4]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.4 - y * 0.03, 0.04, 8, 24), lamp);
      band.rotation.x = Math.PI / 2;
      band.position.y = y;
      mast.add(band);
    }
    D.goalLamp = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), lamp);
    D.goalLamp.position.y = 6.1;
    mast.add(D.goalLamp);
    mast.traverse((m) => m.isMesh && (m.castShadow = true));
    D.goalBeam = beam(30, 0.25, 0xffd166, 0.0);
    D.goalBeam.position.y = 6;
    mast.add(D.goalBeam);
    D.goal.add(goalPad, mast);
    D.goal.userData = { pad: goalPad, lamp };
    fx.add(D.goal);
    // 車子上方的平面箭頭（尖端朝 +Z，lookAt 目標就指過去）
    const arrowShape = new THREE.Shape();
    for (const [x, y] of [[0, 0.5], [0.36, 0.08], [0.13, 0.08], [0.13, -0.38], [-0.13, -0.38], [-0.13, 0.08], [-0.36, 0.08]]) {
      if (x === 0 && y === 0.5) arrowShape.moveTo(x, y);
      else arrowShape.lineTo(x, y);
    }
    arrowShape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);
    arrowGeo.rotateX(Math.PI / 2);
    D.arrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xffd166, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthTest: false }));
    D.arrow.renderOrder = 12;
    D.arrow.scale.setScalar(1.5);
    D.arrow.visible = false;
    fx.add(D.arrow);
    D.confetti = [];
  }

  // 慶祝：彩色小方塊往上噴、掉下來、淡掉
  const confettiGeo = new THREE.BoxGeometry(0.07, 0.07, 0.02);
  function burst(at, n = 60) {
    const colors = [0x38e1ff, 0xffd166, 0x9dff5c, 0xff7ab6, 0xffffff];
    for (let i = 0; i < n; i += 1) {
      const m = new THREE.Mesh(confettiGeo, new THREE.MeshBasicMaterial({ color: colors[i % colors.length], transparent: true }));
      m.position.copy(at);
      const a = Math.random() * Math.PI * 2;
      const s = 1.2 + Math.random() * 2.2;
      m.userData = { v: new THREE.Vector3(Math.cos(a) * s, 3.5 + Math.random() * 3, Math.sin(a) * s), w: new THREE.Vector3(Math.random() * 9, Math.random() * 9, 0), life: 1.8 + Math.random() * 0.6 };
      fx.add(m);
      D.confetti.push(m);
    }
  }
  function updateConfetti(dt) {
    for (let i = D.confetti.length - 1; i >= 0; i -= 1) {
      const m = D.confetti[i];
      const u = m.userData;
      u.life -= dt;
      u.v.y -= 9 * dt;
      m.position.addScaledVector(u.v, dt);
      m.rotation.x += u.w.x * dt;
      m.rotation.y += u.w.y * dt;
      m.material.opacity = Math.min(1, u.life);
      if (u.life <= 0 || m.position.y < 0) {
        m.removeFromParent();
        m.material.dispose();
        D.confetti.splice(i, 1);
      }
    }
  }

  // ---------------- 鏡頭 ----------------

  let camTween = null;
  function frameCamera(pos, look, dur = 1.1) {
    camTween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: V(pos), t1: V(look), t: 0, dur };
  }
  function updateCamera(dt) {
    if (!camTween || engine.ownsCamera) return;
    camTween.t = Math.min(camTween.dur, camTween.t + dt);
    const k = camTween.t / camTween.dur;
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    camera.position.lerpVectors(camTween.p0, camTween.p1, e);
    controls.target.lerpVectors(camTween.t0, camTween.t1, e);
    if (k >= 1) camTween = null;
  }
  const camFor = (level) => (level === 1 ? L1 : level === 2 ? L2 : L3);

  // ---------------- 關卡 ----------------

  function freshProgress(prev, step = 'intro') {
    return {
      v: 1,
      rev: prev?.rev || 0,
      level: 1,
      step,
      times: [0, 0, 0],
      rescues: 0,
      cps: 0,
      ids: {},
      attached: [],
      startedAt: Date.now(),
      finishedAt: 0,
      clears: prev?.clears || 0,
      best: prev?.best || null,
      last: prev?.last || null,
    };
  }
  function clearScene() {
    if (engine.active) env.stopControl();
    for (const inst of instances.values()) {
      phys.pin(inst, false);
      phys.setBrake(inst, false);
    }
    for (const id of [...instances.keys()]) env.removeInstance(id, { save: false });
    anim = null;
  }
  function setupLevel(n) {
    if (n === 1) spawn('cube', PART.cube, L1.cube, 0.35);
    if (n === 2) {
      const board = spawn('board', PART.board, L2.board, L2.yaw);
      phys.pin(board, true);
      for (const slot of LOOSE) spawn(slot, PART_OF_KIND[kindOfSlot(slot)], L2.tray[slot], L2.yaw + (slot === 'st' ? 0 : 0.6 * (slot.endsWith('0') || slot.endsWith('2') ? 1 : -1)));
      P.attached = [];
    }
    if (n === 3) {
      const board = get('board');
      if (board) {
        phys.pin(board, false);
        phys.setBrake(board, true);
      }
      P.cps = 0;
    }
  }

  // 第 2 關：哪些零件已經黏在車身上（從實際的黏合關係與位置算，存檔壞掉也算得回來）。
  // 用外框中心比對（輪子的原點在底部，轉過之後原點會繞著輪軸跑；中心一直在輪軸上）
  function computeAttached() {
    const board = get('board');
    if (!board) return [];
    board.object.updateMatrixWorld(true);
    const inv = board.object.matrixWorld.clone().invert();
    const out = [];
    for (const slot of LOOSE) {
      const inst = get(slot);
      if (!inst || !board.glue || inst.glue !== board.glue) continue;
      const local = centerOf(inst).applyMatrix4(inv);
      const rest = inst.restBox.getCenter(new THREE.Vector3());
      const kind = kindOfSlot(slot);
      let best = null;
      for (const s of SOCKETS) {
        if (s.kind !== kind || out.includes(s.key)) continue;
        const d = local.distanceTo(V(s.pos).add(rest));
        if (d < 0.3 && (!best || d < best.d)) best = { key: s.key, d };
      }
      if (best) out.push(best.key);
    }
    return out;
  }
  const looseParts = () => LOOSE.map(get).filter((i) => i && !(get('board')?.glue && i.glue === get('board').glue));
  const freeSockets = (kind) => SOCKETS.filter((s) => s.kind === kind && !P.attached.includes(s.key));

  function kindOfInst(inst) {
    for (const slot of LOOSE) if (P.ids[slot] === inst.id) return kindOfSlot(slot);
    return null;
  }
  // 放開時要吸到哪個空位（沒有就 null）
  function snapTarget(inst) {
    const board = get('board');
    const kind = kindOfInst(inst);
    if (!board || !kind) return null;
    const c = centerOf(inst);
    let best = null;
    for (const s of freeSockets(kind)) {
      const p = new THREE.Vector3().setFromMatrixPosition(socketMatrix(board, s));
      const d = flatDist(c, p);
      if (!best || d < best.d) best = { s, d };
    }
    if (!best) return null;
    const cart = flatDist(c, new THREE.Vector3().setFromMatrixPosition(board.object.matrixWorld));
    return best.d <= SNAP_SOCKET || cart <= SNAP_CART ? best.s : null;
  }

  function startSnap(inst, toP, toQ, done) {
    anim = { inst, fromP: inst.object.position.clone(), fromQ: inst.object.quaternion.clone(), toP, toQ, t: 0, dur: 0.22, done };
  }
  function updateSnap(dt) {
    if (!anim) return;
    anim.t = Math.min(anim.dur, anim.t + dt);
    const k = anim.t / anim.dur;
    const e = 1 - (1 - k) ** 3;
    const p = anim.fromP.clone().lerp(anim.toP, e);
    p.y += Math.sin(k * Math.PI) * 0.25;
    setPose(anim.inst, p, anim.fromQ.clone().slerp(anim.toQ, e));
    if (k >= 1) {
      const a = anim;
      anim = null;
      setPose(a.inst, a.toP, a.toQ);
      a.done?.();
    }
  }

  function onRelease(inst) {
    if (!P || !instances.has(inst.id)) return;
    if (P.level === 1 && P.step === 'play' && inst.id === P.ids.cube) {
      const c = centerOf(inst);
      if (flatDist(c, V(L1.pad)) <= SNAP_PAD) {
        const yaw = new THREE.Euler().setFromQuaternion(inst.object.quaternion, 'YXZ').y;
        const to = V(L1.pad);
        to.y = inst.object.position.y - env.worldBox(inst).min.y; // 底部貼地
        startSnap(inst, to, yawQ(yaw), () => sfx('snap'));
      }
      return;
    }
    if (P.level === 2 && P.step === 'play') {
      const s = snapTarget(inst);
      if (!s) return;
      const board = get('board');
      const m = socketMatrix(board, s);
      const toP = new THREE.Vector3();
      const toQ = new THREE.Quaternion();
      m.decompose(toP, toQ, new THREE.Vector3());
      startSnap(inst, toP, toQ, () => {
        if (!instances.has(board.id) || P.attached.includes(s.key)) return;
        env.glueTogether([board, inst]);
        P.attached.push(s.key);
        sfx('snap');
        env.toast(`🔧 喀！${KIND_LABEL[s.kind]}裝上了（${P.attached.length}/${SOCKETS.length}）`, 2500);
        if (P.attached.length === SOCKETS.length) finishBuild();
        else env.saveNow();
        renderHud();
      });
    }
  }

  function finishBuild() {
    const board = get('board');
    phys.pin(board, false);
    phys.setBrake(board, true);
    P.step = 'built';
    burst(groupCenter(board).setY(1), 40);
    sfx('ok');
    env.saveNow();
    renderHud();
  }

  // 主要按鈕：第 2 關的 ⚡ 試車、第 3 關的開車
  function mainAction() {
    const board = get('board');
    if (P.level === 2 && P.step === 'built' && board) {
      const r = phys.activate(board);
      if (r?.power) {
        P.step = 'test';
        testT = 0;
        sfx('ok');
        env.toast('⚡ 引擎啟動！', 2000);
      }
      renderHud();
      return;
    }
    if (P.level === 3 && P.step === 'play' && board && !engine.active) {
      env.startControl(board, 'pilot');
      $('#ctlLabel').textContent = '🚗 探險車';
      $('#ctlHint').textContent = isTouch ? '左下搖桿：往上前進、往下倒車、左右轉彎' : '拖左下的搖桿，或按 W 前進、S 倒車、A／D 轉彎';
      bestTargetDist = Infinity;
      lastProgressT = 0;
      renderHud();
    }
  }

  // 救援：回到起點／檢查點，不會直接過關
  function rescue() {
    if (!P) return;
    const board = get('board');
    if (P.level === 1 && P.step === 'play') {
      const cube = get('cube');
      if (!cube) return;
      setPose(cube, V(L1.cube), yawQ(0.35));
      env.toast('🔄 方塊回到起點了', 2200);
    } else if (P.level === 2 && P.step === 'play') {
      for (const slot of LOOSE) {
        const inst = get(slot);
        if (!inst || looseParts().indexOf(inst) < 0) continue;
        setPose(inst, V(L2.tray[slot]), yawQ(L2.yaw + (slot === 'st' ? 0 : 0.6 * (slot.endsWith('0') || slot.endsWith('2') ? 1 : -1))));
      }
      if (board) moveGroup(board, L2.board, L2.yaw);
      env.toast('🔄 零件都放回原位了', 2200);
    } else if (P.level === 2 && (P.step === 'built' || P.step === 'test') && board) {
      if (phys.bodyOf(board)?.power) phys.activate(board);
      moveGroup(board, [L2.board[0], L2.board[1] + 0.05, L2.board[2]], L2.yaw);
      P.step = 'built';
      env.toast('🔄 車子擺正，回到組裝台', 2200);
    } else if (P.level === 3 && P.step === 'play' && board) {
      const flipped = uprightness(board) < 0.5;
      if (phys.bodyOf(board)?.power) phys.activate(board);
      if (flipped) {
        // 翻車：原地擺正（稍微抬高再放下）
        const c = groupCenter(board);
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(board.object.quaternion);
        moveGroup(board, [c.x, L3.start[1] + 0.15, c.z], Math.atan2(f.x, f.z));
        env.toast('🔄 翻正了，繼續開！', 2200);
      } else {
        const from = P.cps > 0 ? V(L3.cps[P.cps - 1]) : V(L3.start);
        const to = nextTarget();
        moveGroup(board, [from.x, L3.start[1] + 0.15, from.z], Math.atan2(to.x - from.x, to.z - from.z));
        env.toast(P.cps > 0 ? `🔄 回到能量環 ${P.cps}` : '🔄 回到起點', 2200);
      }
    } else return;
    P.rescues += 1;
    trouble = null;
    lastProgressT = 0;
    bestTargetDist = Infinity;
    sfx('snap');
    env.saveNow();
    renderHud();
  }

  const nextTarget = () => (P.cps < L3.cps.length ? V(L3.cps[P.cps]) : V(L3.goal));

  function levelClear() {
    P.step = 'clear';
    sfx(P.level >= 3 ? 'win' : 'clear');
    applyVisuals();
    env.saveNow();
    renderHud();
    const lvl = P.level;
    setTimeout(() => {
      if (P.step !== 'clear' || P.level !== lvl) return;
      if (lvl >= 3) finishAdventure();
      else showCard('clear');
    }, lvl >= 3 ? 1900 : 1300);
  }

  function nextLevel() {
    hideCard();
    P.level += 1;
    P.step = 'play';
    setupLevel(P.level);
    applyVisuals(true);
    env.saveNow();
    renderHud();
  }

  function finishAdventure() {
    const total = P.times.reduce((a, b) => a + b, 0);
    const stars = P.rescues === 0 && total <= 300 ? 3 : P.rescues <= 2 && total <= 600 ? 2 : 1;
    P.level = 4;
    P.step = 'done';
    P.finishedAt = Date.now();
    P.clears += 1;
    P.last = { total, stars, rescues: P.rescues };
    if (!P.best || stars > P.best.stars || (stars === P.best.stars && total < P.best.total)) P.best = { ...P.last };
    env.saveNow();
    renderHud();
    showCard('done');
  }

  function replay() {
    hideCard();
    clearScene();
    P = freshProgress(P, 'play');
    setupLevel(1);
    applyVisuals(true);
    env.saveNow();
    renderHud();
  }

  function restartLevel() {
    hideCard();
    const n = P.level;
    if (engine.active) env.stopControl();
    if (n === 1) {
      const cube = get('cube');
      if (cube) setPose(cube, V(L1.cube), yawQ(0.35));
      else spawn('cube', PART.cube, L1.cube, 0.35);
    } else if (n === 2) {
      for (const slot of ['board', ...LOOSE]) {
        const inst = get(slot);
        if (inst) {
          phys.pin(inst, false);
          phys.setBrake(inst, false);
          env.removeInstance(inst.id, { save: false });
        }
      }
      setupLevel(2);
    } else if (n === 3) {
      const board = get('board');
      if (board) {
        if (phys.bodyOf(board)?.power) phys.activate(board);
        moveGroup(board, [L3.start[0], L3.start[1] + 0.1, L3.start[2]], Math.PI);
      }
      P.cps = 0;
    }
    P.step = 'play';
    P.times[n - 1] = 0;
    applyVisuals(true);
    env.saveNow();
    renderHud();
  }

  // 依進度擺好裝飾（重新整理後也一樣）
  let towerK = null; // 能量塔亮度（點亮時 1 秒內慢慢亮起來）
  let towerWant = 0.06;
  function updateTower(dt) {
    if (towerK === null) towerK = towerWant;
    if (towerK === towerWant) return;
    towerK = towerK < towerWant ? Math.min(towerWant, towerK + dt * 1.1) : Math.max(towerWant, towerK - dt * 2);
    setGlow(D.tower, towerK);
    D.cable.material.emissiveIntensity = 0.1 + 2.1 * towerK;
    D.towerBeam.material.opacity = 0.16 * towerK;
  }
  function applyVisuals(moveCam = false) {
    const lvl = P.level;
    const lit = lvl >= 2 || (lvl === 1 && P.step === 'clear');
    towerWant = lit ? 1 : 0.06;
    if (towerK === null) {
      towerK = towerWant;
      setGlow(D.tower, towerK);
      D.cable.material.emissiveIntensity = 0.1 + 2.1 * towerK;
      D.towerBeam.material.opacity = 0.16 * towerK;
    }
    D.padRing.material.color.set(lit ? 0x9dff5c : 0x38e1ff);
    D.padBeam.material.opacity = lit ? 0 : 0.07;
    const assembling = lvl === 2 && P.step === 'play';
    D.jig.visible = lvl === 2;
    for (const s of SOCKETS) {
      const g = D.ghosts[s.key];
      g.visible = assembling && !P.attached.includes(s.key);
      const board = get('board');
      if (board && g.visible) {
        socketMatrix(board, s).decompose(g.position, g.quaternion, g.scale);
      }
    }
    D.line.visible = lvl === 2 && P.step !== 'clear';
    D.path.visible = lvl >= 3;
    D.cps.forEach((g, i) => {
      g.visible = lvl >= 3;
      const passed = lvl > 3 || i < P.cps;
      const color = passed ? 0x9dff5c : lvl === 3 && i === P.cps ? 0xffd166 : 0x38e1ff;
      for (const k of ['r', 'glow', 'base']) g.userData[k].material.color.set(color);
    });
    const r = ROBOT[Math.min(Math.max(lvl, 1), 3)];
    D.robot.position.set(r[0], r[1], r[2]);
    D.robot.rotation.set(0, r[3], 0);
    const goalLit = lvl >= 4 || (lvl === 3 && P.step === 'clear');
    D.goal.userData.lamp.emissiveIntensity = goalLit ? 3 : 0.15;
    D.goalBeam.material.opacity = goalLit ? 0.22 : 0;
    if (moveCam && lvl <= 3) {
      const c = camFor(lvl);
      frameCamera(c.cam, c.look);
    }
  }

  // ---------------- 每一格 ----------------

  function canGrab(inst) {
    if (!P || anim?.inst === inst || card) return false;
    if (P.level === 1 && P.step === 'play') return inst.id === P.ids.cube;
    if (P.level === 2 && P.step === 'play') return looseParts().includes(inst);
    return false;
  }

  function running() {
    return P && !card && P.level <= 3 && ['play', 'built', 'test'].includes(P.step) && !document.hidden;
  }

  function update(dt, t) {
    if (!P) return;
    for (const u of decorUpdaters) {
      if (u.dead) continue;
      try {
        u.fn.call(u.obj, dt, t);
      } catch (e) {
        u.dead = true;
        console.error(e);
      }
    }
    updateCamera(dt);
    updateSnap(dt);
    updateConfetti(dt);
    updateTower(dt);
    // 抓著的東西放開了
    const held = phys.holding?.inst || null;
    if (held && !firstGrabDone) {
      firstGrabDone = true;
      window.__advFirstGrab ??= performance.now();
    }
    if (lastHeld && held !== lastHeld) onRelease(lastHeld);
    lastHeld = held;
    if (running()) P.times[P.level - 1] += dt;
    D.padRing.material.opacity = 0.65 + 0.3 * Math.sin(t * 4);
    trouble = null;

    if (P.level === 1 && P.step === 'play') {
      const cube = get('cube');
      if (cube) {
        const c = centerOf(cube);
        const near = flatDist(c, V(L1.pad)) <= SNAP_PAD;
        D.padRing.material.color.set(held === cube && near ? 0x9dff5c : 0x38e1ff);
        const body = phys.bodyOf(cube);
        const still = !body || body.sleeping || Math.hypot(...body.velocity) < 0.25;
        if (!anim && held !== cube && flatDist(c, V(L1.pad)) < 0.3 && still && uprightness(cube) > 0.8) {
          burst(V(L1.tower).setY(2.2));
          levelClear();
        } else if (flatDist(c, V(L1.pad)) > 5 || c.y < -1) trouble = 'far';
      }
    }

    if (P.level === 2) {
      const board = get('board');
      if (P.step === 'play') {
        const hold = held && looseParts().includes(held) ? snapTarget(held) : null;
        for (const s of SOCKETS) {
          const g = D.ghosts[s.key];
          g.visible = !P.attached.includes(s.key);
          if (g.visible && board) socketMatrix(board, s).decompose(g.position, g.quaternion, g.scale);
          const hot = hold === s;
          if (g.userData.hot !== hot) {
            g.userData.hot = hot;
            setGhostHot(g, hot);
          }
        }
        if (looseParts().some((i) => flatDist(centerOf(i), V(L2.board)) > 6 || centerOf(i).y < -1)) trouble = 'far';
      } else if (P.step === 'test' && board) {
        testT += dt;
        const c = groupCenter(board);
        if (c.z < L2.lineZ) {
          if (phys.bodyOf(board)?.power) phys.activate(board); // 開過線：關掉馬達，自動煞車停下來
          burst(c.clone().setY(1.2), 50);
          levelClear();
        } else if (testT > 7 || uprightness(board) < 0.5) trouble = 'stuck';
      } else if (P.step === 'built' && board && uprightness(board) < 0.5) trouble = 'stuck';
    }

    if (P.level === 3 && board3()) {
      const board = board3();
      const c = groupCenter(board);
      if (P.step === 'play') {
        const target = nextTarget();
        const d = flatDist(c, target);
        if (P.cps < L3.cps.length && d <= L3.cpR) {
          P.cps += 1;
          sfx('ok');
          burst(V(L3.cps[P.cps - 1]).setY(1.7), 30);
          env.toast(`✨ 穿過能量環 ${P.cps}/${L3.cps.length}`, 2200);
          applyVisuals();
          env.saveNow();
          bestTargetDist = Infinity;
          lastProgressT = 0;
        } else if (P.cps >= L3.cps.length && d <= L3.goalR) {
          if (phys.bodyOf(board)?.power) phys.activate(board);
          burst(V(L3.goal).setY(5.5), 90);
          levelClear();
          setTimeout(() => {
            if (engine.active) env.stopControl();
          }, 1200);
        }
        if (d < bestTargetDist - 0.5) {
          bestTargetDist = d;
          lastProgressT = 0;
        } else if (engine.active) lastProgressT += dt;
        if (uprightness(board) < 0.5) {
          troubleT += dt;
          if (troubleT > 0.8) trouble = 'flip';
        } else troubleT = 0;
        if (!trouble && (flatDist(c, V(L3.goal)) > 26 || c.y < -1)) trouble = 'far';
        if (!trouble && lastProgressT > 25) trouble = 'lost';
        // 車子上方的箭頭指向下一個目標
        D.arrow.visible = d > 2.5;
        D.arrow.position.copy(c).setY(c.y + 1.5 + 0.08 * Math.sin(t * 5));
        D.arrow.lookAt(target.x, D.arrow.position.y, target.z);
        const cur = P.cps < L3.cps.length ? D.cps[P.cps] : D.goal;
        const k = 1 + 0.06 * Math.sin(t * 6);
        if (cur !== D.goal) cur.userData.r.scale.setScalar(k);
      } else D.arrow.visible = false;
    } else D.arrow.visible = false;

    updateHand(t);
    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.25;
      renderHud();
    }
  }
  const board3 = () => (P.level === 3 ? get('board') : null);

  // 手指提示：從要搬的東西滑到目的地（第一次抓起來之前一直示範；之後放著不動 8 秒會再出現）
  let idleT = 0;
  function updateHand(t) {
    const el = $('#advHand');
    let from = null;
    let to = null;
    if (!card && P.step === 'play' && !phys.holding && !anim) {
      if (P.level === 1 && get('cube')) {
        from = centerOf(get('cube'));
        to = V(L1.pad).setY(0.3);
      } else if (P.level === 2) {
        const board = get('board');
        const list = looseParts();
        if (board && list.length) {
          // 離鏡頭最近的那個零件
          const cam = camera.position;
          const inst = list.reduce((a, b) => (centerOf(a).distanceTo(cam) <= centerOf(b).distanceTo(cam) ? a : b));
          const s = freeSockets(kindOfInst(inst))[0];
          if (s) {
            from = centerOf(inst);
            to = new THREE.Vector3().setFromMatrixPosition(socketMatrix(board, s)).setY(0.4);
          }
        }
      }
    }
    if (phys.holding) idleT = 0;
    else idleT += 1 / 60;
    const show = from && to && (!firstGrabDone || idleT > 8);
    el.hidden = !show;
    if (!show) return;
    const r = renderer.domElement.getBoundingClientRect();
    const sp = (v) => {
      const p = v.clone().project(camera);
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    };
    const a = sp(from);
    const b = sp(to);
    handT = (t % 1.8) / 1.8;
    const k = handT < 0.15 ? 0 : handT > 0.8 ? 1 : (handT - 0.15) / 0.65;
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    el.style.transform = `translate(${a.x + (b.x - a.x) * e}px, ${a.y + (b.y - a.y) * e}px)`;
    el.style.opacity = handT > 0.9 ? String(1 - (handT - 0.9) * 10) : '1';
    el.classList.toggle('press', handT > 0.08 && handT < 0.85);
  }

  // ---------------- 畫面（HUD 與卡片） ----------------

  function goalText() {
    const touch = isTouch;
    const held = phys.holding?.inst;
    if (P.level === 1) {
      if (P.step === 'intro') return '';
      if (P.step === 'clear') return '⚡ 能量塔亮起來了！';
      if (trouble === 'far') return '方塊跑太遠了：按「🔄 方塊歸位」';
      if (held && held.id === P.ids.cube) return flatDist(centerOf(held), V(L1.pad)) <= SNAP_PAD ? '放開！它會自己對準充電座' : '拖到右邊發光的充電座上，再放開';
      return touch ? '用手指按住藍色能量方塊，拖到發光的充電座上' : '用滑鼠按住藍色能量方塊，拖到發光的充電座上';
    }
    if (P.level === 2) {
      const n = P.attached.length;
      if (P.step === 'play') {
        if (trouble === 'far') return '有零件跑太遠了：按「🔄 零件歸位」';
        if (held && looseParts().includes(held)) return snapTarget(held) ? '放開！會自動裝到發光的位置' : `把${KIND_LABEL[kindOfInst(held)]}拖到木板旁邊`;
        return `把輪子和操縱桿一個一個拖到木板旁邊，就會自動裝上（${n}/${SOCKETS.length}）`;
      }
      if (P.step === 'built') return trouble === 'stuck' ? '車子翻了：按「🔄 擺正車子」' : '裝好了！按「⚡ 啟動引擎」試車，讓它開過黃色起跑線';
      if (P.step === 'test') return trouble === 'stuck' ? '好像卡住了：按「🔄 擺正車子」再試一次' : '引擎轉起來了…看它開過起跑線！';
      return '🚗 試車成功！';
    }
    if (P.level === 3) {
      if (P.step === 'clear') return '📡 抵達信號塔！';
      if (!engine.active) return P.cps ? `按「▶ 繼續開車」，還有 ${L3.cps.length - P.cps ? `能量環 ${P.cps + 1}、` : ''}信號塔` : '按「▶ 開車出發」：先穿過 2 個黃色能量環，再開到信號塔';
      const board = board3();
      const d = board ? Math.round(flatDist(groupCenter(board), nextTarget())) : 0;
      if (trouble === 'flip') return '翻車了！按「🔄 翻正」';
      if (trouble === 'far' || trouble === 'lost') return '迷路了？跟著車上的黃色箭頭走，或按「🔄 回到檢查點」';
      const what = P.cps < L3.cps.length ? `穿過能量環 ${P.cps + 1}/${L3.cps.length}` : '開到信號塔';
      return `${what} · 還有 ${d} 公尺（跟著黃色箭頭）`;
    }
    return '';
  }

  function renderHud() {
    if (!P) return;
    const hud = $('#advHud');
    hud.hidden = P.level > 3;
    document.querySelectorAll('#advHud .adv-steps li').forEach((li) => {
      const n = Number(li.dataset.l);
      li.classList.toggle('done', n < P.level || (n === P.level && P.step === 'clear'));
      li.classList.toggle('on', n === P.level && P.step !== 'clear');
    });
    const lvl = LEVELS[Math.min(P.level, 3) - 1];
    $('#advTitle').textContent = `第 ${lvl.n} 關 · ${lvl.name}`;
    $('#advText').textContent = goalText();
    $('#advTimer').textContent = `⏱ ${fmt(P.times.reduce((a, b) => a + b, 0))}`;
    const main = $('#advMain');
    const rescueBtn = $('#advRescue');
    let mainLabel = null;
    if (P.level === 2 && P.step === 'built') mainLabel = '⚡ 啟動引擎';
    if (P.level === 3 && P.step === 'play' && !engine.active) mainLabel = P.cps || P.times[2] > 3 ? '▶ 繼續開車' : '▶ 開車出發';
    main.hidden = !mainLabel;
    if (mainLabel) main.textContent = mainLabel;
    let rescueLabel = null;
    if (P.level === 1 && P.step === 'play') rescueLabel = '🔄 方塊歸位';
    if (P.level === 2 && P.step === 'play') rescueLabel = '🔄 零件歸位';
    if (P.level === 2 && (P.step === 'built' || P.step === 'test')) rescueLabel = '🔄 擺正車子';
    if (P.level === 3 && P.step === 'play') {
      const b = board3();
      rescueLabel = b && uprightness(b) < 0.5 ? '🔄 翻正' : '🔄 回到檢查點';
    }
    rescueBtn.hidden = !rescueLabel || !!card;
    if (rescueLabel) rescueBtn.textContent = rescueLabel;
    rescueBtn.classList.toggle('alert', !!trouble);
    document.body.classList.toggle('adv-driving', engine.active);
  }

  function hideCard() {
    card = null;
    $('#advCard').hidden = true;
    renderHud();
  }
  function showCard(kind) {
    card = kind;
    const el = $('#advCard');
    const icon = $('#advCardIcon');
    const title = $('#advCardTitle');
    const body = $('#advCardBody');
    const btns = $('#advCardBtns');
    body.innerHTML = '';
    btns.innerHTML = '';
    const p = (html, cls) => {
      const d = document.createElement('div');
      if (cls) d.className = cls;
      d.innerHTML = html;
      body.appendChild(d);
      return d;
    };
    const button = (label, fn, cls = '') => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.onclick = fn;
      btns.appendChild(b);
      return b;
    };
    if (kind === 'intro') {
      icon.textContent = '🤖';
      title.textContent = '小紅：工坊停電了！';
      p('幫我做三件事，我們就能用信號塔求救：', 'adv-lead');
      p('<ol class="adv-plan"><li>✋ 搬能量方塊，<b>點亮能量塔</b></li><li>🔧 用零件<b>組一台探險車</b></li><li>🚗 開著它<b>到信號塔</b></li></ol>');
      p(isTouch ? '玩法：用手指<b>按住東西拖曳</b>；拖空白處可以轉視角。' : '玩法：用滑鼠<b>按住東西拖曳</b>；拖空白處可以轉視角。', 'adv-small');
      button('▶ 出發！', () => {
        hideCard();
        P.step = 'play';
        env.saveNow();
        renderHud();
      }, 'primary big');
    } else if (kind === 'clear') {
      const lvl = LEVELS[P.level - 1];
      icon.textContent = P.level === 1 ? '⚡' : '🔧';
      title.textContent = `第 ${lvl.n} 關完成！`;
      p(`⏱ ${fmt(P.times[P.level - 1])}`, 'adv-big');
      p(`學會了：${lvl.learn}`);
      const next = LEVELS[P.level];
      if (next) button(`下一關：${next.name} ▶`, nextLevel, 'primary big');
    } else if (kind === 'done') {
      const last = P.last || { total: 0, stars: 1, rescues: 0 };
      icon.textContent = '🏆';
      title.textContent = '冒險完成！';
      p('信號塔亮了，小紅的朋友們收到訊號了。謝謝你！', 'adv-lead');
      p(`<span class="adv-stars">${'★'.repeat(last.stars)}${'☆'.repeat(3 - last.stars)}</span>`, 'adv-big');
      p(
        `<table class="adv-stats"><tr><td>第 1 關 點亮能量塔</td><td>${fmt(P.times[0])}</td></tr><tr><td>第 2 關 組裝探險車</td><td>${fmt(P.times[1])}</td></tr><tr><td>第 3 關 開到信號塔</td><td>${fmt(P.times[2])}</td></tr><tr><td><b>總時間</b></td><td><b>${fmt(last.total)}</b></td></tr><tr><td>用了救援</td><td>${last.rescues} 次</td></tr></table>`,
      );
      if (P.best && P.clears > 1) p(`最佳紀錄：${'★'.repeat(P.best.stars)} ${fmt(P.best.total)}（已通關 ${P.clears} 次）`, 'adv-small');
      p('想做更厲害的東西？到自由工坊，說一句話就能叫 AI 打造（會用到 Codex 額度）。', 'adv-small');
      button('🔁 再玩一次', replay, 'primary big');
      button('🧰 去自由工坊', () => env.goTo('/?ws'), 'big');
      button('🏠 回首頁', () => env.goTo('/'), 'ghost');
    } else if (kind === 'menu') {
      icon.textContent = '⏸';
      title.textContent = '暫停';
      p(`現在在第 ${Math.min(P.level, 3)} 關，進度會自動保存。`, 'adv-small');
      button('▶ 繼續', hideCard, 'primary big');
      button('↺ 重來這一關', restartLevel, 'big');
      button('🏠 回首頁', () => env.goTo('/'), 'ghost');
      button('🧰 去自由工坊', () => env.goTo('/?ws'), 'ghost');
    }
    el.hidden = false;
    renderHud();
  }

  // ---------------- 啟動 ----------------

  function missingParts() {
    return ADVENTURE_PARTS.filter((id) => !runtime.parts.has(id));
  }

  async function init(saved, { fresh = false } = {}) {
    const miss = missingParts();
    if (miss.length) {
      $('#advHud').hidden = false;
      $('#advTitle').textContent = '缺少內建零件';
      $('#advText').textContent = `找不到 ${miss.join('、')}：請重新啟動工坊伺服器（會自動補上範例零件）`;
      return false;
    }
    buildDecor();
    const prog = saved?.progress;
    if (!fresh && prog && prog.level >= 1) {
      P = { ...freshProgress(prog), ...prog, ids: { ...(prog.ids || {}) }, times: [0, 0, 0].map((_, i) => prog.times?.[i] || 0) };
      // 存檔跟場景對不起來（例如手動改過檔案）：從缺的那一關重來（第 3 關少了車就回第 2 關重新組，不替玩家組好）
      const need = P.level === 1 ? ['cube'] : P.level === 2 || P.level === 3 ? ['board', ...LOOSE] : [];
      if (need.some((s) => !get(s))) {
        const lvl = Math.min(P.level, 2);
        const times = P.times;
        clearScene();
        P = { ...freshProgress(P, 'play'), level: lvl, times };
        setupLevel(1);
        if (lvl === 2) {
          setPose(get('cube'), V(L1.pad), yawQ(0.35));
          setupLevel(2);
        }
      }
      if (P.level === 2) {
        P.attached = computeAttached();
        const board = get('board');
        if (P.step === 'play' && P.attached.length === SOCKETS.length) P.step = 'built';
        if (P.step === 'test') P.step = 'built'; // 重新整理後馬達是關的：再按一次 ⚡
        if (P.step === 'play') phys.pin(board, true);
        else phys.setBrake(board, true);
      }
      if (P.level === 3) {
        const board = get('board');
        phys.setBrake(board, true);
        if (P.step === 'clear') {
          finishAdventure();
          applyVisuals();
          return true;
        }
      }
    } else {
      clearScene();
      P = freshProgress(prog || null, 'intro');
      setupLevel(1);
    }
    applyVisuals();
    const c = camFor(Math.min(P.level, 3));
    camera.position.copy(V(c.cam));
    controls.target.copy(V(c.look));
    controls.update();
    renderHud();
    if (P.step === 'intro') showCard('intro');
    else if (P.step === 'clear' && P.level <= 3) showCard('clear');
    else if (P.level > 3) showCard('done');
    env.saveNow();
    return true;
  }

  $('#advMenu').onclick = () => showCard('menu');
  $('#advRescue').onclick = () => rescue();
  $('#advMain').onclick = () => mainAction();

  return {
    init,
    update,
    canGrab,
    get progress() {
      return P;
    },
    saveData() {
      if (!P) return null;
      P.rev += 1;
      P.attached = P.level === 2 ? P.attached : P.level >= 3 ? SOCKETS.map((s) => s.key) : [];
      return { progress: P };
    },
    onEscape() {
      if (card === 'menu') hideCard();
      else if (!card) showCard('menu');
    },
    // 給自動測試讀狀態（只讀：不提供跳關、改存檔的函式）
    state() {
      const board = get('board');
      const held = phys.holding?.inst || null;
      return {
        level: P?.level,
        step: P?.step,
        card,
        attached: P ? [...P.attached] : [],
        cps: P?.cps,
        rescues: P?.rescues,
        times: P ? [...P.times] : [],
        ids: P ? { ...P.ids } : {},
        trouble,
        held: held?.id || null,
        anim: !!anim,
        board: board
          ? { center: groupCenter(board).toArray(), up: uprightness(board), power: !!phys.bodyOf(board)?.power, members: env.glueMembers(board).length, forward: phys.frame(board)?.forward.toArray() || null }
          : null,
        sockets: board ? SOCKETS.map((s) => ({ key: s.key, kind: s.kind, free: !P.attached.includes(s.key), pos: new THREE.Vector3().setFromMatrixPosition(socketMatrix(board, s)).toArray() })) : [],
        loose: P ? looseParts().map((i) => ({ id: i.id, kind: kindOfInst(i), center: centerOf(i).toArray() })) : [],
        engine: engine.active ? engine.mode : null,
        nextTarget: P?.level === 3 ? nextTarget().toArray() : null,
        layout: { L1, L2, L3 },
      };
    },
  };
}

// 首頁背景：小紅、能量塔和一台小車在轉台上（只是裝飾）
export function buildTitleScene({ THREE, scene, runtime }) {
  const g = new THREE.Group();
  const put = (id, x, z, yaw) => {
    if (!runtime.parts.has(id)) return;
    const o = runtime.instantiate(id).object;
    o.position.set(x, 0, z);
    o.rotation.y = yaw;
    o.traverse((m) => m.isMesh && (m.castShadow = true));
    g.add(o);
    return o;
  };
  put(PART.tower, -1.3, -0.6, 0.4);
  put(PART.robot, 0.2, 0.4, -0.2);
  put('c_mvfwneiy081798', 1.6, -0.4, -0.7); // 左納烏小車（範例藍圖）
  scene.add(g);
  const ups = [];
  g.traverse((o) => typeof o.userData?.update === 'function' && ups.push(o));
  return {
    update(dt, t) {
      for (const o of ups) {
        try {
          o.userData.update.call(o, dt, t);
        } catch {
          /* 裝飾而已 */
        }
      }
    },
  };
}
