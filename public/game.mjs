// 遊戲房（瀏覽器）：在工坊裡「做一個遊戲」，再找朋友一起玩。
//   /?games        大廳：我的遊戲、正在開的房間（點一下就加入，不用打房號）
//   /?edit=<id>    玩法編輯器：選道具（顏色、射速）、場地與標靶、怎樣算贏 —— 全部用按鈕，不用寫程式
//   /?room=<房號>  房間：大廳 → 倒數 → 第一人稱拿道具射靶（大家的分數同步）→ 共享結算 → 房主改規則再玩
// 分數、計時、標靶位置都由伺服器決定（rooms.mjs），這裡只負責畫面、操作和把「我打中了」告訴伺服器。

const RULE_TEXT = (g) => {
  const pts = g.targets.moving ? '（會動的靶 2 分）' : '';
  return g.rule.type === 'timed' ? `${g.rule.seconds} 秒內分數最高的贏${pts}` : `先拿到 ${g.rule.goal} 分的贏${pts}`;
};
const COLORS = ['#7cf8ff', '#ff5ca8', '#ffd166', '#9dff5c', '#b48cff', '#ff8a3d'];
const RATES = [
  ['slow', '慢'],
  ['normal', '中'],
  ['fast', '快'],
];
const fmt = (s) => {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

import { createArena } from './arena.mjs';

export function createGame(env) {
  const { THREE, scene, camera, controls, renderer, runtime, engine, tools, isTouch, api, toast } = env;
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(window.location.search);
  const arena = new THREE.Group();
  arena.name = 'game-arena';
  scene.add(arena);
  const decorUpdaters = [];
  let view = null; // 'hub' | 'edit' | 'room'
  let state = null; // 房間的最新狀態（伺服器推來的）
  let me = null; // { code, token, playerId }
  let clockOffset = 0; // 伺服器時間 − 我的時間
  let es = null;
  let gun = null; // 拿在手上的道具（本機的物件，不存檔）
  let gunPart = null;
  const targetObjs = new Map(); // 標靶 id → 物件
  const avatars = new Map(); // 玩家 id → 人偶
  const seenShots = new Set();
  let lastPoseSent = 0;
  let lastPose = '';
  let tools0 = [];
  let editing = null; // 編輯中的遊戲定義
  let editingId = null;
  let sheet = null; // 房間裡打開的「改規則」
  const serverNow = () => Date.now() + clockOffset;

  // ---------------- 場地 ----------------

  // 訓練場（天空、地面、牆、燈、陰影）：見 arena.mjs
  let range = null;
  function buildArena() {
    range = createArena({ THREE, scene, renderer, env: env.envAdapter, sun: env.sun, hemi: env.hemi, isTouch });
  }
  function arenaLook(kind) {
    range?.setKind(kind);
  }

  function decorPart(partId) {
    const built = runtime.instantiate(partId);
    built.object.traverse((m) => {
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    for (const u of built.updaters) decorUpdaters.push(u);
    return built.object;
  }

  // 標靶：遊戲裡放大 1.3 倍比較好瞄；被打中（伺服器確認倒下）往後倒、縮下去，重新出現時從地上彈起來 —— 大家看到的時間一樣
  const TARGET_SCALE = 1.3;
  function syncTargets(list, t, dt = 1 / 60) {
    const seen = new Set();
    for (const tg of list || []) {
      seen.add(tg.id);
      let o = targetObjs.get(tg.id);
      if (!o) {
        o = new THREE.Group();
        const part = decorPart('p_vwtarget01');
        o.add(part);
        if (range) o.add(range.contactShadow(0.95));
        o.userData = { targetId: tg.id, part, fall: tg.up ? 0 : 1, up: tg.up, pos: new THREE.Vector3(tg.x, 0, tg.z) };
        arena.add(o);
        targetObjs.set(tg.id, o);
      }
      const u = o.userData;
      const dx = tg.moving && ['playing', 'preview'].includes(state?.phase) ? 1.5 * Math.sin(0.9 * ((t - (state.startAt || 0)) / 1000) + tg.phase) : 0;
      // 伺服器在靶倒下一秒後才換位置重生：倒下的動畫在原地播完，重生時在新位置彈起來
      u.pos.set(tg.x + dx, 0, tg.z);
      o.position.copy(u.pos);
      o.rotation.y = state?.game?.arena === 'ring' ? Math.atan2(-tg.x, -tg.z) : 0;
      // 倒下約 0.9 秒：前 0.35 秒往後倒、停一下、最後縮下去；重新立起時 0.3 秒彈上來
      u.fall = tg.up ? Math.max(0, u.fall - dt * 3.3) : Math.min(1, u.fall + dt * 1.1);
      const f = u.fall;
      u.part.rotation.x = -1.35 * Math.min(1, f / 0.4); // 往後倒
      const sc = TARGET_SCALE * (f < 0.7 ? 1 : 1 - (f - 0.7) / 0.3) * (tg.up && f > 0 ? 1 + 0.15 * Math.sin(f * Math.PI) : 1);
      o.scale.setScalar(Math.max(0.001, sc));
      o.visible = sc > 0.02;
      u.up = tg.up;
    }
    for (const [id, o] of targetObjs) {
      if (!seen.has(id)) {
        o.removeFromParent();
        targetObjs.delete(id);
      }
    }
  }

  // ---------------- 其他玩家：有輪廓的角色（頭盔面罩、背包、雙腳會走、手上的槍跟著瞄準方向、開火有後座） ----------------
  // 幾何共用；每個顏色一組材質；離開房間時名字貼圖一起釋放
  const AV = {
    torso: new THREE.CapsuleGeometry(0.2, 0.32, 4, 12),
    hip: new THREE.BoxGeometry(0.34, 0.14, 0.22),
    leg: new THREE.CapsuleGeometry(0.075, 0.63, 4, 8).translate(0, -0.39, 0), // 從髖部（0.78 m）一路到地面
    head: new THREE.SphereGeometry(0.17, 20, 14),
    visor: new THREE.SphereGeometry(0.172, 20, 10, Math.PI * 0.08, Math.PI * 0.84, Math.PI * 0.32, Math.PI * 0.28), // 臉朝 +Z 的一圈面罩
    pack: new THREE.BoxGeometry(0.26, 0.32, 0.12),
    strip: new THREE.BoxGeometry(0.03, 0.24, 0.01),
    arm: new THREE.CapsuleGeometry(0.055, 0.3, 4, 8),
    gun: new THREE.BoxGeometry(0.07, 0.09, 0.34),
    barrel: new THREE.CylinderGeometry(0.022, 0.022, 0.16, 10).rotateX(Math.PI / 2),
  };
  const AVM = {
    suit: new THREE.MeshStandardMaterial({ color: 0x2b333d, roughness: 0.7, metalness: 0.2 }),
    visor: new THREE.MeshStandardMaterial({ color: 0x0b1018, roughness: 0.08, metalness: 0.9, envMapIntensity: 1.4 }),
    gun: new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.45, metalness: 0.05 }),
    gunmetal: new THREE.MeshStandardMaterial({ color: 0x3b444d, roughness: 0.35, metalness: 0.8 }),
  };
  const teamMats = new Map();
  function teamMat(color) {
    if (!teamMats.has(color)) {
      teamMats.set(color, {
        shell: new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1 }),
        glow: new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.4 }),
      });
    }
    return teamMats.get(color);
  }
  function labelSprite(text, color) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(4,12,20,0.72)';
    g.beginPath();
    g.roundRect(4, 10, 248, 44, 20);
    g.fill();
    g.fillStyle = color;
    g.beginPath();
    g.arc(30, 32, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#eaf6ff';
    g.font = 'bold 28px -apple-system, "PingFang TC", sans-serif';
    g.textBaseline = 'middle';
    g.fillText(text, 50, 33);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    s.scale.set(0.84, 0.21, 1);
    s.renderOrder = 20;
    return s;
  }
  const mesh = (geo, mat, x, y, z, parent) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  function makeAvatar(p) {
    const tm = teamMat(p.color);
    const g = new THREE.Group();
    const body = new THREE.Group(); // 上半身（走路時微微上下）
    g.add(body);
    mesh(AV.hip, AVM.suit, 0, 0.82, 0, body);
    mesh(AV.torso, tm.shell, 0, 1.12, 0, body);
    const pack = mesh(AV.pack, AVM.suit, 0, 1.14, -0.17, body);
    mesh(AV.strip, tm.glow, 0, 0, -0.065, pack);
    const head = new THREE.Group();
    head.position.set(0, 1.5, 0);
    body.add(head);
    mesh(AV.head, tm.shell, 0, 0, 0, head);
    mesh(AV.visor, AVM.visor, 0, 0.01, 0.004, head).rotation.y = 0;
    const legs = [-1, 1].map((sx) => mesh(AV.leg, AVM.suit, sx * 0.09, 0.78, 0, g));
    // 手和槍：整組跟著瞄準的上下角度轉
    const aim = new THREE.Group();
    aim.position.set(0.05, 1.28, 0.05);
    body.add(aim);
    const armR = mesh(AV.arm, tm.shell, 0.17, -0.06, 0.12, aim);
    armR.rotation.x = Math.PI / 2.4;
    const armL = mesh(AV.arm, tm.shell, -0.1, -0.08, 0.2, aim);
    armL.rotation.set(Math.PI / 2.3, 0, -0.5);
    const gun = new THREE.Group();
    gun.position.set(0.1, -0.08, 0.32);
    aim.add(gun);
    mesh(AV.gun, AVM.gun, 0, 0, 0, gun);
    mesh(AV.barrel, AVM.gunmetal, 0, 0.01, 0.24, gun);
    const muzzle = mesh(new THREE.SphereGeometry(0.03, 8, 6), tm.glow, 0, 0.01, 0.33, gun);
    const label = labelSprite(p.name, p.color);
    label.position.y = 1.95;
    g.add(label);
    if (range) g.add(range.contactShadow(0.85));
    g.userData = { name: p.name, aim, gun, muzzle, legs, body, label, walk: 0, kick: 0, last: new THREE.Vector3(), speed: 0 };
    arena.add(g);
    return g;
  }
  function disposeAvatar(a) {
    a.removeFromParent();
    a.userData.label.material.map.dispose();
    a.userData.label.material.dispose();
    a.userData.muzzle.geometry.dispose();
  }
  function syncAvatars(dt) {
    if (!state) return;
    const present = new Set();
    for (const p of state.players) {
      if (p.id === me?.playerId) continue;
      present.add(p.id);
      let a = avatars.get(p.id);
      if (!a || a.userData.name !== p.name) {
        if (a) disposeAvatar(a);
        a = makeAvatar(p);
        avatars.set(p.id, a);
        if (p.pose) a.position.set(p.pose.p[0], 0, p.pose.p[2]);
      }
      const u = a.userData;
      const pose = p.pose || { p: [0, 1.6, 0], yaw: 0, pitch: 0 };
      const k = 1 - Math.exp(-10 * dt);
      u.last.copy(a.position);
      a.position.x += (pose.p[0] - a.position.x) * k;
      a.position.z += (pose.p[2] - a.position.z) * k;
      a.rotation.y += Math.atan2(Math.sin(pose.yaw - a.rotation.y), Math.cos(pose.yaw - a.rotation.y)) * k;
      // 走路：依移動速度擺腳、身體微微上下
      const v = dt > 0 ? u.last.distanceTo(a.position) / dt : 0;
      u.speed += (Math.min(v, 3) - u.speed) * Math.min(1, dt * 8);
      u.walk += dt * (2 + u.speed * 4);
      const swing = Math.min(1, u.speed / 1.5) * 0.55;
      u.legs[0].rotation.x = Math.sin(u.walk) * swing;
      u.legs[1].rotation.x = -Math.sin(u.walk) * swing;
      u.body.position.y = Math.abs(Math.sin(u.walk)) * 0.03 * Math.min(1, u.speed);
      // 瞄準：手和槍跟著上下角度；開火往後一頓
      u.kick = Math.max(0, u.kick - dt * 8);
      u.aim.rotation.x = -pose.pitch - 0.25 * u.kick;
      u.gun.position.z = 0.32 - 0.05 * u.kick;
      u.muzzle.scale.setScalar(1 + u.kick * 2.5);
      // 斷線的人變半透明（每個顏色只有一個人，材質共用沒關係）
      const tm = teamMat(p.color);
      tm.shell.transparent = !p.connected;
      tm.shell.opacity = p.connected ? 1 : 0.4;
      u.label.material.opacity = p.connected ? 1 : 0.45;
    }
    for (const [id, a] of avatars) {
      if (!present.has(id)) {
        disposeAvatar(a);
        avatars.delete(id);
      }
    }
  }
  // 別人開火：他的角色同一刻往後一頓、槍口一亮
  function avatarKick(playerId) {
    const a = avatars.get(playerId);
    if (a) a.userData.kick = 1;
  }

  // ---------------- 道具（拿在手上） ----------------

  async function holdTool(game) {
    const partId = game.tool.partId;
    if (!runtime.parts.has(partId)) return toast('⚠️ 找不到這個道具');
    await env.loadPartsFor([partId]);
    if (gun && gun.partId !== partId) dropTool();
    if (!gun) {
      gun = env.addInstance({ id: `i_gun${Date.now().toString(36)}`, partId, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, { save: false });
      gunPart = runtime.parts.get(partId);
    }
    tools.setOverride({ color: game.tool.color, rate: { slow: 2, normal: 4, fast: 7 }[game.tool.rate] }, gun.object);
    if (!engine.active) {
      // 站到自己的出生點，面向標靶（第一次拿槍時的位置就是出生點，記下來給「回原位」用）
      if (!spawnAt) spawnAt = state?.players.find((p) => p.id === me?.playerId)?.pose?.p || [0, 1.6, 1.5];
      standAtSpawn();
      env.startControl(gun, 'wear');
      $('#ctlLabel').textContent = `🔫 ${gunPart?.name || '道具'}`;
      $('#gameTool').textContent = `🔫 ${gunPart?.name || '道具'}`;
      $('#ctlHint').textContent = isTouch ? '拖曳畫面瞄準（看中間的準星），按右下 ⚡ 發射，左下搖桿走路' : '拖曳畫面瞄準（看中間的準星），按 ⚡ 或空白鍵發射，WASD 走路';
    }
    document.body.classList.add('aiming');
  }
  // 音效開關（記在這台裝置上）
  const muteBtn = $('#gameMute');
  const renderMute = () => (muteBtn.textContent = env.sfx?.muted ? '🔇' : '🔊');
  muteBtn.onclick = () => {
    env.sfx?.setMuted(!env.sfx.muted);
    renderMute();
  };
  renderMute();
  // 命中回饋：準星馬上變成 ✕（打到了），伺服器確認得分時在標靶上飄出「+1」
  let hitTimer = 0;
  function hitMarker() {
    const el = $('#crosshair');
    el.classList.add('hit');
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => el.classList.remove('hit'), 180);
  }
  function scorePop(worldPoint, points) {
    const p = new THREE.Vector3(...worldPoint).project(camera);
    if (p.z > 1) return;
    const r = renderer.domElement.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'hit-pop';
    el.textContent = `+${points}`;
    el.style.left = `${r.left + ((p.x + 1) / 2) * r.width}px`;
    el.style.top = `${r.top + ((1 - p.y) / 2) * r.height}px`;
    $('#hitPops').appendChild(el);
    setTimeout(() => el.remove(), 850);
  }
  let spawnAt = null;
  function standAtSpawn() {
    const sp = spawnAt || [0, 1.6, 1.5];
    camera.position.set(sp[0], 1.6, sp[2]);
    const look = state?.game?.arena === 'ring' ? new THREE.Vector3(sp[0], 1.4, sp[2] - 3) : new THREE.Vector3(sp[0], 1.4, -6);
    const dir = look.sub(camera.position).normalize();
    controls.target.copy(camera.position).addScaledVector(dir, engine.active ? 0.1 : 3);
    camera.lookAt(controls.target);
    controls.update();
  }
  // 救援：走太遠、轉暈了 → 回到出生點、面向標靶（不影響分數）
  $('#gameReset').onclick = () => {
    if (!engine.active) return;
    standAtSpawn();
    toast('↺ 回到原位了', 1500);
  };
  function dropTool() {
    document.body.classList.remove('aiming');
    if (engine.active) env.stopControl();
    if (gun) {
      env.removeInstance(gun.id, { save: false });
      gun = null;
    }
  }

  // ---------------- 網路 ----------------

  const tokenKey = (code) => `vw_room_${code}`;
  async function joinRoom(code) {
    const saved = localStorage.getItem(tokenKey(code));
    let r;
    try {
      r = await api('POST', `/api/rooms/${code}/join`, { token: saved || undefined });
    } catch (e) {
      showMessage('進不去這個房間', e.message, [['回遊戲房大廳', () => env.goTo('/?games')]]);
      return false;
    }
    me = { code, token: r.token, playerId: r.playerId };
    localStorage.setItem(tokenKey(code), r.token);
    onState(r.state);
    if (r.rejoined) toast('↩️ 回到房間了，分數還在', 2500);
    openStream();
    return true;
  }
  function openStream() {
    es?.close();
    es = new EventSource(`/api/rooms/${me.code}/stream?token=${me.token}`);
    es.onmessage = (ev) => {
      try {
        onState(JSON.parse(ev.data));
      } catch (e) {
        console.error(e);
      }
    };
    let fails = 0;
    const stream = es;
    es.onerror = async () => {
      // 網路斷了：瀏覽器會自己重連（先顯示「重新連線中」）。串流被伺服器拒絕（房間不在了、身分失效）時瀏覽器不會再試，
      // 這時候直接問伺服器房間還在不在，給清楚的結果
      $('#gameNet').hidden = false;
      fails += 1;
      if (stream.readyState !== EventSource.CLOSED && fails < 3) return;
      fails = 0;
      let gone = false;
      try {
        // 房間還在：接回去（太久沒回來被移出的話，伺服器會給一個新身分）
        const r = await api('POST', `/api/rooms/${me.code}/join`, { token: me.token });
        me.token = r.token;
        me.playerId = r.playerId;
        localStorage.setItem(tokenKey(me.code), r.token);
        onState(r.state);
        openStream();
        return;
      } catch (e) {
        gone = /找不到這個房間/.test(e.message);
      }
      if (!gone) {
        // 伺服器暫時連不上：過幾秒再試
        if (stream.readyState === EventSource.CLOSED) setTimeout(() => es === stream && openStream(), 3000);
        return;
      }
      es.close();
      $('#gameNet').hidden = true;
      dropTool();
      localStorage.removeItem(tokenKey(me.code));
      showMessage('房間已經關了', '可能是工坊伺服器重新啟動了，或房間太久沒人。遊戲本身有存好，回大廳再開一個房間就能繼續玩。', [['回遊戲房大廳', () => env.goTo('/?games')]]);
    };
    es.onopen = () => {
      fails = 0;
      $('#gameNet').hidden = true;
    };
  }
  const act = (body) => api('POST', `/api/rooms/${me.code}/act`, { token: me.token, ...body }).catch((e) => ({ ok: false, why: e.message }));

  let lastPhase = null;
  let lastLog = 0;
  function onState(s) {
    if (!s || (state && s.seq < state.seq && s.round === state.round)) return;
    clockOffset = clockOffset ? clockOffset * 0.8 + (s.now - Date.now()) * 0.2 : s.now - Date.now();
    const prev = state;
    state = s;
    if (!s.players.some((p) => p.id === me?.playerId)) {
      // 不在房裡了（太久沒回來被移出，或在別的分頁按了離開）
      es?.close();
      dropTool();
      showMessage('你已經不在這個房間', '可能是離開太久了。回大廳再加入一次就好。', [['回遊戲房大廳', () => env.goTo('/?games')]]);
      return;
    }
    // 新的事件（誰進來、誰打中、誰離開）
    for (const l of s.log) {
      if (l.t > lastLog && prev && !l.text.includes('打中了')) toast(l.text, 2200);
    }
    lastLog = Math.max(lastLog, ...s.log.map((l) => l.t), 0);
    // 別人射的子彈畫出來
    for (const sh of s.shots) {
      if (seenShots.has(sh.id)) continue;
      seenShots.add(sh.id);
      if (sh.by !== me.playerId) {
        tools.remoteShot(sh);
        avatarKick(sh.by);
      }
    }
    if (seenShots.size > 400) seenShots.clear();
    if (s.game.arena !== prev?.game?.arena) arenaLook(s.game.arena);
    if (s.phase !== lastPhase) onPhase(s.phase, lastPhase);
    lastPhase = s.phase;
    renderRoom();
  }

  async function onPhase(phase, before) {
    if (phase === 'ended' && before === 'playing') guardCard();
    if (phase === 'countdown' || phase === 'playing') {
      hideCard();
      sheet = null;
      await holdTool(state.game);
    }
    tools.enabled = phase !== 'ended';
    if (phase === 'lobby') {
      dropTool();
      roomCamera();
    }
    if (before === null && phase === 'ended') roomCamera();
  }

  function roomCamera() {
    if (engine.active) return;
    const ring = state?.game?.arena === 'ring';
    camera.position.set(ring ? 0 : 0, ring ? 9 : 4.2, ring ? 9.5 : 6.5);
    controls.target.set(0, 0.8, ring ? 0 : -6);
    controls.update();
  }

  // ---------------- 每一格 ----------------

  function update(dt, t) {
    for (const u of decorUpdaters) {
      if (u.dead) continue;
      try {
        u.fn.call(u.obj, dt, t);
      } catch (e) {
        u.dead = true;
        console.error(e);
      }
    }
    if (view === 'room' && state) {
      // 牆是實體：走不出靶場（射擊台後面）或競技場中間的平台
      if (engine.active && range) {
        const before = camera.position.clone();
        range.clampPlayer(state.game?.arena, camera.position);
        controls.target.add(camera.position.clone().sub(before));
      }
      syncTargets(state.targets, serverNow(), dt);
      syncAvatars(dt);
      // 把自己的位置和瞄準方向告訴大家（每 0.12 秒、有變才送）
      const tnow = performance.now();
      if (tnow - lastPoseSent > 120) {
        lastPoseSent = tnow;
        const d = camera.getWorldDirection(new THREE.Vector3());
        const pose = { p: camera.position.toArray().map((v) => Math.round(v * 100) / 100), yaw: Math.round(Math.atan2(d.x, d.z) * 100) / 100, pitch: Math.round(Math.asin(Math.max(-1, Math.min(1, d.y))) * 100) / 100 };
        const key = JSON.stringify(pose);
        if (key !== lastPose && engine.active) {
          lastPose = key;
          act({ type: 'pose', ...pose });
        }
      }
      renderTimer();
    }
    if (view === 'edit' && editing) {
      syncTargets(previewTargets, Date.now(), dt);
      if (previewGun) previewGun.rotation.y += dt * 0.8;
    }
  }

  // ---------------- 畫面：房間 ----------------

  const card = $('#gameCard');
  function hideCard() {
    card.hidden = true;
  }
  // 比賽結束那一刻手指常常還在畫面上（拖曳瞄準、按 ⚡）：結算卡剛跳出來的 0.8 秒按鈕不吃點按，
  // 不然會誤按到「再玩一次／改規則再玩／離開房間」
  let guardTimer = 0;
  function guardCard() {
    card.classList.add('guard');
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => card.classList.remove('guard'), 800);
  }
  function showCard({ icon = '', title, body = '', buttons = [] }) {
    $('#gameCardIcon').textContent = icon;
    $('#gameCardTitle').textContent = title;
    $('#gameCardBody').innerHTML = body;
    const box = $('#gameCardBtns');
    box.innerHTML = '';
    for (const [label, fn, cls = ''] of buttons) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = cls;
      b.onclick = fn;
      box.appendChild(b);
    }
    card.hidden = false;
  }
  function showMessage(title, text, buttons) {
    showCard({ icon: '⚠️', title, body: `<p class="g-small">${esc(text)}</p>`, buttons: buttons.map(([l, f]) => [l, f, 'primary big']) });
  }
  const isHost = () => state && state.hostId === me?.playerId;
  function playersHtml(list) {
    return `<ul class="g-players">${list
      .map(
        (p) =>
          `<li><span class="dot" style="background:${p.color}"></span><b>${esc(p.name)}</b>${p.id === me?.playerId ? '<em>（你）</em>' : ''}${p.host ? '<span class="tag">房主</span>' : ''}${p.connected ? '' : '<span class="tag off">斷線</span>'}</li>`,
      )
      .join('')}</ul>`;
  }
  function showLobby() {
    if (!state) return;
    const host = isHost();
    showCard({
      icon: '🎮',
      title: state.game.name,
      body:
        `<div class="g-code">房號 <b>${state.code}</b></div>` +
        `<p class="g-rule">🏁 ${esc(state.ruleText)}</p>` +
        `<p class="g-small">🔫 ${esc(runtime.parts.get(state.game.tool.partId)?.name || '道具')}、🎯 ${state.game.targets.count} 個標靶${state.game.targets.moving ? '（會動）' : ''}</p>` +
        playersHtml(state.players) +
        `<p class="g-small">朋友加入：同一個 Wi-Fi 打開工坊 → 首頁「🎮 遊戲房」→ 點房號 ${state.code}。</p>`,
      buttons: [
        ...(host ? [['▶ 開始比賽', () => startRound(), 'primary big'], ['✏️ 改規則', () => openRuleSheet(), 'big']] : [['等房主開始…', () => {}, 'big waiting']]),
        ['🚪 離開房間', () => leaveRoom(), 'ghost'],
      ],
    });
  }
  function showResults() {
    if (!state?.results) return;
    const win = state.results.find((r) => r.id === state.winner);
    const you = state.results.find((r) => r.id === me?.playerId);
    const host = isHost();
    showCard({
      icon: win ? '🏆' : '🤝',
      title: win ? `${win.name} 贏了！` : '平手！',
      body:
        `<p class="g-small">${state.reason === 'time' ? '⏱ 時間到' : '🏁 目標達成'} · ${esc(state.ruleText)}</p>` +
        `<table class="g-results">${state.results
          .map((r) => `<tr class="${r.id === me?.playerId ? 'me' : ''}"><td>${r.rank}</td><td><span class="dot" style="background:${r.color}"></span>${esc(r.name)}${r.id === me?.playerId ? '（你）' : ''}</td><td>${r.score} 分</td><td>${r.hits} 中</td></tr>`)
          .join('')}</table>` +
        (you ? `<p class="g-lead">${you.id === state.winner ? '🎉 你贏了！' : `你拿到 ${you.score} 分`}</p>` : ''),
      buttons: [
        ...(host ? [['🔁 再玩一次', () => startRound(), 'primary big'], ['✏️ 改規則再玩', () => openRuleSheet(), 'big']] : [['等房主決定下一回合…', () => {}, 'big waiting']]),
        ['🚪 離開房間', () => leaveRoom(), 'ghost'],
      ],
    });
  }
  async function startRound() {
    const r = await act({ type: 'start' });
    if (!r.ok) toast(`⚠️ ${r.why || '開始不了'}`);
  }
  async function leaveRoom() {
    await act({ type: 'leave' });
    localStorage.removeItem(tokenKey(me.code));
    es?.close();
    dropTool();
    env.goTo('/?games');
  }

  // 房主改規則：跟編輯器同一組按鈕（不用打字）
  function openRuleSheet() {
    sheet = JSON.parse(JSON.stringify(state.game));
    renderRuleSheet();
  }
  function renderRuleSheet() {
    const g = sheet;
    showCard({
      icon: '✏️',
      title: '改規則',
      body: ruleOptionsHtml(g, { compact: true }),
      buttons: [
        ['✅ 套用（大家都會看到）', async () => {
          const r = await act({ type: 'rules', game: sheet });
          if (!r.ok) return toast(`⚠️ ${r.why || '改不了'}`);
          sheet = null;
          toast(`✅ 新規則：${RULE_TEXT(r.game)}（已存回這個遊戲）`, 3000);
          showLobby();
        }, 'primary big'],
        ['取消', () => {
          sheet = null;
          if (state.phase === 'ended') showResults();
          else showLobby();
        }, 'ghost'],
      ],
    });
    bindOptions(card, g, renderRuleSheet);
  }

  function renderRoom() {
    // 計分板（比賽中一直顯示）
    const hud = $('#gameHud');
    hud.hidden = view !== 'room' || !state || state.phase === 'lobby';
    $('#gameReset').hidden = state?.phase !== 'playing';
    if (!state) return;
    const list = [...state.players].sort((a, b) => b.score - a.score);
    $('#gameScores').innerHTML = list
      .map((p) => `<span class="chip ${p.id === me?.playerId ? 'me' : ''} ${p.connected ? '' : 'off'}"><span class="dot" style="background:${p.color}"></span>${esc(p.name)} <b>${p.score}</b></span>`)
      .join('');
    $('#gameGoal').textContent = state.ruleText;
    // 卡片只在內容真的變了才重畫（一秒十次重畫的話，按鈕會在手指按下去的瞬間被換掉）
    const key = JSON.stringify([state.phase, state.hostId, state.game, state.results, state.players.map((p) => [p.id, p.name, p.connected, p.host])]);
    if (key === cardKey || sheet) return;
    cardKey = key;
    if (state.phase === 'lobby') showLobby();
    if (state.phase === 'ended') showResults();
  }
  let cardKey = '';
  function renderTimer() {
    const el = $('#gameTimer');
    const cd = $('#gameCount');
    const t = serverNow();
    if (state.phase === 'countdown') {
      cd.hidden = false;
      cd.textContent = String(Math.max(1, Math.ceil((state.startAt - t) / 1000)));
      el.textContent = '準備…';
    } else {
      cd.hidden = !(state.phase === 'playing' && t - state.startAt < 700);
      if (!cd.hidden) cd.textContent = '開始！';
      el.textContent = state.phase === 'playing' && state.game.rule.type === 'timed' ? `⏱ ${fmt((state.endAt - t) / 1000)}` : '';
      el.hidden = !el.textContent;
    }
  }

  // ---------------- 畫面：選項（編輯器和改規則共用） ----------------

  function seg(name, options, value) {
    return `<div class="g-seg" data-name="${name}">${options
      .map(([v, label]) => `<button type="button" data-v="${esc(v)}" class="${String(v) === String(value) ? 'on' : ''}">${label}</button>`)
      .join('')}</div>`;
  }
  function ruleOptionsHtml(g, { compact = false } = {}) {
    const toolList = tools0.length ? tools0 : [{ id: 'p_vwblaster01', name: '能量槍' }];
    return (
      (compact ? '' : `<div class="g-row"><label>🔫 道具</label>${seg('tool.partId', toolList.map((t) => [t.id, esc(t.name)]), g.tool.partId)}</div>`) +
      `<div class="g-row"><label>顏色</label><div class="g-seg colors" data-name="tool.color">${COLORS.map((c) => `<button type="button" data-v="${c}" class="${c === g.tool.color ? 'on' : ''}" style="--c:${c}" aria-label="${c}"></button>`).join('')}</div></div>` +
      `<div class="g-row"><label>射速</label>${seg('tool.rate', RATES, g.tool.rate)}</div>` +
      (compact ? '' : `<div class="g-row"><label>🗺 場地</label>${seg('arena', [['range', '靶場'], ['ring', '競技場']], g.arena)}</div>`) +
      `<div class="g-row"><label>🎯 標靶</label>${seg('targets.count', [[3, '3 個'], [5, '5 個'], [8, '8 個']], g.targets.count)}</div>` +
      `<div class="g-row"><label>會動</label>${seg('targets.moving', [[false, '不動'], [true, '會動（2 分）']], g.targets.moving)}</div>` +
      `<div class="g-row"><label>🏁 怎樣算贏</label>${seg('rule.type', [['race', '先拿到 N 分'], ['timed', '限時最高分']], g.rule.type)}</div>` +
      (g.rule.type === 'race'
        ? `<div class="g-row"><label>N =</label>${seg('rule.goal', [[3, '3 分'], [5, '5 分'], [10, '10 分']], g.rule.goal)}</div>`
        : `<div class="g-row"><label>時間</label>${seg('rule.seconds', [[30, '30 秒'], [60, '60 秒'], [90, '90 秒']], g.rule.seconds)}</div>`) +
      `<p class="g-rule">🏁 ${esc(RULE_TEXT(g))}</p>`
    );
  }
  function bindOptions(root, g, rerender) {
    root.querySelectorAll('.g-seg button').forEach((b) =>
      b.addEventListener('click', () => {
        const name = b.parentElement.dataset.name;
        let v = b.dataset.v;
        if (v === 'true' || v === 'false') v = v === 'true';
        else if (/^\d+$/.test(v)) v = Number(v);
        const [a, k] = name.split('.');
        if (k) g[a][k] = v;
        else g[a] = v;
        rerender();
      }),
    );
  }

  // ---------------- 畫面：編輯器 ----------------

  let previewTargets = [];
  let previewGun = null;
  function previewLayout(g) {
    // 預覽用：大概的標靶位置（真正比賽時由伺服器擺）
    const list = [];
    for (let i = 0; i < g.targets.count; i += 1) {
      const a = (i / g.targets.count) * Math.PI * 2;
      list.push(g.arena === 'ring' ? { id: `p${i}`, x: Math.sin(a) * 8, z: -Math.cos(a) * 8, up: true, moving: g.targets.moving, phase: i } : { id: `p${i}`, x: -4 + (8 * i) / Math.max(1, g.targets.count - 1), z: -8 - (i % 2) * 3, up: true, moving: g.targets.moving, phase: i });
    }
    return list;
  }
  async function renderEditor() {
    const g = editing;
    previewTargets = previewLayout(g);
    state = { game: g, phase: 'preview', startAt: 0 };
    arenaLook(g.arena);
    await env.loadPartsFor([g.tool.partId, 'p_vwtarget01']);
    if (previewGun?.userData.partId !== g.tool.partId) {
      previewGun?.removeFromParent();
      previewGun = decorPart(g.tool.partId);
      previewGun.userData.partId = g.tool.partId;
      const size = new THREE.Box3().setFromObject(previewGun).getSize(new THREE.Vector3());
      previewGun.scale.setScalar(1.1 / Math.max(size.x, size.y, size.z, 0.01));
      previewGun.position.set(0, 1.55, 2.4);
      arena.add(previewGun);
    }
    tools.setOverride({ color: g.tool.color }, previewGun);
    const panel = $('#gameEditor');
    panel.hidden = false;
    $('#gameEditorBody').innerHTML =
      `<div class="g-row g-name"><label>名稱</label><b id="gameName">${esc(g.name)}</b><button type="button" id="gameRename" class="ghost">✏️ 改名</button></div>` + ruleOptionsHtml(g);
    bindOptions(panel, g, renderEditor);
    $('#gameRename').onclick = () => {
      const n = window.prompt('幫這個遊戲取個名字（20 字內）', g.name);
      if (n && n.trim()) {
        g.name = n.trim().slice(0, 20);
        renderEditor();
      }
    };
  }
  async function saveEditing() {
    const r = await api('POST', '/api/games', { id: editingId || undefined, game: editing });
    editingId = r.game.id;
    editing = pick(r.game);
    window.history.replaceState(null, '', `/?edit=${editingId}`);
    return r.game;
  }
  const pick = (g) => ({ name: g.name, tool: { ...g.tool }, arena: g.arena, targets: { ...g.targets }, rule: { ...g.rule } });

  // ---------------- 畫面：大廳 ----------------

  let hubKey = '';
  async function renderHub() {
    const [gs, rs] = await Promise.all([api('GET', '/api/games'), api('GET', '/api/rooms')]);
    const box = $('#gameHubBody');
    const rooms = rs.rooms.filter((r) => r.players > 0);
    const key = JSON.stringify([gs.games, rooms]);
    if (key === hubKey) return;
    hubKey = key;
    box.innerHTML =
      (rooms.length
        ? `<h3>👥 正在開的房間（點一下加入）</h3>${rooms
            .map((r) => `<button type="button" class="g-item join" data-code="${r.code}"><b>${esc(r.name)}</b><span>房號 ${r.code} · ${r.players} 人 · ${r.phase === 'lobby' ? '等人中' : r.phase === 'ended' ? '剛比完' : '比賽中'}</span><small>${esc(r.ruleText)}</small></button>`)
            .join('')}`
        : '') +
      `<h3>🎮 我的遊戲</h3>` +
      (gs.games.length
        ? gs.games
            .slice()
            .reverse()
            .map(
              (g) =>
                `<div class="g-item game" data-id="${g.id}"><b>${esc(g.name)}</b><small>${esc(RULE_TEXT(g))}${g.last ? ` · 上次：${esc(g.last.results?.[0]?.name || '')} ${g.last.results?.[0]?.score ?? ''} 分` : ''}${g.plays ? ` · 玩過 ${g.plays} 回合` : ''}</small><div class="g-item-btns"><button type="button" class="primary" data-act="host">👥 開房間</button><button type="button" data-act="edit">✏️ 編輯</button><button type="button" data-act="copy">📋 複製</button></div></div>`,
            )
            .join('')
        : '<p class="g-small">還沒有遊戲。按上面的「＋ 做一個射靶遊戲」，用內建的能量槍和標靶做一個（不用寫程式、不用 AI）。</p>');
    box.querySelectorAll('.join').forEach((b) => (b.onclick = () => env.goTo(`/?room=${b.dataset.code}`)));
    box.querySelectorAll('.game').forEach((el) => {
      const id = el.dataset.id;
      el.querySelector('[data-act=host]').onclick = () => hostGame(id);
      el.querySelector('[data-act=edit]').onclick = () => env.goTo(`/?edit=${id}`);
      el.querySelector('[data-act=copy]').onclick = async () => {
        const r = await api('POST', `/api/games/${id}/copy`, {});
        toast(`📋 複製好了：${r.game.name}`);
        hubKey = '';
        renderHub();
      };
    });
  }
  async function hostGame(gameId) {
    const r = await api('POST', '/api/rooms', { gameId });
    env.goTo(`/?room=${r.code}`);
  }

  // ---------------- 啟動 ----------------

  async function init() {
    buildArena();
    arenaLook('range');
    const gs = await api('GET', '/api/games');
    tools0 = gs.tools || [];
    await env.loadPartsFor(['p_vwtarget01', 'p_vwblaster01', ...tools0.map((t) => t.id)]);
    if (params.has('room')) {
      view = 'room';
      const code = String(params.get('room') || '').toUpperCase();
      roomCamera();
      document.body.classList.add('game-room');
      await joinRoom(code);
      return;
    }
    if (params.has('edit')) {
      view = 'edit';
      const id = params.get('edit');
      const found = gs.games.find((g) => g.id === id);
      editingId = found ? found.id : null;
      editing = pick(found || gs.defaults);
      // 編輯面板蓋住下半部：鏡頭往下看，槍和標靶出現在上半部
      camera.position.set(0, 1.9, 6.4);
      controls.target.set(0, -0.9, 0);
      controls.update();
      await renderEditor();
      $('#gameSave').onclick = async () => {
        await saveEditing();
        toast('💾 已儲存', 2000);
      };
      $('#gameTry').onclick = async () => {
        const g = await saveEditing();
        hostGame(g.id);
      };
      $('#gameEditorBack').onclick = () => env.goTo('/?games');
      return;
    }
    view = 'hub';
    $('#gameHub').hidden = false;
    camera.position.set(0, 3.6, 6.5);
    controls.target.set(0, 0.8, -6);
    controls.update();
    previewTargets = previewLayout({ arena: 'range', targets: { count: 5, moving: true } });
    state = { game: { arena: 'range' }, phase: 'preview', startAt: 0 };
    view = 'hub';
    await renderHub();
    $('#gameNew').onclick = () => env.goTo('/?edit=new');
    $('#gameHubBack').onclick = () => env.goTo('/');
    setInterval(() => renderHub().catch(() => {}), 3000); // 朋友開的房間會自己出現
  }

  // 大廳背景也擺幾個標靶
  const hubUpdate = (dt, t) => {
    if (view === 'hub') syncTargets(previewTargets, Date.now(), dt);
  };

  return {
    init,
    update(dt, t) {
      update(dt, t);
      hubUpdate(dt, t);
    },
    // 道具打得到的東西：立著的標靶
    hittables() {
      return [...targetObjs.values()].filter((o) => o.visible && o.userData.up).map((o) => ({ object: o, kind: 'target', id: o.userData.targetId }));
    },
    onFire(shot) {
      if (view === 'room' && state?.phase === 'playing') act({ type: 'shot', from: shot.from, to: shot.to });
    },
    async onHit(h) {
      if (view !== 'room' || state?.phase !== 'playing' || h.kind !== 'target') return;
      hitMarker();
      const tg = state.targets.find((t) => t.id === h.id);
      const r = await act({ type: 'hit', target: h.id });
      if (r.ok) {
        env.sfx?.score();
        scorePop(h.point, tg?.points || 1);
      }
    },
    // 自動測試讀狀態用（只讀）
    state() {
      return {
        view,
        me: me ? { code: me.code, playerId: me.playerId } : null,
        phase: state?.phase || null,
        hostId: state?.hostId || null,
        players: state?.players?.map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected, host: p.host })) || [],
        results: state?.results || null,
        winner: state?.winner || null,
        reason: state?.reason || null,
        ruleText: state?.ruleText || null,
        game: state?.game || null,
        targets: [...targetObjs.entries()].map(([id, o]) => ({ id, up: !!o.userData.up, visible: o.visible, pos: o.getWorldPosition(new THREE.Vector3()).toArray() })),
        holding: !!gun && engine.active,
        others: [...avatars.entries()].map(([id, a]) => ({ id, pos: a.position.toArray().map((v) => Math.round(v * 100) / 100) })),
        editing: editing ? { id: editingId, ...editing } : null,
        card: card.hidden ? null : $('#gameCardTitle').textContent,
      };
    },
  };
}
