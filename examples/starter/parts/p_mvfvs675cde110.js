export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({color:0xd6d5bd,roughness:0.82,metalness:0.12});
  const dark = new THREE.MeshStandardMaterial({color:0x234840,roughness:0.52,metalness:0.5});
  const gold = new THREE.MeshStandardMaterial({color:0x9e8952,roughness:0.55,metalness:0.65});
  const glow = new THREE.MeshStandardMaterial({color:0x52e8bd,emissive:0x15b88a,emissiveIntensity:1.4,roughness:0.35});
  function mesh(g,m,name,x,y,z) {
    const o=new THREE.Mesh(g,m); o.name=name; o.position.set(x,y,z);root.add(o);return o;
  }
  function axial(g,m,name,z) {const o=mesh(g,m,name,0,0.205,z);o.rotation.x=Math.PI/2;return o;}
  mesh(new THREE.BoxGeometry(0.26,0.055,0.40),dark,'黏合底座',0,0.0275,-0.025);
  for(const x of [-0.105,0.105]) mesh(new THREE.BoxGeometry(0.045,0.10,0.32),stone,'底座支架',x,0.075,-0.025);
  axial(new THREE.CylinderGeometry(0.143,0.143,0.40,12),stone,'石製火箭殼',0.015);
  const nose=axial(new THREE.ConeGeometry(0.143,0.20,12),stone,'前向尖錐',0.315);nose.rotation.x=Math.PI/2;
  for(const z of [-0.16,0.18]) {
    axial(new THREE.CylinderGeometry(0.153,0.153,0.045,12),dark,'環形護箍',z);
    axial(new THREE.TorusGeometry(0.154,0.008,6,24),glow,'綠光封印',z).rotation.x=0;
  }
  axial(new THREE.CylinderGeometry(0.093,0.133,0.13,12,1,true),gold,'擴張噴嘴',-0.267);
  axial(new THREE.CylinderGeometry(0.104,0.104,0.012,16),dark,'噴嘴內壁',-0.324);
  axial(new THREE.TorusGeometry(0.128,0.013,6,24),stone,'噴口外緣',-0.332).rotation.x=0;
  axial(new THREE.TorusGeometry(0.071,0.009,6,24),glow,'噴口能量環',-0.333).rotation.x=0;
  for(let i=0;i<6;i++) {
    const a=i*Math.PI/3;
    const stripe=mesh(new THREE.BoxGeometry(0.018,0.009,0.22),glow,'縱向能量刻紋',Math.sin(a)*0.143,0.205+Math.cos(a)*0.143,0.012);
    stripe.rotation.z=-a;
  }
  for(const side of [-1,1]) {
    const shape=new THREE.Shape();shape.moveTo(0,-0.20);shape.lineTo(0,0.07);shape.lineTo(side*0.13,-0.22);shape.lineTo(side*0.13,-0.28);shape.closePath();
    const fin=mesh(new THREE.ExtrudeGeometry(shape,{depth:0.022,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:0.006,bevelThickness:0.004}),stone,'側翼',side*0.12,0.195,0);
    fin.rotation.x=Math.PI/2;
  }
  const flame=new THREE.Group();flame.name='兩秒推進火焰';flame.position.set(0,0.205,-0.34);root.add(flame);flame.visible=false;
  const fireMat=new THREE.MeshStandardMaterial({color:0x45ffd3,emissive:0x1fffc4,emissiveIntensity:3,transparent:true,opacity:0.7,depthWrite:false});
  const coreMat=new THREE.MeshStandardMaterial({color:0xffefad,emissive:0xffd36a,emissiveIntensity:4,transparent:true,opacity:0.9,depthWrite:false});
  for(const [r,len,mat] of [[0.092,0.52,fireMat],[0.052,0.35,coreMat]]) {
    const f=new THREE.Mesh(new THREE.ConeGeometry(r,len,12),mat);f.rotation.x=-Math.PI/2;f.position.z=-len/2;f.userData.noCollide=true;flame.add(f);
  }
  root.userData.onDevice=(s,dt)=>{
    flame.visible=!!s.firing;
    if(s.firing){const pulse=1+0.12*Math.sin(s.t*89)+0.06*Math.sin(s.t*137);flame.scale.set(1,1,pulse);}
    glow.emissiveIntensity=s.firing?3:1.4;
  };
  return root;
}
