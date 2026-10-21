// 眼鏡模式的 3D 介面：戴上之後摸不到螢幕上的小按鈕，所以介面都是場景裡的東西，兩眼看得到同一個位置（融合得起來）。
// - 跟著頭的：狀態（手追到了沒、可以抓、抓著、暫停）、鏡頭狀態、提示訊息、診斷（要打開才有）、鏡頭小畫面、
//   創作世界的「現在說話會做什麼」（模式牌）、選取作品的 HUD、方向鍵（要打開才有）、對位檢查的目標
// - 放在世界裡的：低頭看得到的選單。平常收成一個小「☰ 選單」頁籤（不擋地上的作品）；盯著它 1.5 秒或用手捏一下才展開（分頁），
//   按鈕一樣盯著 1.5 秒或捏一下就按下；展開的選單有底板，捏在選單上不會穿過去點到後面的世界
// - 手：21 個關節的線框手＋射線＋落點，顏色表示狀態
const FONT = "-apple-system, BlinkMacSystemFont, 'PingFang TC', 'Noto Sans TC', sans-serif";

export const HAND_COLORS = { tracking: 0x38e1ff, hover: 0xfff36b, grabbing: 0x9dff5c, paused: 0x8a97a6 };
export const DWELL_S = 1.5; // 視線停留多久算按下
export const PAD_KEYS = ['up', 'left', 'action', 'right', 'down'];

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 一塊會寫字的板子（公尺）：字有變才重畫
export function textPanel(THREE, { width, height, ppm = 420, align = 'center' }) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * ppm);
  canvas.height = Math.round(height * ppm);
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
  mesh.renderOrder = 30;
  let key = '';
  return {
    mesh,
    set(lines, { color = '#d9f6ff', border = 'rgba(56,225,255,0.55)', bg = 'rgba(4,14,26,0.82)', progress = 0 } = {}) {
      const list = Array.isArray(lines) ? lines : [lines];
      const k = JSON.stringify([list, color, border, bg, Math.round(progress * 40)]);
      if (k === key) return;
      key = k;
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      mesh.visible = list.some((l) => l);
      if (!mesh.visible) return;
      const pad = Math.round(H * 0.08);
      roundRect(ctx, 2, 2, W - 4, H - 4, Math.min(H * 0.22, 40));
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = border;
      ctx.stroke();
      if (progress > 0) {
        ctx.fillStyle = 'rgba(157,255,92,0.35)';
        roundRect(ctx, 6, 6, (W - 12) * Math.min(1, progress), H - 12, Math.min(H * 0.2, 36));
        ctx.fill();
      }
      const n = list.length;
      const lh = (H - pad * 2) / n;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.textAlign = align;
      list.forEach((l, i) => {
        let size = Math.floor(lh * 0.72);
        ctx.font = `600 ${size}px ${FONT}`;
        while (size > 10 && ctx.measureText(l).width > W - pad * 2) {
          size -= 2;
          ctx.font = `600 ${size}px ${FONT}`;
        }
        ctx.fillText(l, align === 'left' ? pad : W / 2, pad + lh * (i + 0.5));
      });
      tex.needsUpdate = true;
    },
    dispose() {
      tex.dispose();
      mat.dispose();
      mesh.geometry.dispose();
    },
  };
}

// 按鈕的樣子：可以按／不能按（灰）／正在用（亮綠框）／手指著（黃框）／視線停留進度
function buttonStyle({ enabled = true, active = false, hover = false, gaze = false, progress = 0 }) {
  return {
    color: enabled ? (active ? '#eaffd6' : '#d9f6ff') : '#6f8493',
    bg: active ? 'rgba(20,58,30,0.9)' : enabled ? 'rgba(4,14,26,0.86)' : 'rgba(4,10,16,0.7)',
    border: hover ? 'rgba(255,243,107,0.95)' : gaze ? 'rgba(157,255,92,0.9)' : active ? 'rgba(157,255,92,0.8)' : enabled ? 'rgba(56,225,255,0.55)' : 'rgba(90,110,125,0.45)',
    progress,
  };
}

