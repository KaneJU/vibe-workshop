// 訓練場（遊戲房、首頁用的場景）：把空黑天空＋無邊灰地，換成有前中後景、尺度參照和光源方向的室內靶場。
// - 天空：漸層穹頂（天頂深藍 → 地平線霧藍），霧跟地平線同色，遠處不會一刀切成黑色
// - 地面：混凝土（有接縫、髒污的程序貼圖）、靶道分隔線、5／10／15 公尺距離線與數字、射擊線
// - 結構：後牆（靶擋）、兩側矮牆與柱子、頂上的桁架和燈條 —— 都在玩家走不到的地方（玩家位置會被限制在場內）
// - 光：天光＋地面反光、一盞有陰影的主光（陰影範圍蓋住整個靶場）、一盞反方向的補光；手機用較小的陰影貼圖
// - 接觸陰影：標靶和人偶腳下的柔和陰影貼片，陰影貼圖解析度低時東西也不會像浮在空中
// 全部是程式產生的幾何與貼圖（沒有外部素材），材質、貼圖共用，離開時一次釋放。

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const RANGE = { width: 22, back: -17.5, front: 6, lanes: [-6, -2, 2, 6] };

export function createArena({ THREE, scene, renderer, env, sun, hemi, isTouch }) {
  const group = new THREE.Group();
  group.name = 'training-range';
  scene.add(group);
  const disposables = [];
  const keep = (x) => (disposables.push(x), x);
  const maxAniso = Math.min(isTouch ? 4 : 8, renderer.capabilities.getMaxAnisotropy?.() || 1);

  // ---------- 程序貼圖 ----------
  function canvasTexture(size, draw, repeat = [1, 1]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    draw(g, size);
    const t = keep(new THREE.CanvasTexture(c));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = maxAniso;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const rand = (() => {
    let s = 7;
    return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
  })();
  // 混凝土：底色＋大塊明暗＋細顆粒＋接縫
  const concrete = canvasTexture(
    512,
    (g, n) => {
      g.fillStyle = '#5d636b';
      g.fillRect(0, 0, n, n);
      for (let i = 0; i < 70; i += 1) {
        const r = 30 + rand() * 120;
        const grd = g.createRadialGradient(rand() * n, rand() * n, 0, rand() * n, rand() * n, r);
        const a = 0.04 + rand() * 0.06;
        grd.addColorStop(0, rand() < 0.5 ? `rgba(20,24,30,${a})` : `rgba(160,166,174,${a})`);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, n, n);
      }
      const img = g.getImageData(0, 0, n, n);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = (rand() - 0.5) * 22;
        img.data[i] += v;
        img.data[i + 1] += v;
        img.data[i + 2] += v;
      }
      g.putImageData(img, 0, 0);
      g.strokeStyle = 'rgba(25,28,33,0.55)';
      g.lineWidth = 3;
      g.strokeRect(1.5, 1.5, n - 3, n - 3); // 每 4 公尺一塊的伸縮縫
    },
    [RANGE.width / 4, 26 / 4],
  );
  // 牆板：深灰、橫向接縫、偶爾的螺栓
  const panel = canvasTexture(
    256,
    (g, n) => {
      g.fillStyle = '#3a414a';
      g.fillRect(0, 0, n, n);
      for (let y = 0; y < n; y += n / 4) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(0, y, n, 3);
        g.fillStyle = 'rgba(255,255,255,0.05)';
        g.fillRect(0, y + 3, n, 2);
      }
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(n - 3, 0, 3, n);
      g.fillStyle = 'rgba(200,210,220,0.25)';
      for (let i = 0; i < 6; i += 1) g.fillRect(8 + (i % 2) * (n - 24), 10 + Math.floor(i / 2) * (n / 3), 6, 6);
    },
    [6, 1],
  );
  // 接觸陰影：中心深、往外淡掉
  const blob = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)');
    grd.addColorStop(0.5, 'rgba(0,0,0,0.25)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return keep(new THREE.CanvasTexture(c));
  })();
  function numberTexture(text) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(230,236,240,0.85)';
    g.font = 'bold 96px -apple-system, "Helvetica Neue", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 70);
    const t = keep(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------- 材質（共用） ----------
  const M = {
    floor: keep(new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.88, metalness: 0.02 })),
    paint: keep(new THREE.MeshStandardMaterial({ color: 0xe8d25a, roughness: 0.7, metalness: 0 })),
    paintWhite: keep(new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.75, metalness: 0 })),
    wall: keep(new THREE.MeshStandardMaterial({ map: panel, roughness: 0.8, metalness: 0.15 })),
    berm: keep(new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.95, metalness: 0 })),
    steel: keep(new THREE.MeshStandardMaterial({ color: 0x8a96a3, roughness: 0.35, metalness: 0.85 })),
    darkSteel: keep(new THREE.MeshStandardMaterial({ color: 0x323a44, roughness: 0.45, metalness: 0.8 })),
    rubber: keep(new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.95, metalness: 0 })),
    lamp: keep(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdff4ff, emissiveIntensity: 2.2, roughness: 0.4 })),
    accent: keep(new THREE.MeshStandardMaterial({ color: 0x0b2a35, emissive: 0x38e1ff, emissiveIntensity: 1.4, roughness: 0.5 })),
    shadow: keep(new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false, toneMapped: false })),
  };
  const box = (w, h, d, mat, x, y, z, parent = group, cast = false) => {
    const m = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // ---------- 天空穹頂 ----------
  const skyMat = keep(
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(0x14284a) }, mid: { value: new THREE.Color(0x2f5274) }, horizon: { value: new THREE.Color(0x86a3b8) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; varying vec3 vP; void main(){ float h = clamp(vP.y, -0.2, 1.0); vec3 c = h < 0.12 ? mix(horizon, mid, smoothstep(-0.05, 0.12, h)) : mix(mid, top, smoothstep(0.12, 0.75, h)); gl_FragColor = vec4(c, 1.0); }',
    }),
  );
  const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(140, 32, 16)), skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  group.add(sky);

  // ---------- 靶場本體 ----------
  const W = RANGE.width;
  const depth = RANGE.front - RANGE.back;
  const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(W, depth)), M.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.003, (RANGE.front + RANGE.back) / 2);
  floor.receiveShadow = true;
  group.add(floor);
  const flat = (w, d, mat, x, z, y = 0.006) => {
    const m = new THREE.Mesh(keep(new THREE.PlaneGeometry(w, d)), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  // 射擊線（黃）、靶道分隔線、距離線與數字
  flat(W - 1, 0.14, M.paint, 0, 0.45);
  for (const x of RANGE.lanes) flat(0.07, depth - 3, M.paintWhite, x, (RANGE.back + 0.45) / 2 - 0.4);
  for (const d of [5, 10, 15]) {
    flat(W - 1, 0.06, M.paintWhite, 0, 0.45 - d);
    const num = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.4, 0.7)), keep(new THREE.MeshBasicMaterial({ map: numberTexture(`${d}m`), transparent: true, depthWrite: false })));
    num.rotation.x = -Math.PI / 2;
    num.position.set(-W / 2 + 1.6, 0.008, 0.45 - d + 0.6);
    group.add(num);
  }
  // 射擊台（膝高，前緣在射擊線上；玩家站在後面）
  const bench = new THREE.Group();
  group.add(bench);
  box(W - 3, 0.08, 0.55, M.darkSteel, 0, 0.95, 0.18, bench);
  box(W - 3, 0.04, 0.5, M.rubber, 0, 1.0, 0.18, bench);
  for (const x of [-9, -5, -1, 1, 5, 9].filter((v) => Math.abs(v) < W / 2 - 1.5)) box(0.08, 0.95, 0.08, M.steel, x, 0.475, 0.18, bench);
  // 後牆（靶擋）：深色斜坡＋牆板＋燈條
  box(W + 2, 5.2, 0.6, M.wall, 0, 2.6, RANGE.back - 0.3);
  const bermGeo = keep(new THREE.BoxGeometry(W, 1.6, 3));
  const berm = new THREE.Mesh(bermGeo, M.berm);
  berm.position.set(0, 0.55, RANGE.back + 1.2);
  berm.rotation.x = -0.35;
  berm.receiveShadow = true;
  group.add(berm);
  box(W, 0.08, 0.08, M.accent, 0, 3.9, RANGE.back + 0.02, group, false);
  // 兩側：矮牆＋柱子＋上面的燈條
  for (const s of [-1, 1]) {
    const x = s * (W / 2 + 0.25);
    box(0.5, 1.3, depth, M.wall, x, 0.65, (RANGE.front + RANGE.back) / 2);
    for (let z = RANGE.front - 1; z > RANGE.back; z -= 5) {
      box(0.35, 6.4, 0.35, M.darkSteel, x, 3.2, z);
      box(0.06, 0.9, 0.06, M.accent, x - s * 0.2, 2.2, z, group, false);
    }
    // 距離牌（牆上）
    for (const d of [5, 10, 15]) {
      const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.1, 0.55)), keep(new THREE.MeshBasicMaterial({ map: numberTexture(`${d}m`), transparent: true })));
      sign.position.set(x - s * 0.27, 1.75, 0.45 - d);
      sign.rotation.y = -s * Math.PI / 2;
      group.add(sign);
    }
  }
  // 頂上的桁架和燈（尺度參照，也解釋光從哪裡來）
  for (let z = 2; z > RANGE.back; z -= 6) {
    box(W + 1, 0.22, 0.22, M.darkSteel, 0, 6.3, z, group, false);
    box(W + 1, 0.12, 0.12, M.darkSteel, 0, 5.85, z, group, false);
    for (const x of [-7, 0, 7]) box(2.2, 0.06, 0.32, M.lamp, x, 6.12, z, group, false);
  }

  // ---------- 光 ----------
  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(0, 0, -6);
  group.add(sunTarget);
  const saved = {
    sun: { pos: sun.position.clone(), color: sun.color.clone(), intensity: sun.intensity, target: sun.target, cam: { ...sun.shadow.camera }, map: sun.shadow.mapSize.clone() },
    hemi: { sky: hemi.color.clone(), ground: hemi.groundColor.clone(), intensity: hemi.intensity },
    exposure: renderer.toneMappingExposure,
    env: scene.environmentIntensity,
  };
  sun.position.set(7, 15, 6);
  sun.target = sunTarget;
  sun.color.set(0xfff1dc);
  sun.intensity = 2.4;
  Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 16, bottom: -16, near: 1, far: 50 });
  sun.shadow.camera.updateProjectionMatrix();
  const mapSize = isTouch ? 1024 : 2048;
  if (sun.shadow.mapSize.x !== mapSize) {
    sun.shadow.mapSize.set(mapSize, mapSize);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }
  sun.shadow.radius = 3;
  hemi.color.set(0xb9d6ff);
  hemi.groundColor.set(0x4a3f33);
  hemi.intensity = 1.0;
  env.background(0x0c1a33);
  env.fog(0x7b98ad, 28, 95);
  env.ground({ color: 0x2b3036, roughness: 0.95, metalness: 0 });
  env.grid(false);
  env.pad(false);
  renderer.toneMappingExposure = 1.05;
  scene.environmentIntensity = 0.7;

  // 接觸陰影貼片（給標靶、人偶用）
  const shadowGeo = keep(new THREE.PlaneGeometry(1, 1));
  function contactShadow(size = 1) {
    const m = new THREE.Mesh(shadowGeo, M.shadow);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.012;
    m.scale.set(size, size, 1);
    m.renderOrder = 1;
    m.raycast = () => {}; // 只是陰影：子彈、點選都穿過去
    return m;
  }

  // 玩家站的範圍：射擊台後面（靶場）或中間平台（競技場）
  function clampPlayer(arenaKind, p) {
    if (arenaKind === 'ring') {
      const r = Math.hypot(p.x, p.z);
      if (r > 5) {
        p.x *= 5 / r;
        p.z *= 5 / r;
      }
      return p;
    }
    p.x = Math.min(W / 2 - 0.8, Math.max(-W / 2 + 0.8, p.x));
    p.z = Math.min(RANGE.front - 0.8, Math.max(0.85, p.z));
    return p;
  }

  // 競技場：靶道結構收起來，換成一圈矮牆
  const ring = new THREE.Group();
  ring.visible = false;
  group.add(ring);
  {
    const segs = 28;
    for (let i = 0; i < segs; i += 1) {
      const a = (i / segs) * Math.PI * 2;
      const seg = box(2.3, 1.2, 0.45, M.wall, Math.sin(a) * 11.6, 0.6, -Math.cos(a) * 11.6, ring);
      seg.rotation.y = -a;
      if (i % 4 === 0) {
        const post = box(0.32, 5.5, 0.32, M.darkSteel, Math.sin(a) * 12.1, 2.75, -Math.cos(a) * 12.1, ring);
        post.rotation.y = -a;
      }
    }
    const pad = new THREE.Mesh(keep(new THREE.CylinderGeometry(5.3, 5.5, 0.06, 48)), M.darkSteel);
    pad.position.y = 0.03;
    pad.receiveShadow = true;
    ring.add(pad);
    const edge = new THREE.Mesh(keep(new THREE.TorusGeometry(5.4, 0.04, 6, 64)), M.accent);
    edge.rotation.x = Math.PI / 2;
    edge.position.y = 0.07;
    ring.add(edge);
  }
  // 靜態結構依材質合併成少數幾個網格（幾百個小方塊 → 十幾次繪製）
  function mergeStatic(parent) {
    parent.updateMatrixWorld(true);
    const inv = parent.matrixWorld.clone().invert();
    const byMat = new Map();
    const remove = [];
    parent.traverse((o) => {
      if (!o.isMesh || o === sky || o === floor || o.material === M.shadow || o.material.transparent) return;
      const g = o.geometry.index ? o.geometry.clone() : o.geometry.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      const key = `${o.material.uuid}:${o.castShadow ? 1 : 0}`;
      if (!byMat.has(key)) byMat.set(key, { mat: o.material, cast: o.castShadow, geos: [] });
      byMat.get(key).geos.push(g);
      remove.push(o);
    });
    for (const o of remove) o.removeFromParent();
    for (const { mat, cast, geos } of byMat.values()) {
      const merged = keep(mergeGeometries(geos, false));
      geos.forEach((g) => g.dispose());
      const m = new THREE.Mesh(merged, mat);
      m.castShadow = cast;
      m.receiveShadow = true;
      parent.add(m);
    }
  }
  const rangeGroup = new THREE.Group();
  for (const c of group.children.filter((c) => c !== sky && c !== ring && c !== sunTarget && c !== floor)) rangeGroup.add(c);
  group.add(rangeGroup);
  mergeStatic(rangeGroup);
  mergeStatic(ring);
  const rangeParts = [rangeGroup];
  function setKind(kind) {
    const isRing = kind === 'ring';
    ring.visible = isRing;
    for (const c of rangeParts) c.visible = !isRing || c === floor;
  }

  return {
    group,
    setKind,
    clampPlayer,
    contactShadow,
    materials: M,
    dispose() {
      group.removeFromParent();
      for (const d of disposables) d.dispose?.();
      sun.position.copy(saved.sun.pos);
      sun.color.copy(saved.sun.color);
      sun.intensity = saved.sun.intensity;
      sun.target = saved.sun.target;
      Object.assign(sun.shadow.camera, saved.sun.cam);
      sun.shadow.camera.updateProjectionMatrix();
      hemi.color.copy(saved.hemi.sky);
      hemi.groundColor.copy(saved.hemi.ground);
      hemi.intensity = saved.hemi.intensity;
      renderer.toneMappingExposure = saved.exposure;
      scene.environmentIntensity = saved.env;
      env.reset();
    },
  };
}
