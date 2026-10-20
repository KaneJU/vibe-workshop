// 眼鏡模式的 3D 介面：戴上之後摸不到螢幕上的小按鈕，所以介面都是場景裡的東西，兩眼看得到同一個位置（融合得起來）。
// - 跟著頭的：狀態（手追到了沒、可以抓、抓著、暫停）、鏡頭狀態、提示訊息、診斷（要打開才有）、鏡頭小畫面
// - 放在世界裡的：低頭看得到的「⟳ 回正」「✕ 離開」，盯著 1.5 秒就按下去（視線停留）
// - 手：21 個關節的線框手＋射線＋落點，顏色表示狀態
const FONT = "-apple-system, BlinkMacSystemFont, 'PingFang TC', 'Noto Sans TC', sans-serif";

export const HAND_COLORS = { tracking: 0x38e1ff, hover: 0xfff36b, grabbing: 0x9dff5c, paused: 0x8a97a6 };

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
  const status = panel({ width: 0.78, height: 0.11 }, 0, 0.5);
  const camState = panel({ width: 0.78, height: 0.09 }, 0, 0.39);
  const toastP = panel({ width: 1.2, height: 0.13 }, 0, -0.36);
  // 說明（鏡頭打不開、沒有動作感測…）：最多三行，字才不會為了擠成一行縮到看不見
  const help = panel({ width: 1.1, height: 0.27 }, 0, 0.2);
  help.mesh.visible = false;
  const diag = panel({ width: 0.62, height: 0.62, ppm: 380, align: 'left' }, -0.8, 0.05);
  diag.mesh.visible = false;

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
  preview.position.set(0.62, -0.32, -D);
  preview.renderOrder = 30;
  preview.visible = false;
  head.add(preview);

  // 低頭看到的選單（放在世界裡，看得到才盯得住）
  const menu = new THREE.Group();
  menu.name = 'headset-menu';
  scene.add(menu);
  const buttons = [];
  const addButton = (id, label, x) => {
    const p = textPanel(THREE, { width: 0.42, height: 0.16 });
    p.mesh.position.set(x, 0, 0);
    p.mesh.userData.buttonId = id;
    p.label = label;
    p.set(label);
    menu.add(p.mesh);
    disposables.push(p);
    buttons.push({ id, panel: p, dwell: 0, armed: true });
  };
  addButton('recenter', '⟳ 回正', -0.47);
  addButton('calib', '▦ 校正圖', 0);
  addButton('exit', '✕ 離開眼鏡模式', 0.47);
  const menuHint = textPanel(THREE, { width: 0.9, height: 0.08 });
  menuHint.set('盯著按鈕 1.5 秒（低頭看得到）');
  menuHint.mesh.position.set(0, 0.14, 0);
  menu.add(menuHint.mesh);
  disposables.push(menuHint);

  // 手
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
  let toastUntil = 0;
  let previewWanted = false;

  return {
    status,
    camState,
    head,
    menu,
    setStatus(text, color = '#d9f6ff') {
      status.set(text, { color });
    },
    setCamera(text, warn = false) {
      camState.set(text, { color: warn ? '#ffd166' : '#9fb8c8', border: warn ? 'rgba(255,209,102,0.6)' : 'rgba(56,225,255,0.3)' });
    },
    setHelp(lines) {
      if (!lines?.length) {
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
    // 選單放在「回正的方向」正前方、往下 38° 的地方
    placeMenu(headPos, yaw) {
      const pitch = (-38 * Math.PI) / 180;
      const dist = 1.5;
      const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      menu.position.copy(headPos).addScaledVector(dir, dist);
      menu.lookAt(headPos);
    },
    // 視線停留：回傳這一格被「按下」的按鈕 id
    gaze(dt) {
      camera.getWorldPosition(_o);
      camera.getWorldQuaternion(_q);
      _d.set(0, 0, -1).applyQuaternion(_q);
      raycaster.set(_o, _d);
      const hit = raycaster.intersectObjects(buttons.map((b) => b.panel.mesh), false)[0];
      let fired = null;
      let progress = 0;
      for (const b of buttons) {
        const on = hit?.object === b.panel.mesh;
        if (!on) {
          b.dwell = 0;
          b.armed = true;
        } else if (b.armed) {
          b.dwell += dt;
          progress = b.dwell / 1.5;
          if (b.dwell >= 1.5) {
            fired = b.id;
            b.dwell = 0;
            b.armed = false; // 要先移開視線，才會再按一次
          }
        }
        b.panel.set(b.panel.label, { progress: on && b.armed ? b.dwell / 1.5 : 0, border: on ? 'rgba(157,255,92,0.9)' : undefined });
      }
      reticle.scale.setScalar(1 + progress * 1.5);
      reticle.material.color.setHex(progress > 0 ? 0x9dff5c : 0xd9f6ff);
      return fired;
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
      for (const d of disposables) d.dispose();
      reticle.geometry.dispose();
      reticle.material.dispose();
      preview.geometry.dispose();
      preview.material.dispose();
      ptex.dispose();
      for (const o of [joints, bones, ray, dot]) {
        o.geometry.dispose();
        o.material.dispose();
      }
    },
  };
}
