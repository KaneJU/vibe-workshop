// 操作引擎：開車、飛行、穿戴，以及駕駛黏起來的裝置（物理引擎負責推動，這裡只管輸入與追焦鏡頭）。
// 輸入（手機搖桿／按鈕、電腦鍵盤）統一寫進 engine.input，每一格 update() 依模式推動物件與鏡頭。
// 零件可以在 root.userData.onControl(s, dt) 自己做細節（輪子轉、握拳、噴火）；沒有的話引擎用通用效果。

export const MODES = { drive: '開車', fly: '飛行', wear: '穿戴', pilot: '駕駛' };

const FLY_WORDS = /飛天|飛行|飛機|飛碟|飛船|會飛|能飛|可以飛|起飛|太空船|火箭|無人機|\b(ufo|plane|airplane|jet|drone|flying|hover\w*|spaceship|rocket)\b/i;
const DRIVE_WORDS = /車|卡丁|坦克|機車|摩托|巴士|特斯拉|\b(car|cars|truck|kart|go-kart|tank|bike|motorbike|bus|vehicle|tesla|buggy|jeep)\b/i;
const WEAR_WORDS = /手套|帽|頭盔|面具|劍|錘|盾|戒指|手環|魔杖|槍|鎧甲|盔甲|\b(glove|gauntlet|hat|helmet|mask|sword|hammer|shield|wand|gun|armou?r)\b/i;
const SNAP_WORDS = /無限手套|infinity gauntlet/i;

