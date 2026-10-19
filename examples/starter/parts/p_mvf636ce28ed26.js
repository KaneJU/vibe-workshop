export default function build(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = '轉頭小機器人';
  const shell = new THREE.MeshStandardMaterial({ color: 0xd92d38, metalness: 0.35, roughness: 0.3 });
  const teal = new THREE.MeshStandardMaterial({ color: 0x991b28, metalness: 0.55, roughness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x182733, metalness: 0.65, roughness: 0.36 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x91faff, emissive: 0x34d9ff, emissiveIntensity: 1.8, roughness: 0.24 });
  const eyeGlow = new THREE.MeshStandardMaterial({ color: 0x79ff8a, emissive: 0x19ed45, emissiveIntensity: 1.8, roughness: 0.24 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xffb350, metalness: 0.3, roughness: 0.35 });
  function mesh(parent, name, geo, mat, x, y, z) {
    const m = new THREE.Mesh(geo, mat);
    m.name = name; m.position.set(x, y, z); parent.add(m); return m;
  }
  function rounded(parent, name, w, h, d, radius, mat, x, y, z) {
    const s = new THREE.Shape();
    const a = -w / 2, b = -h / 2, r = radius;
    s.moveTo(a+r,b); s.lineTo(a+w-r,b); s.quadraticCurveTo(a+w,b,a+w,b+r);
    s.lineTo(a+w,b+h-r); s.quadraticCurveTo(a+w,b+h,a+w-r,b+h);
    s.lineTo(a+r,b+h); s.quadraticCurveTo(a,b+h,a,b+h-r);
    s.lineTo(a,b+r); s.quadraticCurveTo(a,b,a+r,b);
    const g = new THREE.ExtrudeGeometry(s, { depth: d-0.02, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.01, bevelThickness: 0.01, curveSegments: 6 });
    g.translate(0,0,-(d-0.02)/2);
    return mesh(parent,name,g,mat,x,y,z);
  }
  const jointGeo = new THREE.SphereGeometry(0.055,16,12);
  for (const side of [-1,1]) {
    const x = side * 0.115;
    rounded(root, '腳掌', 0.18,0.09,0.25,0.025,dark,x,0.055,0);
    rounded(root, '腳背護甲', 0.16,0.07,0.20,0.025,shell,x,0.095,0.015);
    mesh(root,'小腿',new THREE.CylinderGeometry(0.043,0.043,0.15,16),teal,x,0.195,-0.025);
    mesh(root,'膝部關節',jointGeo,dark,x,0.285,-0.025);
    const shoulder = mesh(root,'肩部關節',jointGeo,dark,side*0.245,0.49,0);
    const arm = rounded(root,'手臂護甲',0.105,0.19,0.12,0.035,teal,side*0.29,0.405,0);
    arm.rotation.z = side*0.16;
    mesh(root,'圓形手掌',new THREE.SphereGeometry(0.065,18,12),shell,side*0.306,0.285,0);
  }
  rounded(root,'身體外殼',0.39,0.29,0.24,0.055,shell,0,0.445,0);
  rounded(root,'胸口面板',0.24,0.17,0.025,0.025,teal,0,0.45,0.14);
  mesh(root,'能量核心外環',new THREE.CylinderGeometry(0.049,0.049,0.018,24),dark,0,0.47,0.164).rotation.x = Math.PI/2;
  mesh(root,'發光核心',new THREE.SphereGeometry(0.032,16,12),glow,0,0.47,0.175).scale.z = 0.35;
  for(let i=0;i<3;i++) rounded(root,'散熱格柵',0.027,0.011,0.01,0.004,dark,(i-1)*0.045,0.395,0.16);
  mesh(root,'頸部旋轉軸',new THREE.CylinderGeometry(0.063,0.063,0.085,24),dark,0,0.625,0);
  const head = new THREE.Group(); head.name = '追蹤頭部'; head.position.y = 0.755; root.add(head);
  rounded(head,'圓角頭殼',0.43,0.25,0.30,0.065,shell,0,0,0);
  rounded(head,'深色面罩',0.355,0.15,0.026,0.04,dark,0,0,0.16);
  for(const side of [-1,1]) {
    rounded(head,'發光眼睛',0.055,0.063,0.012,0.022,eyeGlow,side*0.087,0.012,0.183);
    const ear = mesh(head,'側邊感測器',new THREE.CylinderGeometry(0.057,0.057,0.027,24),teal,side*0.232,0,0); ear.rotation.z = Math.PI/2;
  }
  rounded(head,'微笑燈條',0.055,0.009,0.01,0.004,glow,0,-0.042,0.183);
  mesh(head,'天線',new THREE.CylinderGeometry(0.009,0.009,0.085,12),dark,0.12,0.172,0);
  mesh(head,'天線訊號球',new THREE.SphereGeometry(0.026,16,12),orange,0.12,0.225,0);
  const tmp = new THREE.Vector3();
  head.userData.update = () => {
    head.getWorldPosition(tmp);
    const p = ctx.player.position;
    if ((p.x-tmp.x)**2 + (p.z-tmp.z)**2 > 0.000001) head.lookAt(p.x,tmp.y,p.z);
  };
  return root;
}
