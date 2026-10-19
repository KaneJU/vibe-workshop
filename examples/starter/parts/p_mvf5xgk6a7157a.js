export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = '懸浮能量方塊';
  const metal = new THREE.MeshStandardMaterial({color:0x172d43, metalness:0.85, roughness:0.28});
  const silver = new THREE.MeshStandardMaterial({color:0x7799b0, metalness:0.8, roughness:0.24});
  const blue = new THREE.MeshStandardMaterial({color:0x45cfff, emissive:0x009dff, emissiveIntensity:3.2, roughness:0.22});
  const white = new THREE.MeshStandardMaterial({color:0xc8faff, emissive:0x70dfff, emissiveIntensity:4.0, roughness:0.18});
  const glass = new THREE.MeshPhysicalMaterial({color:0x2183b4, transparent:true, opacity:0.13, metalness:0.2, roughness:0.15, depthWrite:false});
  function mesh(geo, mat, parent, name, x=0,y=0,z=0) {
    const m = new THREE.Mesh(geo,mat); m.name=name; m.position.set(x,y,z); parent.add(m); return m;
  }
  mesh(new THREE.CylinderGeometry(0.34,0.38,0.07,48),metal,root,'懸浮底座',0,0.035,0);
  mesh(new THREE.CylinderGeometry(0.28,0.31,0.025,48),silver,root,'底座上緣',0,0.0825,0);
  const baseRing = mesh(new THREE.TorusGeometry(0.255,0.009,8,64),blue,root,'磁場光環',0,0.103,0);
  baseRing.rotation.x = Math.PI/2;
  mesh(new THREE.CylinderGeometry(0.20,0.20,0.01,48),metal,root,'磁場中心',0,0.105,0);
  const floating = new THREE.Group(); floating.name='旋轉懸浮方塊'; floating.position.y=0.66; root.add(floating);
  const cube = new THREE.Group(); cube.rotation.set(0.12,0,0.09); floating.add(cube);
  const edgeGeometry = new THREE.BoxGeometry(0.036,0.036,0.56);
  const glowGeometry = new THREE.BoxGeometry(0.009,0.009,0.45);
  for(let axis=0;axis<3;axis++) for(const a of [-1,1]) for(const b of [-1,1]) {
    const edge = mesh(edgeGeometry,metal,cube,'裝甲邊框');
    const stripe = mesh(glowGeometry,blue,cube,'邊框藍光');
    if(axis===0){edge.rotation.y=Math.PI/2;stripe.rotation.y=Math.PI/2;edge.position.set(0,a*0.28,b*0.28);}
    if(axis===1){edge.rotation.x=Math.PI/2;stripe.rotation.x=Math.PI/2;edge.position.set(a*0.28,0,b*0.28);}
    if(axis===2){edge.position.set(a*0.28,b*0.28,0);}
    stripe.position.copy(edge.position).multiplyScalar(1.065);
  }
  const cornerGeo = new THREE.BoxGeometry(0.075,0.075,0.075);
  for(const x of [-1,1]) for(const y of [-1,1]) for(const z of [-1,1]) mesh(cornerGeo,silver,cube,'角落護甲',x*0.28,y*0.28,z*0.28);
  mesh(new THREE.BoxGeometry(0.52,0.52,0.52),glass,cube,'透明能量外殼');
  mesh(new THREE.IcosahedronGeometry(0.125,2),white,cube,'中央能量核心');
  const ringGeo=new THREE.TorusGeometry(0.19,0.012,10,64);
  for(let i=0;i<3;i++){
    const ring=mesh(ringGeo,blue,cube,'核心穩定環');
    if(i===1) ring.rotation.x=Math.PI/2;
    if(i===2) ring.rotation.y=Math.PI/2;
  }
  const faceGeo=new THREE.TorusGeometry(0.145,0.014,10,48);
  const bezelGeo=new THREE.TorusGeometry(0.174,0.019,8,48);
  const vaneGeo=new THREE.BoxGeometry(0.018,0.047,0.014);
  for(let i=0;i<6;i++) {
    const face = new THREE.Group(); face.name='反應爐面板'; cube.add(face);
    if(i===0) face.position.z=0.268;
    if(i===1){face.position.z=-0.268;face.rotation.y=Math.PI;}
    if(i===2){face.position.x=0.268;face.rotation.y=Math.PI/2;}
    if(i===3){face.position.x=-0.268;face.rotation.y=-Math.PI/2;}
    if(i===4){face.position.y=0.268;face.rotation.x=-Math.PI/2;}
    if(i===5){face.position.y=-0.268;face.rotation.x=Math.PI/2;}
    mesh(bezelGeo,metal,face,'反應爐護圈');
    mesh(faceGeo,white,face,'冰藍反應環');
    for(let j=0;j<8;j++) {
      const theta=j*Math.PI/4;
      const vane=mesh(vaneGeo,silver,face,'放射散熱片',Math.sin(theta)*0.2,Math.cos(theta)*0.2,0);
      vane.rotation.z=-theta;
    }
  }
  floating.userData.update=(dt,t)=>{
    floating.position.y=0.66+Math.sin(t*1.1)*0.065;
    floating.rotation.y=t*0.24;
    blue.emissiveIntensity=3.0+Math.sin(t*1.8)*0.35;
    white.emissiveIntensity=3.8+Math.sin(t*1.8)*0.35;
  };
  return root;
}
