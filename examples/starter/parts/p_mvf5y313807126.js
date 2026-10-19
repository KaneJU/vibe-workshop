export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = '八方藍光能量環';
  const radius = 2.2;
  for (let i = 0; i < 8; i++) {
    const part = ctx.spawn('p_mvf5xgk6a7157a');
    if (!part) continue;
    const angle = (i / 8) * Math.PI * 2;
    const mount = new THREE.Group();
    mount.name = `能量方塊朝向座_${i + 1}`;
    mount.position.set(Math.sin(angle) * radius, 0, -Math.cos(angle) * radius);
    mount.rotation.y = -angle;
    mount.add(part);
    root.add(mount);
    const worldPosition = new THREE.Vector3();
    mount.userData.update = () => {
      mount.getWorldPosition(worldPosition);
      mount.lookAt(ctx.player.position.x, worldPosition.y, ctx.player.position.z);
    };
  }
  return root;
}
