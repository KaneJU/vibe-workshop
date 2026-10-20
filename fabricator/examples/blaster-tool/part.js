export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = '能量槍';
  // 材質：白色聚合物外殼、槍鐵、橡膠握把、發光（遊戲裡換顏色）、玻璃能量匣
  const shell = new THREE.MeshStandardMaterial({ color: 0xebe8df, roughness: 0.42, metalness: 0.05 });
  const shellDark = new THREE.MeshStandardMaterial({ color: 0xc9c5b9, roughness: 0.5, metalness: 0.05 });
  const gunmetal = new THREE.MeshStandardMaterial({ color: 0x3b444d, roughness: 0.32, metalness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa6b2, roughness: 0.25, metalness: 0.9 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.92, metalness: 0 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x7cf8ff, emissive: 0x2fd6ff, emissiveIntensity: 2.4, roughness: 0.3 });
  glow.userData.toolGlow = true; // 遊戲裡換顏色時，發光的部分跟著變
  const glass = new THREE.MeshStandardMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.3, roughness: 0.05, metalness: 0, depthWrite: false });
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xbffcff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  flashMat.userData.toolGlow = true;
  const reticleMat = new THREE.MeshBasicMaterial({ color: 0x9dff5c, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  function mesh(geo, mat, x, y, z, name, parent = root) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.name = name;
    parent.add(m);
    return m;
  }
  const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const C = (rt, rb, h, seg = 20) => new THREE.CylinderGeometry(rt, rb, h, seg);

  // ---- 握把（原點在握把底部中心，槍口朝 +Z）：橡膠、指槽、往後斜 ----
  const grip = new THREE.Group();
  grip.name = '握把';
  grip.position.set(0, 0.008, -0.04);
  grip.rotation.x = -0.3;
  root.add(grip);
  mesh(B(0.036, 0.112, 0.048), rubber, 0, 0.056, 0, '握把本體', grip);
  for (let i = 0; i < 3; i += 1) mesh(B(0.038, 0.006, 0.012), gunmetal, 0, 0.03 + i * 0.026, 0.024, '指槽', grip);
  mesh(B(0.04, 0.012, 0.054), gunmetal, 0, 0.004, 0, '握把底蓋', grip);

  // ---- 槍身 ----
  const body = new THREE.Group();
  body.name = '槍身';
  body.position.set(0, 0.128, 0);
  root.add(body);
  mesh(B(0.05, 0.034, 0.17), gunmetal, 0, -0.024, 0.02, '下機匣', body);
  mesh(B(0.058, 0.05, 0.19), shell, 0, 0.012, 0.012, '外殼', body);
  // 倒角：外殼四條邊用深一點的條子，看起來不是一塊方磚
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mesh(B(0.006, 0.006, 0.188), shellDark, sx * 0.028, 0.012 + sy * 0.024, 0.012, '倒角', body);
  // 面板線與側面發光條
  for (const sx of [-1, 1]) {
    mesh(B(0.002, 0.03, 0.003), gunmetal, sx * 0.0292, 0.012, 0.05, '面板線', body);
    mesh(B(0.002, 0.03, 0.003), gunmetal, sx * 0.0292, 0.012, -0.03, '面板線', body);
    mesh(B(0.003, 0.006, 0.07), glow, sx * 0.0295, -0.002, 0.012, '側面燈條', body);
  }
  // 上方導軌＋全像瞄具
  mesh(B(0.026, 0.008, 0.15), gunmetal, 0, 0.041, 0.01, '導軌', body);
  for (let i = 0; i < 6; i += 1) mesh(B(0.028, 0.003, 0.006), steel, 0, 0.046, -0.05 + i * 0.022, '導軌齒', body);
  const sight = new THREE.Group();
  sight.name = '全像瞄具';
  sight.position.set(0, 0.05, -0.01);
  body.add(sight);
  mesh(B(0.034, 0.008, 0.04), gunmetal, 0, 0, 0, '瞄具座', sight);
  for (const sx of [-1, 1]) mesh(B(0.004, 0.032, 0.006), gunmetal, sx * 0.016, 0.018, 0.012, '瞄具框', sight);
  mesh(B(0.036, 0.004, 0.006), gunmetal, 0, 0.035, 0.012, '瞄具框頂', sight);
  const lens = mesh(new THREE.PlaneGeometry(0.026, 0.026), glass, 0, 0.018, 0.012, '瞄具鏡片', sight);
  lens.userData.noCollide = true;
  const reticle = mesh(new THREE.RingGeometry(0.0035, 0.005, 16), reticleMat, 0, 0.018, 0.0115, '紅點', sight);
  reticle.userData.noCollide = true;
  // 側面能量匣（玻璃管裡有發光的芯）
  const cell = new THREE.Group();
  cell.name = '能量匣';
  cell.position.set(-0.034, -0.012, -0.035);
  cell.rotation.x = Math.PI / 2;
  body.add(cell);
  mesh(C(0.011, 0.011, 0.07, 16), glass, 0, 0, 0, '能量匣玻璃', cell);
  const core = mesh(C(0.0055, 0.0055, 0.064, 12), glow, 0, 0, 0, '能量芯', cell);
  for (const y of [-0.037, 0.037]) mesh(C(0.013, 0.013, 0.006, 16), gunmetal, 0, y, 0, '能量匣蓋', cell);
  // 槍管：散熱護套＋三圈線圈＋槍口
  const barrel = new THREE.Group();
  barrel.name = '槍管';
  barrel.position.set(0, 0.006, 0.106);
  body.add(barrel);
  const shroud = mesh(C(0.019, 0.021, 0.07, 20), gunmetal, 0, 0, 0.035, '散熱護套', barrel);
  shroud.rotation.x = Math.PI / 2;
  for (let i = 0; i < 4; i += 1) {
    const vent = mesh(C(0.0215, 0.0215, 0.004, 20), rubber, 0, 0, 0.012 + i * 0.016, '散熱槽', barrel);
    vent.rotation.x = Math.PI / 2;
  }
  const inner = mesh(C(0.011, 0.011, 0.11, 16), steel, 0, 0, 0.07, '內管', barrel);
  inner.rotation.x = Math.PI / 2;
  const rings = [];
  for (const z of [0.082, 0.1, 0.118]) {
    const r = mesh(new THREE.TorusGeometry(0.017, 0.0042, 8, 24), glow, 0, 0, z, '線圈', barrel);
    rings.push(r);
  }
  const crown = mesh(C(0.016, 0.02, 0.016, 8), gunmetal, 0, 0, 0.13, '槍口', barrel);
  crown.rotation.x = Math.PI / 2;
  const muzzle = new THREE.Object3D();
  muzzle.name = '槍口';
  muzzle.position.set(0, 0, 0.142);
  barrel.add(muzzle);
  const flash = mesh(new THREE.SphereGeometry(0.03, 12, 8), flashMat, 0, 0, 0.15, '槍口火光', barrel);
  flash.userData.noCollide = true;
  // 扳機與護弓、尾端指示燈
  const trigger = mesh(B(0.008, 0.024, 0.01), steel, 0, -0.05, -0.002, '扳機', body);
  mesh(new THREE.TorusGeometry(0.02, 0.004, 6, 16, Math.PI), gunmetal, 0, -0.044, -0.002, '扳機護弓', body).rotation.set(0, Math.PI / 2, Math.PI);
  mesh(B(0.05, 0.03, 0.02), gunmetal, 0, 0.004, -0.09, '尾塊', body);
  mesh(B(0.03, 0.005, 0.002), glow, 0, 0.012, -0.1005, '尾燈', body);

  root.userData.muzzle = muzzle; // 道具行為從這裡射出
  let kick = 0;
  let charge = 0;
  root.userData.onFire = () => {
    kick = 1;
    charge = 1;
  };
  root.userData.onControl = (s) => {
    if (s.action) kick = Math.max(kick, 0.6);
  };
  root.userData.update = (dt, t) => {
    const d = Math.min(Math.max(dt, 0), 0.05);
    kick = Math.max(0, kick - d * 8);
    charge = Math.max(0, charge - d * 3);
    // 後座：槍身往後、槍口上揚，很快回正
    body.position.z = -0.016 * kick;
    body.rotation.x = -0.1 * kick;
    trigger.position.z = -0.002 - 0.006 * kick;
    flashMat.opacity = kick * 0.9;
    flash.scale.setScalar(0.6 + kick);
    glow.emissiveIntensity = 2.2 + kick * 4 + Math.sin(t * 4) * 0.2;
    core.scale.y = 0.85 + 0.15 * Math.sin(t * 6) + charge * 0.2;
    rings.forEach((r, i) => (r.rotation.z = t * (1.4 + i) + charge * 4));
  };
  return root;
}
