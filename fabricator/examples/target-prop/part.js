export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = '標靶';
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.6 });
  const red = new THREE.MeshStandardMaterial({ color: 0xff4d5e, emissive: 0x5a0a12, emissiveIntensity: 0.6, roughness: 0.5 });
  const cyan = new THREE.MeshStandardMaterial({ color: 0x38e1ff, emissive: 0x0b6f8f, emissiveIntensity: 0.9, roughness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a3540, roughness: 0.5, metalness: 0.5 });
  function mesh(geo, mat, x, y, z, name, parent = root) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.name = name;
    parent.add(m);
    return m;
  }
  // 底座與支柱（原點在底部中心，靶面朝 +Z）
  mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.06, 24), dark, 0, 0.03, 0, '底座');
  mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.62, 12), dark, 0, 0.37, 0, '支柱');
  const face = new THREE.Group();
  face.name = '靶面';
  face.position.set(0, 0.95, 0.03);
  root.add(face);
  const disc = (r, mat, z, name) => {
    const m = mesh(new THREE.CylinderGeometry(r, r, 0.03, 40), mat, 0, 0, z, name, face);
    m.rotation.x = Math.PI / 2;
    return m;
  };
  disc(0.36, dark, -0.012, '靶背');
  disc(0.33, white, 0, '外圈');
  disc(0.25, red, 0.004, '中圈');
  disc(0.17, white, 0.008, '內圈');
  disc(0.09, cyan, 0.012, '靶心');
  const halo = mesh(new THREE.TorusGeometry(0.38, 0.018, 8, 48), new THREE.MeshBasicMaterial({ color: 0x9dff5c, transparent: true, opacity: 0, depthWrite: false }), 0, 0, 0.02, '命中光環', face);
  halo.userData.noCollide = true;
  let hit = 0;
  root.userData.onHit = () => {
    hit = 1;
  };
  root.userData.update = (dt, t) => {
    const d = Math.min(Math.max(dt, 0), 0.05);
    hit = Math.max(0, hit - d * 2.2);
    face.rotation.x = -Math.sin(hit * Math.PI * 3) * 0.35 * hit;
    halo.material.opacity = hit * 0.9;
    halo.scale.setScalar(hit > 0 ? 1 + (1 - hit) * 0.6 : 1); // 平常不放大（外框才不會被看不見的光環撐大）
    cyan.emissiveIntensity = 0.9 + hit * 4 + Math.sin(t * 3) * 0.15;
  };
  return root;
}
