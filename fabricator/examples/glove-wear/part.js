export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = '右手鋼鐵手套';
  const red = new THREE.MeshStandardMaterial({color:0x951c28,metalness:0.82,roughness:0.27});
  const gold = new THREE.MeshStandardMaterial({color:0xd5a44b,metalness:0.85,roughness:0.25});
  const steel = new THREE.MeshStandardMaterial({color:0x36414d,metalness:0.85,roughness:0.3});
  const rubber = new THREE.MeshStandardMaterial({color:0x101924,metalness:0.18,roughness:0.68});
  const glow = new THREE.MeshStandardMaterial({color:0xc9faff,emissive:0x61ddff,emissiveIntensity:2.5,roughness:0.22,metalness:0.2});
  const auraMat = new THREE.MeshBasicMaterial({color:0x70eaff,transparent:true,opacity:0.12,depthWrite:false,blending:THREE.AdditiveBlending});
  const boxGeo = new THREE.BoxGeometry(1,1,1);
  const jointGeo = new THREE.SphereGeometry(1,12,8);
  function box(parent,name,x,y,z,sx,sy,sz,mat) {
    const m = new THREE.Mesh(boxGeo,mat);m.name=name;m.position.set(x,y,z);m.scale.set(sx,sy,sz);parent.add(m);return m;
  }
  function ring(parent,name,r,t,x,y,z,mat) {
    const m=new THREE.Mesh(new THREE.TorusGeometry(r,t,8,40),mat);m.name=name;m.position.set(x,y,z);parent.add(m);return m;
  }
  // Open armored cuff, with its axis following the forearm along Z.
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.039,0.043,0.069,32,1,true),red);
  cuff.name='開口裝甲護腕';cuff.rotation.x=Math.PI/2;cuff.position.set(0,0.043,-0.105);root.add(cuff);
  ring(root,'護腕金邊',0.039,0.003,0,0.043,-0.070,gold);
  ring(root,'護腕後緣',0.040,0.003,0,0.043,-0.140,gold);
  box(root,'手掌內襯',0,0.044,-0.012,0.082,0.035,0.106,rubber);
  box(root,'手背主裝甲',0,0.026,-0.014,0.078,0.017,0.096,red);
  box(root,'掌心金屬底板',0,0.064,-0.014,0.069,0.008,0.084,steel);
  for(const side of [-1,1]) {
    box(root,'側面金色護甲',side*0.039,0.046,-0.018,0.009,0.027,0.080,gold);
    box(root,'護腕導光槽',side*0.019,0.079,-0.102,0.006,0.003,0.039,glow);
    for(let i=0;i<3;i++) box(root,'護腕散熱片',side*0.038,0.049,-0.121+i*0.013,0.007,0.019,0.004,steel);
  }
  const reactor = new THREE.Group();reactor.name='掌心反應爐';reactor.position.set(0,0.072,-0.013);reactor.rotation.x=-Math.PI/2;root.add(reactor);
  ring(reactor,'反應爐金框',0.024,0.003,0,0,0,gold);
  ring(reactor,'反應爐內環',0.019,0.0015,0,0,0.002,steel);
  const core=new THREE.Mesh(new THREE.CylinderGeometry(0.017,0.017,0.004,40),glow);core.name='反應爐發光核心';core.rotation.x=Math.PI/2;core.position.z=0.002;reactor.add(core);
  for(let i=0;i<8;i++) {
    const a=i*Math.PI/4;
    const blade=box(reactor,'反應爐固定爪',Math.sin(a)*0.021,Math.cos(a)*0.021,0.004,0.004,0.007,0.003,steel);blade.rotation.z=-a;
  }
  const aura = new THREE.Mesh(new THREE.SphereGeometry(0.029,24,16),auraMat);aura.name='掌心能量光暈';aura.scale.z=0.3;aura.position.z=0.008;reactor.add(aura);
  const joints=[];
  function segment(parent,name,len,width) {
    const pivot=new THREE.Group();pivot.name=name;parent.add(pivot);
    const knuckle=new THREE.Mesh(jointGeo,steel);knuckle.scale.set(width*0.51,0.009,0.009);pivot.add(knuckle);
    box(pivot,'指節內襯',0,0,len*0.5,width*0.85,0.015,len*0.88,rubber);
    box(pivot,'紅色指節裝甲',0,-0.006,len*0.52,width,0.009,len*0.76,red);
    box(pivot,'金色指腹',0,0.008,len*0.5,width*0.80,0.005,len*0.63,gold);
    box(pivot,'指節金邊',0,-0.011,len*0.75,width*0.92,0.002,0.004,gold);
    return pivot;
  }
  const lengths=[[0.035,0.025,0.022],[0.039,0.027,0.023],[0.036,0.025,0.021],[0.028,0.021,0.019]];
  for(let i=0;i<4;i++) {
    let parent=root;
    for(let j=0;j<3;j++) {
      const p=segment(parent,['食指','中指','無名指','小指'][i]+'關節'+j,lengths[i][j],i===3?0.016:0.018);
      if(j===0)p.position.set(0.030-i*0.020,0.046,0.042-(i===3?0.008:0));
      else p.position.z=lengths[i][j-1];
      joints.push({p,angle:j===0?1.25:1.60});parent=p;
    }
  }
  const thumbBase=new THREE.Group();thumbBase.name='右手拇指根部';thumbBase.position.set(0.042,0.046,-0.033);thumbBase.rotation.y=0.8;root.add(thumbBase);
  const thumb1=segment(thumbBase,'拇指近節',0.035,0.023);
  const thumb2=segment(thumb1,'拇指末節',0.029,0.021);thumb2.position.z=0.035;
  let target=0,amount=0,burst=0;
  root.userData.onControl=(s,dt)=>{
    if(s.action){target=target?0:1;burst=1;}
  };
  root.userData.update=(dt,t)=>{
    const delta=Math.min(Math.max(dt,0),0.05);
    amount+=(target-amount)*(1-Math.exp(-delta*12));
    for(const j of joints) j.p.rotation.x=-amount*j.angle;
    thumbBase.rotation.y=0.8-amount*1.1;
    thumbBase.rotation.z=amount*0.35;
    thumb1.rotation.x=-amount*0.65;thumb2.rotation.x=-amount*1.1;
    burst=Math.max(0,burst-delta*1.5);
    glow.emissiveIntensity=2.5+amount*6+burst*10+Math.sin(t*4)*0.3;
    auraMat.opacity=0.10+amount*0.23+burst*0.25;
    const scale=1+amount*0.25+burst*0.45;
    aura.scale.set(scale,scale,0.3*scale);
  };
  return root;
}
