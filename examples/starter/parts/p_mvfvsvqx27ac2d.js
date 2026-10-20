export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = '輪子';
  const stone = new THREE.MeshStandardMaterial({color:0xd5d0b6, roughness:0.78, metalness:0.12});
  const rubber = new THREE.MeshStandardMaterial({color:0x293d37, roughness:0.92});
  const metal = new THREE.MeshStandardMaterial({color:0x65766a, roughness:0.42, metalness:0.65});
  const glow = new THREE.MeshStandardMaterial({color:0x53d8b4, emissive:0x19d9a0, emissiveIntensity:0.45, roughness:0.35, metalness:0.2});
  const hub = new THREE.Group();
  hub.name = 'motor_wheel';
  hub.position.y = 0.35;
  root.add(hub);
  function cylinder(name, radius, length, x, mat) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,length,48),mat);
    mesh.rotation.z = Math.PI/2;
    mesh.position.x = x;
    mesh.name = name;
    hub.add(mesh);
    return mesh;
  }
  function ring(name, radius, tube, x, mat) {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius,tube,8,48),mat);
    mesh.rotation.y = Math.PI/2;
    mesh.position.x = x;
    mesh.name = name;
    hub.add(mesh);
  }
  cylinder('深綠耐磨輪胎',0.34,0.29,0,rubber);
  const treadGeo = new THREE.BoxGeometry(0.28,0.018,0.052);
  for(let i=0;i<24;i++) {
    const a=i*Math.PI*2/24;
    const tread=new THREE.Mesh(treadGeo,metal);
    tread.position.set(0,Math.cos(a)*0.34,Math.sin(a)*0.34);
    tread.rotation.x=a;
    tread.name='胎面抓地塊';
    hub.add(tread);
  }
  const spokeGeo = new THREE.BoxGeometry(0.027,0.155,0.053);
  const boltGeo = new THREE.SphereGeometry(0.014,8,6);
  for(const side of [-1,1]) {
    cylinder('石質輪面',0.279,0.025,side*0.15,stone);
    ring('護邊',0.285,0.018,side*0.154,metal);
    ring('青綠能量環',0.239,0.008,side*0.169,glow);
    cylinder('馬達輪轂',0.105,0.055,side*0.18,metal);
    cylinder('黏合軸端',0.075,0.055,side*0.2275,stone);
    cylinder('軸端能量印',0.043,0.004,side*0.257,glow);
    for(let i=0;i<6;i++) {
      const a=i*Math.PI/3;
      const spoke=new THREE.Mesh(spokeGeo,stone);
      spoke.position.set(side*0.177,Math.cos(a)*0.166,Math.sin(a)*0.166);
      spoke.rotation.x=a+0.20;
      spoke.name='放射石紋';
      hub.add(spoke);
      const bolt=new THREE.Mesh(boltGeo,metal);
      bolt.position.set(side*0.175,Math.cos(a)*0.26,Math.sin(a)*0.26);
      hub.add(bolt);
    }
  }
  root.userData.onDevice = (s) => {
    glow.emissiveIntensity = s.on ? 1.7 : 0.45;
  };
  return root;
}
