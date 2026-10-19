export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  const metal = (color, roughness=0.32, metalness=0.8) => new THREE.MeshStandardMaterial({color, roughness, metalness});
  const red = metal(0x8c1422), gold = metal(0xd6a34a), dark = metal(0x18232d), steel = metal(0x40515d);
  const cyan = new THREE.MeshStandardMaterial({color:0x74efff, emissive:0x12bfff, emissiveIntensity:2.5, roughness:0.25, metalness:0.2});
  const holo = new THREE.MeshStandardMaterial({color:0x29d9ff, emissive:0x08b6ff, emissiveIntensity:1.3, transparent:true, opacity:0.22, depthWrite:false, side:THREE.DoubleSide});
  function mesh(g,m,x,y,z,name,parent=root) { const o=new THREE.Mesh(g,m); o.position.set(x,y,z); o.name=name; parent.add(o); return o; }
  function box(w,h,d,m,x,y,z,name,parent=root) {return mesh(new THREE.BoxGeometry(w,h,d),m,x,y,z,name,parent);}
  function cyl(r,h,m,x,y,z,name,parent=root) {return mesh(new THREE.CylinderGeometry(r,r,h,64),m,x,y,z,name,parent);}
  function ring(r,t,m,x,y,z,name,parent=root) {const o=mesh(new THREE.TorusGeometry(r,t,8,80),m,x,y,z,name,parent); o.rotation.x=Math.PI/2; return o;}
  function plate(w,d,h,m,y,name) {
    const s=new THREE.Shape(), c=0.10;
    s.moveTo(-w/2+c,-d/2); s.lineTo(w/2-c,-d/2); s.lineTo(w/2,-d/2+c); s.lineTo(w/2,d/2-c); s.lineTo(w/2-c,d/2); s.lineTo(-w/2+c,d/2); s.lineTo(-w/2,d/2-c); s.lineTo(-w/2,-d/2+c); s.closePath();
    const g=new THREE.ExtrudeGeometry(s,{depth:h,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:0.012,bevelThickness:0.012});
    const o=mesh(g,m,0,y,0,name); o.rotation.x=-Math.PI/2; return o;
  }
  // Paired armored pedestals leave room for the operator's knees.
  for(const x of [-0.76,0.76]) {
    box(0.43,0.07,0.78,dark,x,0.035,0,'防滑底腳');
    box(0.33,0.73,0.57,dark,x,0.435,-0.035,'承重骨架');
    box(0.37,0.59,0.06,red,x,0.44,0.28,'紅色裝甲');
    box(0.045,0.57,0.065,gold,x+(x<0?-0.14:0.14),0.44,0.32,'金色裝甲邊');
    box(0.22,0.04,0.075,gold,x,0.72,0.31,'肩甲飾條');
    for(let i=0;i<4;i++) box(0.20,0.022,0.016,steel,x,0.25+i*0.065,0.317,'散熱格柵');
    box(0.12,0.012,0.018,cyan,x,0.61,0.319,'電源狀態燈');
    for(const z of [-0.2,0.19]) {const bolt=cyl(0.023,0.012,gold,x,0.18,z,'裝甲鉚釘'); bolt.rotation.z=Math.PI/2; bolt.position.x=x+(x<0?-0.173:0.173);}
  }
  box(1.35,0.15,0.15,steel,0,0.35,-0.24,'後側橫樑');
  plate(2.1,1.04,0.105,red,0.82,'裝甲桌緣');
  plate(2.03,0.98,0.023,gold,0.931,'金屬桌邊');
  plate(1.98,0.93,0.025,dark,0.962,'工作檯面');
  box(1.32,0.022,0.012,cyan,0,0.877,0.525,'前緣光帶');
  // Arc-reactor medallion on the front fascia.
  const reactor=cyl(0.09,0.026,gold,0,0.868,0.54,'反應爐金框'); reactor.rotation.x=Math.PI/2;
  const core=cyl(0.063,0.03,cyan,0,0.868,0.558,'反應爐核心'); core.rotation.x=Math.PI/2;
  const dz=-0.035;
  cyl(0.375,0.032,steel,0,1.011,dz,'全息投影底座');
  cyl(0.33,0.017,dark,0,1.034,dz,'投影盤面');
  ring(0.344,0.008,gold,0,1.037,dz,'投影金環');
  ring(0.303,0.007,cyan,0,1.047,dz,'投影光環');
  cyl(0.265,0.006,holo,0,1.049,dz,'發光玻璃盤');
  for(let i=0;i<12;i++) {const a=i*Math.PI/6; const o=box(0.015,0.009,0.04,cyan,Math.sin(a)*0.278,1.05,dz+Math.cos(a)*0.278,'光學發射器'); o.rotation.y=a;}
  const projection=new THREE.Group(); projection.name='懸浮全息圓盤'; projection.position.set(0,1.31,dz); root.add(projection);
  cyl(0.285,0.003,holo,0,0,0,'全息圓面',projection);
  ring(0.29,0.004,cyan,0,0,0,'全息外圈',projection);
  ring(0.21,0.003,cyan,0,0.001,0,'全息內圈',projection);
  for(let i=0;i<24;i++) {const a=i*Math.PI/12;const o=box(0.006,0.003,i%3===0?0.035:0.016,cyan,Math.sin(a)*0.26,0.004,Math.cos(a)*0.26,'刻度',projection);o.rotation.y=a;}
  box(0.36,0.003,0.003,cyan,0,0.006,0,'瞄準橫線',projection);
  box(0.003,0.003,0.36,cyan,0,0.006,0,'瞄準縱線',projection);
  const gem=mesh(new THREE.IcosahedronGeometry(0.085,0),new THREE.MeshStandardMaterial({color:0x8ef6ff,emissive:0x00bfff,emissiveIntensity:1.7,wireframe:true}),0,0.10,0,'全息能量模型',projection);
  mesh(new THREE.CylinderGeometry(0.285,0.15,0.25,48,1,true),new THREE.MeshStandardMaterial({color:0x18ccff,emissive:0x06bfff,emissiveIntensity:0.8,transparent:true,opacity:0.055,depthWrite:false,side:THREE.DoubleSide}),0,1.18,dz,'投射光束');
  // Inlaid controls and a service panel.
  box(0.34,0.012,0.28,steel,-0.69,1.006,0.10,'控制面板');
  box(0.27,0.005,0.095,holo,-0.69,1.016,0.02,'藍色狀態螢幕');
  for(let i=0;i<3;i++) for(let j=0;j<2;j++) box(0.062,0.008,0.027,j===0?cyan:gold,-0.775+i*0.085,1.018,0.12+j*0.05,'控制鍵');
  box(0.29,0.008,0.49,steel,0.7,1.004,0,'工具維修面板');
  for(let i=0;i<7;i++) box(0.22,0.005,0.009,dark,0.7,1.011,-0.17+i*0.05,'維修槽');
  root.userData.update=(dt,t)=>{projection.position.y=1.31+Math.sin(t*1.5)*0.014;projection.rotation.y=t*0.17;gem.rotation.y=t*0.7;gem.rotation.z=t*0.25;};
  return root;
}
