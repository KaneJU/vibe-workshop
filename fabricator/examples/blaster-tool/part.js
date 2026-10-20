export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = '能量槍';
  const shell = new THREE.MeshStandardMaterial({ color: 0xe9e4d4, roughness: 0.55, metalness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24333d, roughness: 0.45, metalness: 0.6 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8aa0ad, roughness: 0.3, metalness: 0.85 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x7cf8ff, emissive: 0x2fd6ff, emissiveIntensity: 2.2, roughness: 0.3 });
  glow.userData.toolGlow = true; // 遊戲裡換顏色時，發光的部分跟著變
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xbffcff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  flashMat.userData.toolGlow = true;
  function mesh(geo, mat, x, y, z, name, parent = root) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.name = name;
    parent.add(m);
    return m;
  }
  // 握把（原點在握把底部中心，槍口朝 +Z）
  const grip = mesh(new THREE.BoxGeometry(0.034, 0.105, 0.045), dark, 0, 0.052, -0.035, '握把');
  grip.rotation.x = -0.28;
  mesh(new THREE.BoxGeometry(0.036, 0.012, 0.05), metal, 0, 0.004, -0.02, '握把底蓋');
  const body = new THREE.Group();
  body.name = '槍身';
  body.position.set(0, 0.125, 0);
  root.add(body);
  mesh(new THREE.BoxGeometry(0.05, 0.055, 0.17), shell, 0, 0, 0.01, '外殼', body);
  mesh(new THREE.BoxGeometry(0.052, 0.012, 0.15), dark, 0, 0.03, 0.01, '上蓋', body);
  mesh(new THREE.BoxGeometry(0.054, 0.008, 0.12), glow, 0, -0.01, 0.015, '能量條', body);
  // 能量核心（側面的發光圓窗）
  for (const s of [-1, 1]) {
    const core = mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.006, 20), glow, s * 0.027, 0.005, -0.03, '能量核心', body);
    core.rotation.z = Math.PI / 2;
  }
  // 槍管與槍口環
  const barrel = mesh(new THREE.CylinderGeometry(0.014, 0.017, 0.12, 20), metal, 0, 0.008, 0.145, '槍管', body);
  barrel.rotation.x = Math.PI / 2;
  const rings = [];
  for (const z of [0.12, 0.16, 0.2]) {
    const r = mesh(new THREE.TorusGeometry(0.019, 0.0045, 8, 24), glow, 0, 0.008, z, '槍口環', body);
    rings.push(r);
  }
  const muzzle = new THREE.Object3D();
  muzzle.name = '槍口';
  muzzle.position.set(0, 0.008, 0.215);
  body.add(muzzle);
  const flash = mesh(new THREE.SphereGeometry(0.03, 12, 8), flashMat, 0, 0.008, 0.225, '槍口火光', body);
  flash.userData.noCollide = true;
  // 準星與扳機
  mesh(new THREE.BoxGeometry(0.008, 0.016, 0.02), dark, 0, 0.042, 0.07, '準星', body);
  const trigger = mesh(new THREE.BoxGeometry(0.008, 0.026, 0.01), metal, 0, -0.045, -0.002, '扳機', body);
  mesh(new THREE.TorusGeometry(0.02, 0.004, 6, 16, Math.PI), dark, 0, -0.04, -0.002, '扳機護弓', body).rotation.set(0, Math.PI / 2, Math.PI);
  root.userData.muzzle = muzzle; // 道具行為從這裡射出
  let kick = 0;
  root.userData.onFire = () => {
    kick = 1;
  };
  root.userData.onControl = (s) => {
    if (s.action) kick = Math.max(kick, 0.6);
  };
  root.userData.update = (dt, t) => {
    const d = Math.min(Math.max(dt, 0), 0.05);
    kick = Math.max(0, kick - d * 7);
    body.position.z = -0.018 * kick;
    body.rotation.x = -0.12 * kick;
    trigger.position.z = -0.002 - 0.006 * kick;
    flashMat.opacity = kick * 0.9;
    flash.scale.setScalar(0.6 + kick);
    glow.emissiveIntensity = 2.2 + kick * 5 + Math.sin(t * 5) * 0.25;
    rings.forEach((r, i) => (r.rotation.z = t * (1.5 + i)));
  };
  return root;
}
