export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({color:0xd7d1b5, roughness:0.8});
  const cloth = new THREE.MeshStandardMaterial({color:0xe5dcc0, roughness:0.95});
  const dark = new THREE.MeshStandardMaterial({color:0x254e49, roughness:0.65, metalness:0.25});
  const gold = new THREE.MeshStandardMaterial({color:0x8c8154, roughness:0.6, metalness:0.45});
  const glow = new THREE.MeshStandardMaterial({color:0x49e5bb, emissive:0x1bdba3, emissiveIntensity:1.4, roughness:0.35});
  function mesh(geometry, material, name, x=0,y=0,z=0) {
    const m = new THREE.Mesh(geometry,material); m.name=name; m.position.set(x,y,z); root.add(m); return m;
  }
  function ring(radius,tube,y,material,name) {
    const m=mesh(new THREE.TorusGeometry(radius,tube,8,40),material,name,0,y,0); m.rotation.x=Math.PI/2; return m;
  }
  mesh(new THREE.CylinderGeometry(0.14,0.17,0.06,12),stone,'底部黏合座',0,0.03);
  mesh(new THREE.CylinderGeometry(0.10,0.12,0.075,12),dark,'承載籃',0,0.0975);
  ring(0.12,0.012,0.13,gold,'籃口');
  ring(0.15,0.009,0.05,glow,'黏合座能量環');
  const core=mesh(new THREE.SphereGeometry(0.044,16,12),glow,'浮升核心',0,0.16);
  core.scale.y=1.5; core.userData.noCollide=true;
  const profile=[new THREE.Vector2(0.062,0.24),new THREE.Vector2(0.10,0.28),new THREE.Vector2(0.19,0.35),new THREE.Vector2(0.265,0.46),new THREE.Vector2(0.285,0.56),new THREE.Vector2(0.265,0.65),new THREE.Vector2(0.20,0.73),new THREE.Vector2(0.105,0.78),new THREE.Vector2(0,0.80)];
  mesh(new THREE.LatheGeometry(profile,40),cloth,'氣球囊');
  ring(0.066,0.014,0.246,dark,'氣囊頸圈');
  ring(0.286,0.009,0.56,dark,'赤道束帶');
  for(let i=0;i<8;i++) {
    const a=i*Math.PI/4;
    const points=profile.slice(0,-1).map(p=>new THREE.Vector3((p.x+0.003)*Math.cos(a),p.y,(p.x+0.003)*Math.sin(a)));
    points.push(new THREE.Vector3(0,0.803,0));
    mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),32,0.004,5,false),gold,'縱向囊筋');
    if(i%2===0) {
      const start=new THREE.Vector3(0.105*Math.cos(a),0.13,0.105*Math.sin(a));
      const end=new THREE.Vector3(0.16*Math.cos(a),0.325,0.16*Math.sin(a));
      mesh(new THREE.TubeGeometry(new THREE.LineCurve3(start,end),1,0.009,6,false),dark,'吊掛支索');
    }
    const rune=mesh(new THREE.BoxGeometry(0.027,0.047,0.009),glow,'青綠符紋',0.28*Math.sin(a),0.61,0.28*Math.cos(a));
    rune.rotation.y=a; rune.rotation.z=Math.PI/4;
  }
  mesh(new THREE.SphereGeometry(0.022,12,8),gold,'頂部封扣',0,0.80).scale.y=0.35;
  root.userData.onDevice=(s,dt)=>{glow.emissiveIntensity=1.25+0.25*Math.sin(s.t*3);};
  return root;
}
