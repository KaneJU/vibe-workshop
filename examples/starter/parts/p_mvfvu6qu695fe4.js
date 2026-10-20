export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({color:0xd5d3b9, roughness:0.75, metalness:0.14});
  const dark = new THREE.MeshStandardMaterial({color:0x254e48, roughness:0.48, metalness:0.65});
  const bronze = new THREE.MeshStandardMaterial({color:0x9b9669, roughness:0.36, metalness:0.75});
  const glow = new THREE.MeshStandardMaterial({color:0x53e6bb, emissive:0x22dba4, emissiveIntensity:1.4, roughness:0.32, metalness:0.3});
  function mesh(geo, mat, x, y, z, parent=root, name='') {
    const m = new THREE.Mesh(geo,mat); m.position.set(x,y,z); m.name=name;
    parent.add(m); return m;
  }
  function plate(y, parent, name) {
    const shape = new THREE.Shape();
    const a=0.32, b=0.245;
    shape.moveTo(-b,-a); shape.lineTo(b,-a); shape.lineTo(a,-b); shape.lineTo(a,b);
    shape.lineTo(b,a); shape.lineTo(-b,a); shape.lineTo(-a,b); shape.lineTo(-a,-b); shape.closePath();
    const geo=new THREE.ExtrudeGeometry(shape,{depth:0.055,bevelEnabled:true,bevelThickness:0.012,bevelSize:0.012,bevelSegments:2,steps:1});
    const m=mesh(geo,stone,0,y,0,parent,name); m.rotation.x=-Math.PI/2;
    return m;
  }
  plate(0.012,root,'底部黏合石座');
  mesh(new THREE.CylinderGeometry(0.25,0.27,0.045,32),dark,0,0.095,0);
  const spring=new THREE.Group(); spring.position.y=0.12; root.add(spring); spring.name='伸縮螺旋';
  const points=[];
  for(let i=0;i<=200;i++) {
    const p=i/200, angle=p*Math.PI*2*4.5;
    points.push(new THREE.Vector3(Math.cos(angle)*0.195,p*0.35,Math.sin(angle)*0.195));
  }
  mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),200,0.024,8,false),bronze,0,0,0,spring,'金屬彈簧');
  mesh(new THREE.CylinderGeometry(0.064,0.064,0.33,16),dark,0,0.165,0,spring,'中央活塞');
  mesh(new THREE.CylinderGeometry(0.038,0.038,0.32,16),glow,0,0.17,0,spring,'能量柱');
  const cap=new THREE.Group(); cap.position.y=0.48; root.add(cap); cap.name='彈射頂板';
  mesh(new THREE.CylinderGeometry(0.255,0.235,0.035,32),dark,0,-0.005,0,cap);
  plate(0.012,cap,'頂部黏合石板');
  mesh(new THREE.CylinderGeometry(0.105,0.105,0.009,6),bronze,0,0.084,0,cap,'中央印記');
  const ring=mesh(new THREE.TorusGeometry(0.169,0.008,6,48),glow,0,0.084,0,cap,'青綠符紋'); ring.rotation.x=Math.PI/2;
  const detailGeo=new THREE.BoxGeometry(0.055,0.009,0.022);
  for(let i=0;i<8;i++) {
    const a=i*Math.PI/4;
    const m=mesh(detailGeo,glow,Math.sin(a)*0.232,0.084,Math.cos(a)*0.232,cap); m.rotation.y=a;
    const bolt=mesh(new THREE.CylinderGeometry(0.022,0.022,0.012,6),bronze,Math.sin(a)*0.281,0.082,Math.cos(a)*0.281);
    bolt.name='石座鉚釘';
  }
  let elapsed=10, wasFiring=false;
  root.userData.onDevice=(s,dt)=>{
    if(s.firing && !wasFiring) elapsed=0;
    wasFiring=!!s.firing;
    elapsed+=dt;
    let stretch=1;
    if(elapsed<0.1) stretch=1-0.65*(elapsed/0.1);
    else if(elapsed<0.25) stretch=0.35+1.15*((elapsed-0.1)/0.15);
    else if(elapsed<0.65) stretch=1+0.5*Math.exp(-9*(elapsed-0.25))*Math.cos((elapsed-0.25)*17);
    spring.scale.y=stretch;
    cap.position.y=0.13+0.35*stretch;
    glow.emissiveIntensity=1.4+(elapsed<0.65?2.4*(1-elapsed/0.65):0);
  };
  return root;
}
