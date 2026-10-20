export default function install(world) {
  const T = world.THREE;
  world.env.background(0x010208);
  world.env.fog(null);
  world.env.ground({ visible: false });
  world.env.grid(false);
  world.env.pad(false);
  world.env.hemi({ sky: 0xadb9d2, ground: 0x38373a, intensity: 0.7 });
  world.env.sun({ color: 0xfff7e9, intensity: 3.1, position: [-70, 35, 25] });
  world.env.exposure(1.05);
  world.env.reflections(0.25);
  const landscape = new T.Group();
  landscape.name = '月壤與環形山';
  world.add(landscape);
  const craters = [];
  for (let i = 0; i < 45; i++) {
    const a = world.random() * Math.PI * 2;
    const d = 37 + world.random() * 100;
    craters.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: 3 + world.random() * 10 });
  }
  const geo = new T.PlaneGeometry(360, 360, 144, 144);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), d = Math.hypot(x, z);
    let h = -0.025;
    const edge = T.MathUtils.smoothstep(d, 29, 45);
    h += edge * (0.8 * Math.sin(x * 0.09) * Math.cos(z * 0.07) + 0.4 * Math.sin(z * 0.2));
    for (const c of craters) {
      const q = Math.hypot(x - c.x, z - c.z) / c.r;
      if (q < 1.5) h += edge * c.r * (-0.24 * Math.exp(-q*q*3) + 0.13 * Math.exp(-Math.pow((q-1)*6, 2)));
    }
    pos.setY(i, h);
    const shade = 0.31 + world.random() * 0.095 + Math.min(0.06, h * 0.012);
    colors.set([shade, shade * 0.98, shade * 0.96], i * 3);
  }
  geo.setAttribute('color', new T.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  landscape.add(new T.Mesh(geo, new T.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));
  const rockGeo = new T.IcosahedronGeometry(1, 0);
  const rocks = new T.InstancedMesh(rockGeo, new T.MeshStandardMaterial({ color: 0x73716e, roughness: 1, flatShading: true }), 180);
  const dummy = new T.Object3D();
  for (let i = 0; i < 180; i++) {
    const a = world.random() * Math.PI * 2, d = 35 + world.random() * 112;
    const s = 0.25 + world.random() * 1.4;
    dummy.position.set(Math.cos(a)*d, s*0.23, Math.sin(a)*d);
    dummy.scale.set(s, s*0.65, s*0.85);
    dummy.rotation.set(world.random(), world.random()*6.28, world.random());
    dummy.updateMatrix(); rocks.setMatrixAt(i, dummy.matrix);
  }
  landscape.add(rocks);
  const starPos = [], starColors = [];
  for (let i = 0; i < 2200; i++) {
    const a = world.random() * Math.PI * 2, y = 0.045 + world.random() * 0.95;
    const r = Math.sqrt(1-y*y), radius = 450;
    starPos.push(Math.cos(a)*r*radius, y*radius, Math.sin(a)*r*radius);
    const c = 0.5 + world.random()*0.5;
    starColors.push(c*0.9, c*0.95, c);
  }
  const starsGeo = new T.BufferGeometry();
  starsGeo.setAttribute('position', new T.Float32BufferAttribute(starPos, 3));
  starsGeo.setAttribute('color', new T.Float32BufferAttribute(starColors, 3));
  const stars = new T.Points(starsGeo, new T.PointsMaterial({ size: 0.65, vertexColors: true, sizeAttenuation: true, fog: false }));
  stars.name = '滿天星辰'; world.add(stars);
  const earth = new T.Group(); earth.name = '蔚藍地球'; earth.position.set( -38, 65, -115 );
  const earthGeo = new T.SphereGeometry(14, 96, 64);
  const ep = earthGeo.attributes.position, ec = new Float32Array(ep.count*3);
  // Longitude/latitude outlines make the continents recognizable without textures.
  const continents = [
    [[-168,70],[-130,72],[-105,58],[-80,52],[-58,48],[-80,25],[-98,17],[-116,30],[-130,50]],
    [[-81,12],[-60,10],[-35,-6],[-43,-25],[-70,-56],[-77,-25]],
    [[-18,35],[10,38],[34,30],[50,10],[40,-15],[19,-35],[10,-28],[-2,5],[-17,15]],
    [[-10,36],[-8,58],[20,71],[60,70],[105,76],[175,60],[145,40],[120,18],[105,5],[80,9],[69,25],[40,32],[28,42]],
    [[112,-12],[137,-10],[154,-25],[145,-39],[116,-34]],
    [[-53,60],[-23,74],[-40,83],[-62,80]]
  ];
  function inside(x,y,poly) {
    let result = false;
    for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
      const a=poly[i], b=poly[j];
      if ((a[1]>y)!==(b[1]>y) && x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) result=!result;
    }
    return result;
  }
  const col = new T.Color();
  for (let i=0;i<ep.count;i++) {
    const x=ep.getX(i), y=ep.getY(i), z=ep.getZ(i);
    const lat=Math.asin(y/14)*180/Math.PI, lon=Math.atan2(x,z)*180/Math.PI;
    const land=continents.some(p=>inside(lon,lat,p));
    col.set(land ? (Math.abs(lat)<28 ? 0x7f9863 : 0x497b61) : 0x0956ad);
    const clouds = Math.sin(lon*0.18 + Math.sin(lat*0.12)*3) + Math.cos(lat*0.32-lon*0.08);
    if (clouds>1.25) col.lerp(new T.Color(0xf5faff), Math.min(0.9,(clouds-1.25)*1.5));
    if (lat < -70 || lat > 77) col.set(0xe5f5ff);
    ec.set([col.r,col.g,col.b],i*3);
  }
  earthGeo.setAttribute('color',new T.BufferAttribute(ec,3));
  earth.add(new T.Mesh(earthGeo,new T.MeshStandardMaterial({ vertexColors:true, roughness:0.85, emissive:0x184578, emissiveIntensity:0.23 })));
  earth.rotation.z=0.18;
  const atmosphere=new T.Mesh(new T.SphereGeometry(14.28,64,40),new T.MeshBasicMaterial({color:0x559dff, transparent:true, opacity:0.12, side:T.BackSide, depthWrite:false}));
  earth.add(atmosphere); world.add(earth);
  return { update(dt) { earth.rotation.y += dt*0.008; } };
}