export function createHud({ THREE, camera, scene }) {
  const disposables = [];
  const head = new THREE.Group(); // 跟著頭
  head.name = 'headset-hud';
  camera.add(head);
  const D = 1.8;
  const panel = (opts, x, y) => {
    const p = textPanel(THREE, opts);
    p.mesh.position.set(x, y, -D);
    head.add(p.mesh);
    disposables.push(p);
    return p;
  };
  // 排版：文字放上緣與下緣，中間留給作品（正中間只有準星）；右邊是選取作品的 HUD、左邊是診斷；方向鍵在下方
  // 創作世界：現在說話會做什麼（新作品／改哪一件），最上面一直看得到
  const modeP = panel({ width: 1.0, height: 0.1 }, 0, 0.66);
  modeP.mesh.visible = false;
  const status = panel({ width: 0.78, height: 0.1 }, 0, 0.55);
  const camState = panel({ width: 0.78, height: 0.08 }, 0, 0.455);
  // 說明（鏡頭打不開、沒有動作感測…）：最多三行，字才不會為了擠成一行縮到看不見
  const help = panel({ width: 1.1, height: 0.27 }, 0, 0.24);
  help.mesh.visible = false;
  // 額外狀態（創作世界：聽到的話、做到哪裡），兩行，在方向鍵上面
  const extra = panel({ width: 1.2, height: 0.15 }, 0, -0.27);
  extra.mesh.visible = false;
  const toastP = panel({ width: 1.2, height: 0.11 }, 0, 0.35);
  // 選取作品的 HUD（作品自己的 hud()：分數、剩幾條命…）
  const game = panel({ width: 0.62, height: 0.34, ppm: 380, align: 'left' }, 0.8, 0.14);
  game.mesh.visible = false;
  const diag = panel({ width: 0.62, height: 0.62, ppm: 380, align: 'left' }, -0.8, 0.05);
  diag.mesh.visible = false;
  const base = { mode: 0.66, status: 0.55, camState: 0.455, help: 0.24, extra: -0.27, toast: 0.35 };

  // 視線準星（正中間）：盯著按鈕時會變成進度
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.012, 0.02, 32),
    new THREE.MeshBasicMaterial({ color: 0xd9f6ff, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  reticle.position.set(0, 0, -D);
  reticle.renderOrder = 31;
  head.add(reticle);

  // 鏡頭小畫面（追不到手時出現，看得到手有沒有在鏡頭裡）
  const pc = document.createElement('canvas');
  pc.width = 256;
  pc.height = 192;
  const pctx = pc.getContext('2d');
  const ptex = new THREE.CanvasTexture(pc);
  ptex.colorSpace = THREE.SRGBColorSpace;
  ptex.generateMipmaps = false;
  ptex.minFilter = THREE.LinearFilter;
  const preview = new THREE.Mesh(
    new THREE.PlaneGeometry(0.36, 0.27),
    new THREE.MeshBasicMaterial({ map: ptex, depthTest: false, depthWrite: false, toneMapped: false, transparent: true, opacity: 0.92 }),
  );
  preview.position.set(0.62, -0.42, -D);
  preview.renderOrder = 30;
  preview.visible = false;
  head.add(preview);

  // ---- 選單（放在世界裡，低頭看得到；收起時只有小頁籤，展開是分頁，每頁最多兩排、每排四個） ----
  const menu = new THREE.Group();
  menu.name = 'headset-menu';
  scene.add(menu);
  const body = new THREE.Group(); // 展開的選單（底板、標題、按鈕）
  body.name = 'headset-menu-body';
  body.visible = false;
  menu.add(body);
  let open = false;
  // 頁籤放在自己的群組：顯示與否看群組（textPanel 重畫時會把 mesh 設回可見）
  const tabG = new THREE.Group();
  menu.add(tabG);
  const tab = textPanel(THREE, { width: 0.5, height: 0.11, ppm: 520 });
  tab.mesh.userData.buttonId = 'menu:open';
  tab.mesh.renderOrder = 30;
  tabG.add(tab.mesh);
  disposables.push(tab);
  const tabState = { dwell: 0, armed: true };
  const BW = 0.34;
  const BH = 0.13;
  const PITCH_X = 0.37;
  const PITCH_Y = 0.16;
  // 底板：擋住捏合（捏在按鈕之間的空隙也不會穿過去點到後面的世界），也讓字比較好讀
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x02080f, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  plate.renderOrder = 28;
  plate.userData.menuPlate = true;
  body.add(plate);
  const menuTitle = textPanel(THREE, { width: 1.2, height: 0.075 });
  menuTitle.mesh.renderOrder = 30;
  body.add(menuTitle.mesh);
  disposables.push(menuTitle);
  let buttons = []; // { id, panel, label, enabled, active, dwell, armed }
  let menuKey = '';
  let menuHoverId = null;
  let gazeId = null;
  function disposeButtons() {
    for (const b of buttons) {
      body.remove(b.panel.mesh);
      b.panel.dispose();
    }
    buttons = [];
  }
  // spec：{ title, hint, rows: [[{ id, label, enabled, active }]] }
  function setMenu(spec) {
    const rows = (spec?.rows || []).map((r) => r.filter(Boolean).slice(0, 4)).filter((r) => r.length).slice(0, 2);
    const key = JSON.stringify(rows.map((r) => r.map((b) => b.id)));
    if (key !== menuKey) {
      const old = new Map(buttons.map((b) => [b.id, b]));
      disposeButtons();
      menuKey = key;
      rows.forEach((row, ri) => {
        row.forEach((spec, ci) => {
          const p = textPanel(THREE, { width: BW, height: BH, ppm: 520 });
          p.mesh.position.set((ci - (row.length - 1) / 2) * PITCH_X, -ri * PITCH_Y, 0);
          p.mesh.userData.buttonId = spec.id;
          p.mesh.renderOrder = 30;
          body.add(p.mesh);
          const was = old.get(spec.id);
          buttons.push({ id: spec.id, panel: p, label: '', enabled: true, active: false, dwell: 0, armed: was ? was.armed : true });
        });
      });
      if (menuDim) for (const b of buttons) b.panel.mesh.material.opacity = 0.35;
      const n = Math.max(1, ...rows.map((r) => r.length));
      plate.scale.set(n * PITCH_X + 0.08, rows.length * PITCH_Y + 0.16, 1);
      plate.position.set(0, (-(rows.length - 1) * PITCH_Y) / 2 + 0.04, -0.01);
      menuTitle.mesh.position.set(0, PITCH_Y * 0.62 + 0.02, 0);
    }
    const flat = rows.flat();
    for (const b of buttons) {
      const s = flat.find((x) => x.id === b.id);
      if (!s) continue;
      b.label = s.label;
      b.enabled = s.enabled !== false;
      b.active = !!s.active;
    }
    menuTitle.set(spec?.title ? `${spec.title}${spec.hint ? `　${spec.hint}` : ''}` : '', { color: '#bfe9ff', border: 'rgba(56,225,255,0.25)', bg: 'rgba(2,10,18,0.75)' });
    paintButtons();
  }
  function paintButtons() {
    for (const b of buttons) b.panel.set(b.label, buttonStyle({ enabled: b.enabled, active: b.active, hover: b.id === menuHoverId, gaze: b.id === gazeId && b.enabled, progress: b.id === gazeId && b.enabled && b.armed ? b.dwell / DWELL_S : 0 }));
    tab.set('☰ 選單（盯著或捏一下）', buttonStyle({ hover: menuHoverId === 'menu:open', gaze: gazeId === 'menu:open', progress: gazeId === 'menu:open' && tabState.armed ? tabState.dwell / DWELL_S : 0 }));
  }
  function setOpen(v) {
    open = !!v;
    body.visible = open;
    tabG.visible = !open;
    tabState.dwell = 0;
    tabState.armed = !open ? false : tabState.armed; // 剛收起：要先把視線移開，頁籤才會被盯著再打開
    if (!open) layout(false);
    paintButtons();
  }

  // ---- 方向鍵（跟著頭，在視線下方；手指著按鈕捏住＝按住，張開＝放開） ----
  const pad = new THREE.Group();
  pad.name = 'headset-pad';
  pad.visible = false;
  head.add(pad);
  const PAD_LABEL = { up: '▲ 上', left: '◀ 左', action: '⚡ 動作', right: '右 ▶', down: '▼ 下' };
  // 十字排列、鍵和鍵之間只留一點縫（捏著滑動時整片都算在方向鍵上，不會滑到縫裡就放開）
  const PAD_POS = { up: [0, -0.43], left: [-0.27, -0.56], action: [0, -0.56], right: [0.27, -0.56], down: [0, -0.69] };
  const PW = 0.25;
  const PH = 0.12;
  const PAD_BOX = { x0: -0.27 - PW / 2, x1: 0.27 + PW / 2, y0: -0.69 - PH / 2, y1: -0.43 + PH / 2 };
  const padButtons = PAD_KEYS.map((k) => {
    const p = textPanel(THREE, { width: PW, height: PH, ppm: 480 });
    p.mesh.position.set(PAD_POS[k][0], PAD_POS[k][1], -D);
    p.mesh.userData.padKey = k;
    p.mesh.renderOrder = 32;
    pad.add(p.mesh);
    disposables.push(p);
    return { key: k, panel: p };
  });
  let padState = { active: null, hover: null };
  function paintPad() {
    for (const b of padButtons) {
      const on = padState.active === b.key;
      b.panel.set(PAD_LABEL[b.key], { color: on ? '#0b1a10' : '#d9f6ff', bg: on ? 'rgba(157,255,92,0.92)' : 'rgba(4,14,26,0.55)', border: on ? 'rgba(157,255,92,1)' : padState.hover === b.key ? 'rgba(255,243,107,0.95)' : 'rgba(56,225,255,0.5)' });
    }
  }
  paintPad();

  // ---- 對位檢查：頭前方的目標圈＋量到的差 ----
  const align = new THREE.Group();
  align.name = 'headset-align';
  align.visible = false;
  camera.add(align);
  const alignRing = new THREE.Mesh(
    new THREE.RingGeometry(0.018, 0.026, 40),
    new THREE.MeshBasicMaterial({ color: 0xfff36b, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
  );
  alignRing.renderOrder = 33;
  const alignDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.004, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff36b, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  alignDot.renderOrder = 33;
  align.add(alignRing, alignDot);
  const alignText = panel({ width: 1.2, height: 0.24 }, 0, 0.2);
  alignText.mesh.visible = false;

  // ---- 手 ----
  const joints = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, toneMapped: false }),
    21,
  );
  joints.renderOrder = 25;
  joints.frustumCulled = false;
  const bonePos = new Float32Array(BONES.length * 6);
  const bones = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(bonePos, 3)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  bones.renderOrder = 25;
  bones.frustumCulled = false;
  const rayPos = new Float32Array(6);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(rayPos, 3)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  ray.renderOrder = 24;
  ray.frustumCulled = false;
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.025, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  dot.renderOrder = 26;
  const hand = new THREE.Group();
  hand.name = 'headset-hand';
  hand.add(joints, bones, ray, dot);
  hand.visible = false;
  scene.add(hand);
  const _m = new THREE.Matrix4();
  const _c = new THREE.Color();

  const raycaster = new THREE.Raycaster();
  const _o = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _inv = new THREE.Matrix4();
  const _lo = new THREE.Vector3();
  const _ld = new THREE.Vector3();
  let toastUntil = 0;
  let previewWanted = false;
  let menuFocus = false;
  let menuDim = false;

  // 射線打到選單的哪裡：{ id（打到空隙／底板是 null；收起時是頁籤 menu:open）, enabled, point, distance }；沒打到選單回 null
  function pickMenu(origin, dir) {
    if (!menu.visible) return null;
    raycaster.set(origin, dir);
    menu.updateMatrixWorld(true);
    if (!open) {
      const t = raycaster.intersectObject(tab.mesh, false)[0];
      return t ? { id: 'menu:open', enabled: true, point: t.point.clone(), distance: t.distance, tab: true } : null;
    }
    if (!buttons.length) return null;
    const hit = raycaster.intersectObjects([...buttons.map((b) => b.panel.mesh), plate], false)[0];
    if (!hit) return null;
    const b = buttons.find((x) => x.panel.mesh === hit.object);
    return { id: b?.id ?? null, enabled: b ? b.enabled : false, point: hit.point.clone(), distance: hit.distance };
  }
  // 射線（世界座標，起點是眼睛）在方向鍵平面上落在哪一顆：margin＞0 用在「捏著滑動」（容許稍微超出按鈕，不會一抖就放開）
  function pickPad(origin, dir, margin = 0) {
    if (!pad.visible) return null;
    camera.updateMatrixWorld(true);
    _inv.copy(camera.matrixWorld).invert();
    _lo.copy(origin).applyMatrix4(_inv);
    _ld.copy(dir).transformDirection(_inv);
    if (_ld.z > -1e-4) return null;
    const t = (-D - _lo.z) / _ld.z;
    if (t <= 0) return null;
    const x = _lo.x + _ld.x * t;
    const y = _lo.y + _ld.y * t;
    let best = null;
    if (margin > 0) {
      // 捏著滑動：在整片方向鍵（外擴 margin）裡就算，挑最近的那顆
      if (x < PAD_BOX.x0 - margin || x > PAD_BOX.x1 + margin || y < PAD_BOX.y0 - margin || y > PAD_BOX.y1 + margin) return null;
      for (const k of PAD_KEYS) {
        const [cx, cy] = PAD_POS[k];
        const score = ((x - cx) / PW) ** 2 + ((y - cy) / PH) ** 2;
        if (!best || score < best.score) best = { key: k, score };
      }
    } else {
      for (const k of PAD_KEYS) {
        const [cx, cy] = PAD_POS[k];
        if (Math.abs(x - cx) <= PW / 2 && Math.abs(y - cy) <= PH / 2) best = { key: k };
      }
    }
    if (!best) return null;
    return { key: best.key, point: new THREE.Vector3(x, y, -D).applyMatrix4(camera.matrixWorld), local: { x, y } };
  }

  // 低頭看選單時：跟著頭的字都收到選單上面（不擋選單），方向鍵、作品 HUD、鏡頭狀態先藏起來
  function layout(focus) {
    if (focus === menuFocus) return;
    menuFocus = focus;
    modeP.mesh.position.y = focus ? 0.7 : base.mode;
    status.mesh.position.y = focus ? 0.6 : base.status;
    toastP.mesh.position.y = focus ? 0.5 : base.toast;
    extra.mesh.position.y = focus ? 0.39 : base.extra;
    help.mesh.position.y = base.help;
    game.mesh.visible = !focus && gameShown;
  }
  let gameShown = false;

  return {
    status,
    camState,
    head,
    menu,
    pad,
    setStatus(text, color = '#d9f6ff') {
      status.set(text, { color });
    },
    setCamera(text, warn = false) {
      camState.set(menuFocus ? '' : text, { color: warn ? '#ffd166' : '#9fb8c8', border: warn ? 'rgba(255,209,102,0.6)' : 'rgba(56,225,255,0.3)' });
    },
    setExtra(lines) {
      const list = (lines || []).filter(Boolean).slice(0, 2);
      if (!list.length) return extra.set('');
      while (list.length < 2) list.push('');
      extra.set(list, { color: '#e8fff0', border: 'rgba(157,255,92,0.55)' });
    },
    // 模式牌：{ text, kind: 'new'｜'modify'｜'listen'｜'wait' }
    setMode(m) {
      if (!m?.text) {
        modeP.set('');
        return;
      }
      const look = { new: ['#bff7ff', 'rgba(56,225,255,0.8)', 'rgba(4,22,34,0.88)'], modify: ['#fff3c2', 'rgba(255,209,102,0.9)', 'rgba(40,28,4,0.88)'], listen: ['#ffe0d6', 'rgba(255,138,107,0.95)', 'rgba(48,12,6,0.9)'], wait: ['#d9f6ff', 'rgba(143,167,184,0.7)', 'rgba(8,16,24,0.85)'] }[m.kind] || ['#d9f6ff', 'rgba(56,225,255,0.55)', 'rgba(4,14,26,0.82)'];
      modeP.set(m.text, { color: look[0], border: look[1], bg: look[2] });
    },
    // 選取作品的 HUD：第一行名字版本，後面是作品自己的 hud()
    setGame(lines) {
      const list = (lines || []).filter((l) => l != null).slice(0, 5);
      gameShown = list.length > 0;
      if (!list.length) return game.set('');
      while (list.length < 5) list.push('');
      game.set(list, { color: '#e8fff0', border: 'rgba(157,255,92,0.45)', bg: 'rgba(4,14,26,0.78)' });
      if (menuFocus) game.mesh.visible = false;
    },
    setHelp(lines) {
      if (!lines?.length || menuFocus) {
        help.set('');
        return;
      }
      const list = [...lines];
      while (list.length < 3) list.push(''); // 固定三行高：字的大小不跟著行數變
      help.set(list, { color: '#ffe3a3', border: 'rgba(255,209,102,0.6)' });
    },
    toast(text, ms, t) {
      toastP.set(text);
      toastUntil = t + ms;
    },
    tick(t) {
      if (toastUntil && t > toastUntil) {
        toastP.set('');
        toastUntil = 0;
      }
    },
    setDiag(lines) {
      diag.mesh.visible = !!lines;
      if (lines) diag.set(lines, { color: '#bfe9ff' });
    },
    setMenu,
    // 手指著選單上的哪一顆（黃框）
    setMenuHover(id) {
      if (id === menuHoverId) return;
      menuHoverId = id;
      paintButtons();
    },
    menuButtons: () => buttons.map((b) => ({ id: b.id, label: b.label, enabled: b.enabled, active: b.active })),
    pickMenu,
    // 選單放在「回正的方向」正前方、往下 38° 的地方
    placeMenu(headPos, yaw) {
      const pitch = (-38 * Math.PI) / 180;
      const dist = 1.5;
      const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      menu.position.copy(headPos).addScaledVector(dir, dist);
      menu.lookAt(headPos);
    },
    // 視線停留：回傳這一格被「按下」的按鈕 id（不能按的按鈕不會被按下）；順便決定要不要用「看選單」的排版
    gaze(dt) {
      camera.getWorldPosition(_o);
      camera.getWorldQuaternion(_q);
      _d.set(0, 0, -1).applyQuaternion(_q);
      const hit = pickMenu(_o, _d);
      layout(open && !!hit);
      let fired = null;
      let progress = 0;
      gazeId = hit?.id ?? null;
      // 收起時：盯著頁籤 1.5 秒＝打開
      if (!open) {
        if (hit?.tab) {
          if (tabState.armed) {
            tabState.dwell += dt;
            progress = tabState.dwell / DWELL_S;
            if (tabState.dwell >= DWELL_S) {
              fired = 'menu:open';
              tabState.dwell = 0;
              tabState.armed = false;
            }
          }
        } else {
          tabState.dwell = 0;
          tabState.armed = true;
        }
      }
      for (const b of buttons) {
        const on = open && hit?.id === b.id && b.enabled;
        if (!on) {
          b.dwell = 0;
          b.armed = true;
        } else if (b.armed) {
          b.dwell += dt;
          progress = b.dwell / DWELL_S;
          if (b.dwell >= DWELL_S) {
            fired = b.id;
            b.dwell = 0;
            b.armed = false; // 要先移開視線，才會再按一次
          }
        }
      }
      paintButtons();
      reticle.scale.setScalar(1 + progress * 1.5);
      reticle.material.color.setHex(progress > 0 ? 0x9dff5c : 0xd9f6ff);
      return fired;
    },
    // 用手捏下去之後：這顆按鈕要等視線／手移開才能再被視線按（不會捏完又被盯著按一次）
    disarm(id) {
      const b = id === 'menu:open' ? tabState : buttons.find((x) => x.id === id);
      if (b) {
        b.dwell = 0;
        b.armed = false;
      }
    },
    setOpen,
    get open() {
      return open;
    },
    get menuFocus() {
      return menuFocus;
    },
    // 方向鍵打開、又沒在看選單時：選單變淡（捏在上面只會提示「低頭看著它再按」，也不會穿過去點到世界）
    setMenuDim(dim) {
      if (dim === menuDim) return;
      menuDim = dim;
      for (const o of [...body.children, tab.mesh]) if (o.material) o.material.opacity = (o === plate ? 0.55 : 1) * (dim ? 0.35 : 1);
    },
    // 方向鍵：{ visible, active（按住的那顆）, hover（手指著的那顆） }
    setPad({ visible, active = null, hover = null }) {
      pad.visible = !!visible && !menuFocus;
      if (active !== padState.active || hover !== padState.hover) {
        padState = { active, hover };
        paintPad();
      }
    },
    pickPad,
    // 對位檢查：target（鏡頭座標，公尺）、說明文字；null＝關掉
    setAlign(target, lines) {
      align.visible = !!target;
      if (target) {
        alignRing.position.set(target.x, target.y, target.z);
        alignDot.position.set(target.x, target.y, target.z);
      }
      if (!target) alignText.set('');
      else alignText.set(lines?.length ? [...lines, '', ''].slice(0, 3) : '', { color: '#fff3c2', border: 'rgba(255,209,102,0.7)' });
    },
    // 21 個關節（世界座標）＋射線（from → to）＋顏色
    setHand(points, state, from, to) {
      if (!points) {
        hand.visible = false;
        return;
      }
      hand.visible = true;
      const color = _c.setHex(HAND_COLORS[state] ?? HAND_COLORS.tracking);
      joints.material.color.copy(color);
      bones.material.color.copy(color);
      ray.material.color.copy(color);
      dot.material.color.copy(color);
      for (let i = 0; i < 21; i += 1) {
        const p = points[i];
        const r = i === 4 || i === 8 ? 0.009 : 0.006;
        joints.setMatrixAt(i, _m.makeScale(r, r, r).setPosition(p));
      }
      joints.instanceMatrix.needsUpdate = true;
      BONES.forEach(([a, b], k) => {
        points[a].toArray(bonePos, k * 6);
        points[b].toArray(bonePos, k * 6 + 3);
      });
      bones.geometry.attributes.position.needsUpdate = true;
      ray.visible = !!(from && to);
      dot.visible = ray.visible;
      if (ray.visible) {
        from.toArray(rayPos, 0);
        to.toArray(rayPos, 3);
        ray.geometry.attributes.position.needsUpdate = true;
        dot.position.copy(to);
      }
    },
    showPreview(on) {
      previewWanted = on;
      preview.visible = on;
    },
    // 鏡頭小畫面：有新的辨識結果時才重畫（不是每格都上傳材質）
    drawPreview(video, hands, { mirror = false } = {}) {
      if (!previewWanted || !video?.videoWidth) return;
      pctx.save();
      if (mirror) {
        pctx.translate(pc.width, 0);
        pctx.scale(-1, 1);
      }
      pctx.drawImage(video, 0, 0, pc.width, pc.height);
      pctx.restore();
      pctx.fillStyle = '#9dff5c';
      for (const h of hands || []) {
        for (let i = 0; i < 21; i += 1) {
          const x = (mirror ? 1 - h.lm[i * 3] : h.lm[i * 3]) * pc.width;
          const y = h.lm[i * 3 + 1] * pc.height;
          pctx.fillRect(x - 2, y - 2, 4, 4);
        }
      }
      pctx.strokeStyle = 'rgba(56,225,255,0.8)';
      pctx.lineWidth = 3;
      pctx.strokeRect(1.5, 1.5, pc.width - 3, pc.height - 3);
      ptex.needsUpdate = true;
    },
    dispose() {
      head.removeFromParent();
      menu.removeFromParent();
      hand.removeFromParent();
      align.removeFromParent();
      disposeButtons();
      for (const d of disposables) d.dispose();
      plate.geometry.dispose();
      plate.material.dispose();
      reticle.geometry.dispose();
      reticle.material.dispose();
      preview.geometry.dispose();
      preview.material.dispose();
      ptex.dispose();
      for (const o of [joints, bones, ray, dot, alignRing, alignDot]) {
        o.geometry.dispose();
        o.material.dispose();
      }
    },
  };
}