// 零件有宣告（meta.controls）就照宣告；舊零件用名字和描述猜
export function guessMode(part) {
  if (!part) return null;
  if (MODES[part.controls]) return part.controls;
  const text = `${part.name || ''} ${part.description || ''} ${part.prompt || ''}`;
  if (FLY_WORDS.test(text)) return 'fly';
  if (DRIVE_WORDS.test(text)) return 'drive';
  if (WEAR_WORDS.test(text)) return 'wear';
  return null;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function createControlEngine({ THREE, scene, camera, controls, world, worldBox, dropToSupport, toast, instancesList, pilot }) {
  const input = { x: 0, y: 0, lift: 0, actionHeld: false, actionPressed: false };
  const effects = [];
  const UP = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();
  const spinQ = new THREE.Quaternion();
  let s = null; // 目前這一次操作

  // 手感參數：預設值＋各規則模組的覆寫（模組拔掉時覆寫跟著消失，自動回到原本手感）
  const DEFAULT_TUNING = {
    maxForward: 10,
    maxReverse: 4,
    accel: 7,
    brake: 14,
    turnRate: 1.8,
    drag: 1.4,
    grip: 1,
    flyMaxForward: 14,
    flyMaxReverse: 6,
    liftSpeed: 3.2,
    walkSpeed: 2.4,
  };
  const TUNING_RANGE = {
    maxForward: [1, 60],
    maxReverse: [0.5, 20],
    accel: [0.5, 60],
    brake: [1, 80],
    turnRate: [0.2, 6],
    drag: [0, 10],
    grip: [0.02, 1],
    flyMaxForward: [1, 80],
    flyMaxReverse: [0.5, 30],
    liftSpeed: [0.2, 20],
    walkSpeed: [0.3, 12],
  };
  const overrides = new Map(); // 模組 id -> 覆寫
  const hooks = new Map(); // 模組 id -> [每格鉤子]
  let tuning = { ...DEFAULT_TUNING };
  function recomputeTuning() {
    tuning = { ...DEFAULT_TUNING };
    for (const o of overrides.values()) Object.assign(tuning, o);
  }
  const vehicleApi = {
    tune(id, partial) {
      const clean = {};
      for (const [k, v] of Object.entries(partial || {})) {
        if (TUNING_RANGE[k] && Number.isFinite(v)) clean[k] = clamp(v, ...TUNING_RANGE[k]);
      }
      overrides.set(id, { ...(overrides.get(id) || {}), ...clean });
      recomputeTuning();
    },
    onUpdate(id, fn) {
      if (!hooks.has(id)) hooks.set(id, []);
      hooks.get(id).push(fn);
    },
    clear(id) {
      overrides.delete(id);
      hooks.delete(id);
      recomputeTuning();
    },
    get tuning() {
      return { ...tuning };
    },
  };
  const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

  function resetInput() {
    Object.assign(input, { x: 0, y: 0, lift: 0, actionHeld: false, actionPressed: false });
  }

  // 沒有 onControl 的舊零件：找名字像輪子的節點，沿車身 X 軸（輪軸）滾動
  function findWheels(root) {
    const wheels = [];
    root.updateMatrixWorld(true);
    const rootInv = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    root.traverse((o) => {
      if (o === root || wheels.length >= 12) return;
      const n = String(o.name || '');
      if (!/wheel|tire|tyre|輪|胎/i.test(n) || /steer|方向盤|arch|拱|well|cover|蓋|眉|hub ?cap/i.test(n)) return;
      for (let p = o.parent; p && p !== root; p = p.parent) if (wheels.some((w) => w.obj === p)) return;
      const box = new THREE.Box3().setFromObject(o);
      if (box.isEmpty()) return;
      const sz = box.getSize(new THREE.Vector3());
      const rel = rootInv.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion()));
      const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(rel.invert()).normalize();
      wheels.push({ obj: o, axle, radius: Math.max(0.04, sz.y / 2) });
    });
    return wheels;
  }

  function runHook(state, dt) {
    if (!s.hook) return false;
    try {
      s.hook.call(s.obj, state, dt);
      return true;
    } catch (err) {
      console.error(err);
      s.hook = null;
      if (s.mode !== 'wear') s.wheels = findWheels(s.obj);
      toast('⚠️ 這個零件的操作程式出錯，改用通用效果');
      return false;
    }
  }

  function start(inst, mode, part) {
    if (s) stop();
    resetInput();
    const obj = inst.object;
    const box = worldBox(inst);
    s = {
      inst,
      obj,
      mode,
      size: box.getSize(new THREE.Vector3()),
      t: 0,
      hook: typeof obj.userData.onControl === 'function' ? obj.userData.onControl : null,
      snapper: mode === 'wear' && SNAP_WORDS.test(`${part?.name || ''} ${part?.prompt || ''}`),
      prev: { position: obj.position.clone(), quaternion: obj.quaternion.clone(), scale: obj.scale.clone() },
      saved: {
        minDistance: controls.minDistance,
        maxDistance: controls.maxDistance,
        enableZoom: controls.enableZoom,
        enablePan: controls.enablePan,
        maxPolarAngle: controls.maxPolarAngle,
      },
      fov: camera.fov,
    };
    if (mode === 'pilot') {
      // 駕駛：物件由物理引擎推（風扇、輪子、火箭），這裡不動它，只接管鏡頭
      s.camFwd = null;
      controls.enabled = false;
      camera.fov = 55;
      camera.updateProjectionMatrix();
    } else if (mode === 'wear') {
      // 戴在右手：縮到約 30 公分、掛在鏡頭前右下方，+Z（手指方向）朝前
      const rest = inst.restBox.getSize(new THREE.Vector3());
      const restCenter = inst.restBox.getCenter(new THREE.Vector3());
      const k = 0.26 / Math.max(rest.x, rest.y, rest.z, 0.01);
      obj.removeFromParent();
      camera.add(obj);
      obj.scale.setScalar(k);
      obj.quaternion.setFromEuler(new THREE.Euler(-0.35, Math.PI + 0.25, 0));
      s.anchor = new THREE.Vector3();
      placeAnchor();
      s.restCenterK = restCenter.multiplyScalar(k); // 物件中心（縮放後、自身座標）
      s.centerOffset = s.restCenterK.clone().applyQuaternion(obj.quaternion);
      obj.position.copy(s.anchor).sub(s.centerOffset);
      s.punch = 0;
      // 第一人稱看四周：繞著眼前 10 公分的點轉，看起來就像轉頭
      camera.getWorldDirection(fwd);
      Object.assign(controls, { minDistance: 0.01, maxDistance: 0.2, enableZoom: false, enablePan: false, maxPolarAngle: Math.PI * 0.95 });
      controls.target.copy(camera.position).addScaledVector(fwd, 0.1);
      controls.update();
    } else {
      const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ');
      s.yaw = e.y;
      s.moveYaw = e.y; // 車子實際往哪走；抓地力低時會跟車頭方向不同＝甩尾
      s.speed = 0;
      s.alt = mode === 'fly' ? Math.max(0, box.min.y) : 0;
      s.groundOffset = obj.position.y - box.min.y;
      obj.rotation.order = 'YXZ';
      obj.rotation.set(0, s.yaw, 0);
      s.wheels = s.hook ? [] : findWheels(obj);
      controls.enabled = false;
      // 追焦用窄一點的視角，車子才不會小小一台（手機直拿時一般畫面用的是廣角）
      camera.fov = 55;
      camera.updateProjectionMatrix();
    }
    return s;
  }

  function stop() {
    if (!s) return;
    const { obj, inst, mode } = s;
    if (mode === 'pilot') {
      controls.enabled = true;
      camera.fov = s.fov;
      camera.updateProjectionMatrix();
      if (s.lastCenter) controls.target.copy(s.lastCenter);
    } else if (mode === 'wear') {
      // 放回使用者前方的地上，恢復原本大小
      camera.remove(obj);
      world.add(obj);
      obj.scale.copy(s.prev.scale);
      const camPos = camera.getWorldPosition(new THREE.Vector3());
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      obj.position.set(camPos.x + fwd.x * 1.3, 0, camPos.z + fwd.z * 1.3);
      obj.rotation.set(0, Math.atan2(camPos.x - obj.position.x, camPos.z - obj.position.z), 0);
      dropToSupport(inst);
      Object.assign(controls, s.saved);
      controls.target.copy(camPos).addScaledVector(fwd, 3);
      controls.target.y = Math.max(0.3, camPos.y - 1);
    } else {
      obj.rotation.set(0, s.yaw, 0);
      obj.rotation.order = 'XYZ';
      dropToSupport(inst); // 飛在空中放開就降回地面或下方的東西上
      controls.enabled = true;
      camera.fov = s.fov;
      camera.updateProjectionMatrix();
      controls.target.copy(worldBox(inst).getCenter(new THREE.Vector3()));
    }
    controls.update();
    s = null;
    resetInput();
  }

  function snap() {
    const others = instancesList().filter((i) => s && i !== s.inst && i.object.visible);
    for (let i = others.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [others[i], others[j]] = [others[j], others[i]];
    }
    const victims = others.slice(0, Math.floor(others.length / 2));
    if (!victims.length) {
      toast('🫰 彈指！……可是這裡沒有別的東西');
      return;
    }
    for (const v of victims) {
      dust(v);
      v.object.visible = false;
    }
    toast(`🫰 彈指！${victims.length} 個東西化成灰……5 秒後回來`);
    setTimeout(() => victims.forEach((v) => (v.object.visible = true)), 5000);
  }

  function dust(inst) {
    const box = worldBox(inst);
    const n = 240;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      pos[i * 3] = THREE.MathUtils.lerp(box.min.x, box.max.x, Math.random());
      pos[i * 3 + 1] = THREE.MathUtils.lerp(box.min.y, box.max.y, Math.random());
      pos[i * 3 + 2] = THREE.MathUtils.lerp(box.min.z, box.max.z, Math.random());
      vel[i * 3] = (Math.random() - 0.2) * 0.8;
      vel[i * 3 + 1] = Math.random() * 0.7 + 0.2;
      vel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0x9a7856, size: 0.035, transparent: true, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    scene.add(pts);
    effects.push({ pts, vel, life: 1.8, max: 1.8 });
  }

  function updateEffects(dt) {
    for (let k = effects.length - 1; k >= 0; k -= 1) {
      const e = effects[k];
      e.life -= dt;
      const attr = e.pts.geometry.attributes.position;
      for (let i = 0; i < attr.array.length; i += 1) attr.array[i] += e.vel[i] * dt;
      attr.needsUpdate = true;
      e.pts.material.opacity = Math.max(0, e.life / e.max);
      if (e.life <= 0) {
        e.pts.removeFromParent();
        e.pts.geometry.dispose();
        e.pts.material.dispose();
        effects.splice(k, 1);
      }
    }
  }

  function updateVehicle(dt) {
    const { obj, mode } = s;
    const fly = mode === 'fly';
    const T = tuning;
    const maxF = fly ? T.flyMaxForward : T.maxForward;
    const maxR = fly ? T.flyMaxReverse : T.maxReverse;
    if (Math.abs(input.y) > 0.05) {
      const braking = Math.abs(s.speed) > 0.2 && Math.sign(input.y) !== Math.sign(s.speed);
      s.speed += input.y * (braking ? T.brake : T.accel) * dt;
    } else {
      s.speed *= Math.max(0, 1 - T.drag * dt);
    }
    s.speed = clamp(s.speed, -maxR, maxF);
    // 車子要有速度才轉得動；飛行器原地也能慢慢轉
    const steerGrip = fly ? Math.max(0.5, clamp(Math.abs(s.speed) / 4, 0, 1)) : clamp(Math.abs(s.speed) / 3, 0, 1);
    s.yaw -= input.x * T.turnRate * steerGrip * (s.speed < -0.05 ? -1 : 1) * dt;
    if (fly) s.alt = clamp(s.alt + input.lift * T.liftSpeed * dt, 0, 25);
    // 抓地力 1＝車子往車頭方向走；越低，行進方向越慢跟上車頭＝甩尾
    s.moveYaw = T.grip >= 1 ? s.yaw : s.moveYaw + angleDiff(s.yaw, s.moveYaw) * Math.min(1, T.grip * 12 * dt);

    // 規則模組的每格鉤子：可以改速度、車頭、行進方向、高度
    if (hooks.size) {
      const hs = {
        mode,
        object: obj,
        speed: s.speed,
        yaw: s.yaw,
        moveYaw: s.moveYaw,
        alt: s.alt,
        input: { x: input.x, y: input.y, lift: input.lift, action: input.actionPressed },
        t: s.t,
      };
      for (const list of hooks.values()) for (const fn of list) fn(hs, dt);
      if (Number.isFinite(hs.speed)) s.speed = clamp(hs.speed, -80, 80);
      if (Number.isFinite(hs.yaw)) s.yaw = hs.yaw;
      if (Number.isFinite(hs.moveYaw)) s.moveYaw = hs.moveYaw;
      if (Number.isFinite(hs.alt)) s.alt = clamp(hs.alt, 0, 60);
    }

    move.set(Math.sin(s.moveYaw), 0, Math.cos(s.moveYaw));
    obj.position.addScaledVector(move, s.speed * dt);
    const r = Math.hypot(obj.position.x, obj.position.z);
    if (r > 28) {
      obj.position.x *= 28 / r;
      obj.position.z *= 28 / r;
      s.speed *= -0.3;
    }
    let pitch = 0;
    let roll = 0;
    let bob = 0;
    if (fly) {
      if (s.alt > 0.05) bob = Math.sin(s.t * 2.2) * 0.04;
      roll = input.x * 0.35 * clamp(Math.abs(s.speed) / maxF + 0.3, 0, 1); // 轉彎時往內側傾
      pitch = input.y * 0.08;
    }
    obj.position.y = s.alt + s.groundOffset + bob;
    obj.rotation.set(pitch, s.yaw, roll);
    fwd.set(Math.sin(s.yaw), 0, Math.cos(s.yaw)); // 鏡頭跟著車頭方向

    const state = {
      mode,
      speed: s.speed,
      steer: input.x,
      throttle: input.y,
      lift: input.lift,
      action: input.actionPressed,
      actionHeld: input.actionHeld,
      t: s.t,
    };
    if (!runHook(state, dt)) {
      for (const w of s.wheels) {
        spinQ.setFromAxisAngle(w.axle, (s.speed * dt) / w.radius);
        w.obj.quaternion.multiply(spinQ);
      }
    }

    // 追焦鏡頭：在車後上方，平滑跟上
    const dist = clamp(Math.max(s.size.z, s.size.x) * 2.3, 3.2, 14);
    const height = clamp(s.size.y * 1.9, 1.3, 7);
    desired.set(obj.position.x - fwd.x * dist, obj.position.y + height, obj.position.z - fwd.z * dist);
    camera.position.lerp(desired, 1 - Math.exp(-8 * dt));
    look.set(obj.position.x + fwd.x * 2, obj.position.y + s.size.y * 0.6, obj.position.z + fwd.z * 2);
    camera.lookAt(look);
  }

  // 手上東西的位置：鏡頭前 0.55 公尺、畫面右下角；依視角和螢幕寬高算，iPhone 直拿也不會被切掉
  function placeAnchor() {
    const d = 0.55;
    const halfH = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const halfW = halfH * camera.aspect;
    s.anchor.set(halfW * 0.5, -halfH * 0.42, -d);
  }

  function updateWear(dt) {
    const { obj } = s;
    placeAnchor();
    if (!(s.punch > 0)) obj.position.copy(s.anchor).sub(s.centerOffset);
    // 搖桿走路：方向跟著目前看的方向，鏡頭和轉動中心一起平移
    if (Math.abs(input.x) > 0.05 || Math.abs(input.y) > 0.05) {
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      right.crossVectors(fwd, UP).normalize();
      move.copy(fwd).multiplyScalar(input.y).addScaledVector(right, input.x).multiplyScalar(tuning.walkSpeed * dt);
      camera.position.add(move);
      controls.target.add(move);
    }
    const state = {
      mode: 'wear',
      speed: 0,
      steer: input.x,
      throttle: input.y,
      lift: 0,
      action: input.actionPressed,
      actionHeld: input.actionHeld,
      t: s.t,
    };
    if (!runHook(state, dt)) {
      // 通用動作：往前揮一拳
      if (input.actionPressed) s.punch = 0.32;
      if (s.punch > 0) {
        s.punch = Math.max(0, s.punch - dt);
        const k = Math.sin(Math.PI * (1 - s.punch / 0.32));
        obj.position.copy(s.anchor).sub(s.centerOffset);
        obj.position.y += 0.04 * k;
        obj.position.z -= 0.22 * k;
      }
    }
    if (input.actionPressed && s.snapper) snap();
  }

  // 駕駛：輸入交給物理引擎（pilot 回傳整台東西的中心、前方、大小），鏡頭在後上方跟著
  function updatePilot(dt) {
    const f = pilot?.(s.inst, input, dt);
    if (!f) return;
    s.lastCenter = f.center;
    s.camFwd = s.camFwd ? s.camFwd.lerp(f.forward, 1 - Math.exp(-3 * dt)).normalize() : f.forward.clone();
    const dist = clamp(Math.max(f.size.x, f.size.z) * 2.2, 3.5, 16);
    const height = clamp(f.size.y * 1.6 + 1.2, 1.6, 8);
    desired.set(f.center.x - s.camFwd.x * dist, f.center.y + height, f.center.z - s.camFwd.z * dist);
    camera.position.lerp(desired, 1 - Math.exp(-6 * dt));
    look.copy(f.center).addScaledVector(s.camFwd, 2);
    camera.lookAt(look);
  }

  function update(dt) {
    updateEffects(dt);
    if (s) {
      s.t += dt;
      if (s.mode === 'wear') updateWear(dt);
      else if (s.mode === 'pilot') updatePilot(dt);
      else updateVehicle(dt);
    }
    input.actionPressed = false;
  }

  return {
    input,
    start,
    stop,
    update,
    vehicle: vehicleApi,
    pressAction(down) {
      if (down && !input.actionHeld) input.actionPressed = true;
      input.actionHeld = down;
    },
    spinWorn(rad) {
      if (s?.mode !== 'wear') return;
      // 轉方向，但讓物件中心留在手的位置
      s.obj.rotateY(rad);
      s.centerOffset.copy(s.restCenterK).applyQuaternion(s.obj.quaternion);
      s.obj.position.copy(s.anchor).sub(s.centerOffset);
    },
    // 存檔時，戴在手上的東西要記成戴上之前的位置（不然會存成縮小飄在半空）
    savedTransformFor(inst) {
      return s && s.mode === 'wear' && s.inst === inst ? s.prev : null;
    },
    get active() {
      return !!s;
    },
    get mode() {
      return s?.mode || null;
    },
    get ownsCamera() {
      return !!s && s.mode !== 'wear';
    },
    get session() {
      return s;
    },
  };
}
