export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = '氮氣卡丁車';
  const mat = (color, metalness = 0, roughness = 0.45, extra = {}) => new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
  const red = mat(0xef3928, 0.45, 0.27), dark = mat(0x18222d, 0.65, 0.35);
  const rubber = mat(0x15171b, 0, 0.85), silver = mat(0xbac9d5, 0.8, 0.23);
  const seatMat = mat(0x252b32, 0, 0.9), blue = mat(0x008ecb, 0.65, 0.25);
  const stripe = mat(0xffe9b0, 0.2, 0.35);
  function mesh(g, m, x, y, z, name, parent = root) {
    const obj = new THREE.Mesh(g, m); obj.position.set(x, y, z); obj.name = name;
    obj.castShadow = true; obj.receiveShadow = true; parent.add(obj); return obj;
  }
  function box(w,h,d,m,x,y,z,name,parent) { return mesh(new THREE.BoxGeometry(w,h,d),m,x,y,z,name,parent); }
  function rod(a,b,r,m,name) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const o = mesh(new THREE.CylinderGeometry(r,r,start.distanceTo(end),12),m,0,0,0,name);
    o.position.copy(start).add(end).multiplyScalar(0.5); o.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),end.sub(start).normalize()); return o;
  }
  box(0.88,0.09,1.56,dark,0,0.22,0,'底盤');
  for (const x of [-0.43,0.43]) {
    rod([x,0.29,-0.81],[x,0.29,0.81],0.035,silver,'車架');
    box(0.25,0.22,0.77,red,x*1.15,0.37,-0.02,'側箱');
    box(0.258,0.025,0.62,stripe,x*1.15,0.487,-0.02,'側箱條紋');
  }
  box(1.16,0.09,0.12,dark,0,0.25,0.92,'前防撞桿');
  box(1.04,0.09,0.12,dark,0,0.26,-0.9,'後防撞桿');
  const nose = box(0.63,0.17,0.46,red,0,0.36,0.65,'前鼻翼'); nose.rotation.x = -0.12;
  box(0.1,0.012,0.43,stripe,0,0.478,0.65,'中線');
  box(0.43,0.12,0.48,seatMat,0,0.36,-0.22,'座墊');
  const back = box(0.44,0.48,0.095,seatMat,0,0.59,-0.48,'座椅靠背'); back.rotation.x = -0.16;
  for(const x of [-0.22,0.22]) box(0.07,0.2,0.44,seatMat,x,0.46,-0.24,'座椅側翼');
  for(const x of [-0.12,0.12]) box(0.04,0.34,0.018,red,x,0.61,-0.419,'安全帶');
  rod([0,0.27,0.47],[0,0.66,0.2],0.025,silver,'方向機柱');
  const steering = new THREE.Group(); steering.position.set(0,0.67,0.19); steering.rotation.x = -0.6; root.add(steering);
  mesh(new THREE.TorusGeometry(0.145,0.018,8,32),rubber,0,0,0,'方向盤',steering);
  box(0.26,0.022,0.02,silver,0,0,0,'方向盤橫輻',steering);
  box(0.023,0.14,0.02,silver,0,-0.06,0,'方向盤下輻',steering);
  mesh(new THREE.SphereGeometry(0.034,12,8),red,0,0,0.012,'方向盤中心',steering);
  for(const x of [-0.14,0.14]) { const p = box(0.09,0.025,0.16,silver,x,0.31,0.4,'踏板'); p.rotation.x = -0.3; }
  const wheels = [], pivots = [];
  const tireGeo = new THREE.CylinderGeometry(0.205,0.205,0.19,32);
  const rimGeo = new THREE.CylinderGeometry(0.123,0.123,0.195,24);
  for (const [key,x,z] of [['fl',-0.64,0.59],['fr',0.64,0.59],['rl',-0.64,-0.57],['rr',0.64,-0.57]]) {
    const pivot = new THREE.Group(); pivot.position.set(x,0.205,z); root.add(pivot);
    const wheel = new THREE.Group(); wheel.name = 'wheel_'+key; pivot.add(wheel); wheels.push(wheel);
    if(key[0]==='f') pivots.push(pivot);
    const tire = mesh(tireGeo,rubber,0,0,0,'輪胎',wheel); tire.rotation.z = Math.PI/2;
    const rim = mesh(rimGeo,dark,0,0,0,'輪圈',wheel); rim.rotation.z = Math.PI/2;
    for(const side of [-1,1]) {
      const hub = mesh(new THREE.CylinderGeometry(0.035,0.035,0.012,12),red,side*0.104,0,0,'輪轂',wheel); hub.rotation.z = Math.PI/2;
      for(let j=0;j<5;j++) {
        const a = j*Math.PI*2/5;
        const spoke = box(0.013,0.095,0.018,silver,side*0.104,Math.cos(a)*0.065,Math.sin(a)*0.065,'輪輻',wheel); spoke.rotation.x = a;
      }
    }
    rod([0,0.205,z],[x,0.205,z],0.025,dark,'車軸');
  }
  box(0.37,0.24,0.27,dark,0,0.42,-0.72,'引擎');
  for(let i=0;i<6;i++) box(0.39,0.015,0.023,silver,0,0.551,-0.82+i*0.035,'散熱鰭片');
  const brakeMat = mat(0x5e0808,0.2,0.25,{emissive:0xff1808,emissiveIntensity:0.1});
  for(const x of [-0.42,0.42]) box(0.17,0.075,0.03,brakeMat,x,0.37,-0.888,'煞車燈');
  const flameMat = mat(0x00bfff,0,0.25,{emissive:0x008cff,emissiveIntensity:3,transparent:true,opacity:0.72,depthWrite:false});
  const coreMat = mat(0xc9ffff,0,0.2,{emissive:0x62eaff,emissiveIntensity:4});
  const flames = [];
  for(const x of [-0.32,0.32]) {
    const tank = mesh(new THREE.CapsuleGeometry(0.07,0.25,5,16),blue,x,0.58,-0.64,'氮氣瓶'); tank.rotation.x = Math.PI/2;
    for(const z of [-0.73,-0.55]) {const band=mesh(new THREE.TorusGeometry(0.073,0.012,6,16),silver,x,0.58,z,'瓶箍');}
    const exhaust = mesh(new THREE.CylinderGeometry(0.075,0.06,0.16,20),silver,x,0.33,-0.86,'噴嘴'); exhaust.rotation.x = Math.PI/2;
    const hole = mesh(new THREE.CylinderGeometry(0.057,0.057,0.012,20),dark,x,0.33,-0.946,'噴嘴內壁'); hole.rotation.x = Math.PI/2;
    const plume = new THREE.Group(); plume.position.set(x,0.33,-0.96); root.add(plume); plume.visible = false; plume.name = '氮氣火焰'; flames.push(plume);
    const outer = mesh(new THREE.ConeGeometry(0.067,0.57,14),flameMat,0,0,-0.285,'藍焰',plume); outer.rotation.x = -Math.PI/2;
    const inner = mesh(new THREE.ConeGeometry(0.035,0.36,12),coreMat,0,0,-0.18,'火焰核心',plume); inner.rotation.x = -Math.PI/2;
  }
  let burst = 0, time = 0;
  root.userData.onControl = (s,dt) => {
    for(const w of wheels) w.rotation.x += s.speed*dt/0.205;
    for(const p of pivots) p.rotation.y = -s.steer*0.45;
    steering.rotation.z = -s.steer*0.65;
    brakeMat.emissiveIntensity = s.speed < -0.02 || s.throttle < 0 ? 2.8 : 0.1;
    if(s.action || s.actionHeld) burst = 0.65;
  };
  root.userData.update = (dt,t) => {
    time = t; burst = Math.max(0,burst-dt);
    for(let i=0;i<flames.length;i++) {
      flames[i].visible = burst > 0;
      flames[i].scale.set(1,1,(0.8+0.2*Math.sin(time*48+i*2))*Math.min(1,burst*6));
    }
  };
  return root;
}
