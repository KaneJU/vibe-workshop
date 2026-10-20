export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({color:0xcac7ac, roughness:0.78, metalness:0.14});
  const dark = new THREE.MeshStandardMaterial({color:0x263e38, roughness:0.6, metalness:0.4});
  const bladeMat = new THREE.MeshStandardMaterial({color:0x6b8873, roughness:0.48, metalness:0.42});
  const brass = new THREE.MeshStandardMaterial({color:0x9c8954, roughness:0.48, metalness:0.65});
  const glow = new THREE.MeshStandardMaterial({color:0x36cbb1, emissive:0x13d5a9, emissiveIntensity:0.28, roughness:0.35});
  function mesh(geo, mat, name, x=0,y=0,z=0,parent=root) {
    const m = new THREE.Mesh(geo,mat); m.name=name; m.position.set(x,y,z); parent.add(m); return m;
  }
  const cy=0.39;
  mesh(new THREE.BoxGeometry(0.36,0.07,0.34),dark,'平底黏合座',0,0.035,0);
  mesh(new THREE.BoxGeometry(0.26,0.09,0.25),stone,'底座',0,0.10,0);
  mesh(new THREE.TorusGeometry(0.29,0.057,12,48),stone,'石質風罩',0,cy,0);
  for (const z of [-0.065,0.065]) {
    mesh(new THREE.TorusGeometry(0.293,0.018,8,48),brass,'風罩邊框',0,cy,z);
    mesh(new THREE.TorusGeometry(0.265,0.009,6,48),glow,'青綠環紋',0,cy,z);
  }
  const rotor = new THREE.Group(); rotor.name='旋轉葉片'; rotor.position.y=cy; root.add(rotor);
  const shape = new THREE.Shape();
  shape.moveTo(0.045,-0.025); shape.quadraticCurveTo(0.14,-0.09,0.242,-0.042);
  shape.quadraticCurveTo(0.258,0.015,0.223,0.066);
  shape.quadraticCurveTo(0.13,0.034,0.052,0.028); shape.closePath();
  const bladeGeo=new THREE.ExtrudeGeometry(shape,{depth:0.014,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:0.004,bevelThickness:0.004,curveSegments:10});
  for(let i=0;i<5;i++) {
    const blade=mesh(bladeGeo,bladeMat,'葉片_'+i,0,0,-0.007,rotor); blade.rotation.z=i*Math.PI*2/5;
  }
  const hub=mesh(new THREE.CylinderGeometry(0.066,0.066,0.13,24),brass,'軸心',0,0,0,rotor); hub.rotation.x=Math.PI/2;
  for(const z of [-0.084,0.084]) {
    const cap=mesh(new THREE.SphereGeometry(0.049,16,10),glow,'能量軸蓋',0,cy,z); cap.scale.z=0.4;
    for(let i=0;i<3;i++) {
      const a=i*Math.PI*2/3+Math.PI/2;
      const brace=mesh(new THREE.BoxGeometry(0.027,0.23,0.025),dark,'軸心支架',Math.cos(a)*0.165,cy+Math.sin(a)*0.165,z);
      brace.rotation.z=a-Math.PI/2;
    }
  }
  for(let i=0;i<8;i++) {
    const a=i*Math.PI/4;
    const tab=mesh(new THREE.BoxGeometry(0.055,0.031,0.13),stone,'風罩刻節',Math.sin(a)*0.314,cy+Math.cos(a)*0.314,0);
    tab.rotation.z=-a;
    const rune=mesh(new THREE.BoxGeometry(0.016,0.035,0.008),glow,'發光刻紋',Math.sin(a)*0.302,cy+Math.cos(a)*0.302,0.083);
    rune.rotation.z=-a;
  }
  // The device engine supplies thrust along +Z; exhaust exits the rear (-Z).
  root.userData.onDevice=(s,dt)=>{
    const power=s.on ? Math.max(0,Math.min(1,s.power ?? 1)) : 0;
    rotor.rotation.z=(rotor.rotation.z+dt*power*32)%(Math.PI*2);
    glow.emissiveIntensity=0.28+power*1.8;
  };
  return root;
}
