export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({color:0xd5d2b9,roughness:0.85});
  const dark = new THREE.MeshStandardMaterial({color:0x294941,roughness:0.6,metalness:0.25});
  const bronze = new THREE.MeshStandardMaterial({color:0x8b8051,roughness:0.5,metalness:0.55});
  const glow = new THREE.MeshStandardMaterial({color:0x4eeac2,emissive:0x13c69a,emissiveIntensity:0.65,roughness:0.4});
  function mesh(g,m,x,y,z,name,parent=root) {
    const o = new THREE.Mesh(g,m); o.position.set(x,y,z); o.name=name; parent.add(o); return o;
  }
  function ring(r,t,m,y,name,parent=root) {
    const o=mesh(new THREE.TorusGeometry(r,t,8,40),m,0,y,0,name,parent); o.rotation.x=-Math.PI/2; return o;
  }
  mesh(new THREE.CylinderGeometry(0.29,0.32,0.085,12),dark,0,0.0425,0,'黏合底座');
  mesh(new THREE.CylinderGeometry(0.28,0.3,0.07,12),stone,0,0.12,0,'十二角石盤');
  ring(0.255,0.009,glow,0.158,'能量環');
  mesh(new THREE.CylinderGeometry(0.115,0.17,0.095,12),stone,0,0.2,0,'操縱桿承座');
  ring(0.107,0.016,bronze,0.247,'萬向軸環');
  mesh(new THREE.SphereGeometry(0.085,20,12),dark,0,0.26,0,'萬向軸');
  const stick=new THREE.Group(); stick.name='操縱桿活動部'; stick.position.y=0.26; root.add(stick);
  mesh(new THREE.CylinderGeometry(0.035,0.047,0.33,12),stone,0,0.165,0,'石質桿身',stick);
  mesh(new THREE.BoxGeometry(0.012,0.26,0.008),glow,0,0.17,0.039,'桿身符紋',stick);
  ring(0.039,0.009,bronze,0.3,'握把箍',stick);
  const handle=mesh(new THREE.CylinderGeometry(0.044,0.044,0.31,12),dark,0,0.365,0,'橫向握把',stick); handle.rotation.z=Math.PI/2;
  const endGeo=new THREE.SphereGeometry(0.052,12,8);
  for (const side of [-1,1]) {
    mesh(endGeo,stone,side*0.16,0.365,0,'握把端帽',stick);
    for(let j=0;j<3;j++) {
      const band=mesh(new THREE.TorusGeometry(0.045,0.004,6,16),bronze,side*(0.075+j*0.024),0.365,0,'握把刻環',stick); band.rotation.y=Math.PI/2;
    }
  }
  mesh(new THREE.SphereGeometry(0.043,16,10),glow,0,0.385,0.015,'啟動玉石',stick);
  const inlayGeo=new THREE.BoxGeometry(0.021,0.006,0.045);
  for(let i=0;i<8;i++) {
    const a=i*Math.PI/4;
    const mark=mesh(inlayGeo,i%2?bronze:glow,Math.sin(a)*0.207,0.159,Math.cos(a)*0.207,'方位符紋'); mark.rotation.y=a;
  }
  const arrow=new THREE.Shape(); arrow.moveTo(-0.035,0); arrow.lineTo(0,0.055); arrow.lineTo(0.035,0); arrow.closePath();
  const forward=mesh(new THREE.ShapeGeometry(arrow),glow,0,0.161,0.20,'前進方向'); forward.rotation.x=-Math.PI/2;
  root.userData.onDevice=(s)=>{glow.emissiveIntensity=s.on?1.5:0.65;};
  root.userData.onControl=(s,dt)=>{
    const k=Math.min(1,dt*12);
    stick.rotation.z+=(-s.steer*0.22-stick.rotation.z)*k;
    stick.rotation.x+=(s.throttle*0.16-stick.rotation.x)*k;
    glow.emissiveIntensity=1.5+(s.actionHeld?0.8:0);
  };
  return root;
}
