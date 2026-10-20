export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = '木板';
  const wood = new THREE.MeshStandardMaterial({ color: 0xb98145, roughness: 0.88, metalness: 0 });
  const grain = new THREE.MeshStandardMaterial({ color: 0x80532c, roughness: 1 });
  const lightGrain = new THREE.MeshStandardMaterial({ color: 0xcd995d, roughness: 1 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.12, 1.6), wood);
  body.name = '厚實木板';
  body.position.y = 0.06;
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);
  // Thin irregular ribbons give the flat mounting surfaces longitudinal wood grain.
  for (let i = 0; i < 25; i++) {
    const x = -0.375 + i * 0.031;
    const start = -0.77 + ctx.random() * 0.15;
    const length = 0.55 + ctx.random() * 0.82;
    const width = 0.001 + ctx.random() * 0.002;
    const vertices = [];
    for (let j = 0; j <= 16; j++) {
      const z = start + length * j / 16;
      const xx = x + Math.sin(j * 0.41 + i * 1.7) * 0.006;
      vertices.push(xx - width, 0.12015, z, xx + width, 0.12015, z);
    }
    const indices = [];
    for (let j = 0; j < 16; j++) {
      const a = j * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const line = new THREE.Mesh(geo, i % 3 === 0 ? lightGrain : grain);
    line.name = '自然木紋';
    line.userData.noCollide = true;
    root.add(line);
  }
  const endGeo = new THREE.BoxGeometry(0.774, 0.0013, 0.0003);
  for (const z of [-0.80015, 0.80015]) {
    for (let i = 0; i < 6; i++) {
      const line = new THREE.Mesh(endGeo, i % 2 ? lightGrain : grain);
      line.position.set(0, 0.017 + i * 0.017, z);
      line.userData.noCollide = true;
      root.add(line);
    }
  }
  return root;
}
