// 躲方塊：方向鍵（手機上是畫面方向鈕）移動地板上的小方塊人；也可以點地板格子，方塊人會自己走過去（眼鏡模式用捏的）。
// 天上會掉方塊，地上的影子告訴你會掉在哪裡、越黑越快到。被砸到少一條命（之後 1 秒無敵、會閃）；
// 撐越久分數越高，越後面掉得越快越密。action 是短衝刺（有冷卻）；命用完後按 action 或點「再玩一次」重來。

const COLS = 5; // 地板格子：5 欄 × 4 列
const ROWS = 4;
const TILE = 0.8; // 格子邊長（公尺）
const X0 = -((COLS - 1) * TILE) / 2; // 第 0 欄的中心 x
const Z0 = -2.2; // 第 0 列（最遠那列）的中心 z；玩家大約在 z=4 看過來
const HALF_X = (COLS * TILE) / 2;
const Z_MIN = Z0 - TILE / 2;
const Z_MAX = Z0 + (ROWS - 0.5) * TILE;
const FLOOR_Y = 0.04; // 地板上表面
const BODY = 0.36; // 方塊人邊長
const SPEED = 2.4; // 走路速度 m/s
const DASH_SPEED = 6.5;
const DASH_TIME = 0.18;
const DASH_COOLDOWN = 1.5;
const DROP_Y = 6; // 方塊從多高掉下來
const MAX_BLOCKS = 14;
const MAX_SPARKS = 10;
const SPARK_TIME = 0.4;
const LIVES = 3;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const tileCenter = (c, r) => [X0 + c * TILE, Z0 + r * TILE];

function restart(s) {
  s.phase = 'play';
  s.play = 0;
  s.score = 0;
  s.lives = LIVES;
  s.px = 0;
  s.pz = Z0 + (ROWS - 1) * TILE;
  s.dir = [0, -1];
  s.goal = null;
  s.dash = 0;
  s.dashCd = 0;
  s.hurt = 0;
  s.spawnIn = 1.5;
  s.blocks = [];
}

function spark(s, x, z, color) {
  s.sparks.push({ id: s.nextId++, x, z, color, age: 0 });
  if (s.sparks.length > MAX_SPARKS) s.sparks.shift();
}

function spawnBlock(s, level) {
  const aim = vibe.random() < 0.15 + 0.3 * level; // 有時候瞄準方塊人，逼他移動（越後面越常瞄準）
  const size = 0.35 + vibe.random() * 0.35;
  const x = aim ? s.px + (vibe.random() - 0.5) * 0.6 : (vibe.random() * 2 - 1) * (HALF_X - 0.3);
  const z = aim ? s.pz + (vibe.random() - 0.5) * 0.6 : Z_MIN + 0.3 + vibe.random() * (Z_MAX - Z_MIN - 0.6);
  s.blocks.push({ id: s.nextId++, x: clamp(x, -HALF_X + size / 2, HALF_X - size / 2), z: clamp(z, Z_MIN + size / 2, Z_MAX - size / 2), y: DROP_Y, vy: -1 - level * 2, size });
}

vibe.define({
  init() {
    const s = { t: 0, best: 0, nextId: 1, sparks: [], keys: { action: false } };
    restart(s);
    return s;
  },

  tick(s, dt, input) {
    const k = (input && input.keys) || {};
    const pressed = (name) => !!k[name] && !s.keys[name]; // 這一步才按下去
    s.t += dt;
    for (const p of s.sparks) p.age += dt;
    s.sparks = s.sparks.filter((p) => p.age < SPARK_TIME);
    if (s.phase === 'over') {
      if (pressed('action')) restart(s);
      s.keys = { action: !!k.action };
      return;
    }

    s.play += dt;
    const level = Math.min(1, s.play / 90); // 90 秒內難度從 0 升到 1
    s.score += dt * (1 + level);

    // 移動：方向鍵優先；沒按鍵時走向點過的格子
    let mx = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    let mz = (k.down ? 1 : 0) - (k.up ? 1 : 0); // up＝往前（離玩家遠，-z）
    if (mx || mz) s.goal = null;
    else if (s.goal) {
      const gx = s.goal[0] - s.px;
      const gz = s.goal[1] - s.pz;
      if (Math.hypot(gx, gz) < 0.05) s.goal = null;
      else {
        mx = gx;
        mz = gz;
      }
    }
    const len = Math.hypot(mx, mz);
    if (len > 0) s.dir = [mx / len, mz / len];
    if (pressed('action') && s.dashCd <= 0) {
      s.dash = DASH_TIME;
      s.dashCd = DASH_COOLDOWN;
    }
    const speed = s.dash > 0 ? DASH_SPEED : len > 0 ? SPEED : 0;
    s.px = clamp(s.px + s.dir[0] * speed * dt, -HALF_X + BODY / 2, HALF_X - BODY / 2);
    s.pz = clamp(s.pz + s.dir[1] * speed * dt, Z_MIN + BODY / 2, Z_MAX - BODY / 2);
    s.dash = Math.max(0, s.dash - dt);
    s.dashCd = Math.max(0, s.dashCd - dt);
    s.hurt = Math.max(0, s.hurt - dt);

    // 掉方塊
    s.spawnIn -= dt;
    if (s.spawnIn <= 0 && s.blocks.length < MAX_BLOCKS) {
      s.spawnIn = 1.4 - level * 0.95; // 1.4 秒一顆 → 0.45 秒一顆
      spawnBlock(s, level);
    }
    const g = 4 + level * 6;
    const keep = [];
    for (const b of s.blocks) {
      b.vy -= g * dt;
      b.y += b.vy * dt;
      const over = Math.abs(b.x - s.px) < (b.size + BODY) / 2 && Math.abs(b.z - s.pz) < (b.size + BODY) / 2;
      if (over && b.y < FLOOR_Y + BODY && s.hurt <= 0) {
        s.lives -= 1;
        s.hurt = 1;
        spark(s, s.px, s.pz, '#ff4d5e');
        if (s.lives <= 0) {
          s.phase = 'over';
          s.best = Math.max(s.best, Math.floor(s.score));
        }
        continue;
      }
      if (b.y <= FLOOR_Y) {
        spark(s, b.x, b.z, '#ffb347');
        continue;
      }
      keep.push(b);
    }
    s.blocks = keep;
    s.keys = { action: !!k.action };
  },

  view(s) {
    const out = [];
    for (let r = 0; r < ROWS; r += 1) {
      for (let c = 0; c < COLS; c += 1) {
        const [x, z] = tileCenter(c, r);
        out.push({ id: `tile${c}_${r}`, shape: 'box', pos: [x, FLOOR_Y / 2, z], size: [TILE - 0.03, FLOOR_Y, TILE - 0.03], color: (c + r) % 2 ? '#2a3348' : '#232b3d' });
      }
    }
    const zc = (Z_MIN + Z_MAX) / 2;
    const zl = Z_MAX - Z_MIN;
    out.push({ id: 'railL', shape: 'box', pos: [-HALF_X - 0.04, 0.06, zc], size: [0.06, 0.12, zl], color: '#38e1ff', emissive: '#0e5866' });
    out.push({ id: 'railR', shape: 'box', pos: [HALF_X + 0.04, 0.06, zc], size: [0.06, 0.12, zl], color: '#38e1ff', emissive: '#0e5866' });
    out.push({ id: 'railB', shape: 'box', pos: [0, 0.06, Z_MIN - 0.04], size: [HALF_X * 2 + 0.14, 0.12, 0.06], color: '#38e1ff', emissive: '#0e5866' });

    const blink = s.hurt > 0 && Math.floor(s.hurt * 10) % 2 === 0;
    const py = FLOOR_Y + BODY / 2 + (s.dash > 0 ? 0.08 : 0);
    out.push({ id: 'hero', shape: 'box', pos: [s.px, py, s.pz], size: [BODY, BODY, BODY], color: s.dash > 0 ? '#9ff3ff' : '#38e1ff', emissive: s.dash > 0 ? '#1d7f8f' : '#000000', opacity: blink ? 0.35 : 1 });
    out.push({ id: 'eyeL', shape: 'box', pos: [s.px - 0.08, py + 0.06, s.pz + BODY / 2 + 0.01], size: [0.06, 0.08, 0.02], color: '#0b1020' });
    out.push({ id: 'eyeR', shape: 'box', pos: [s.px + 0.08, py + 0.06, s.pz + BODY / 2 + 0.01], size: [0.06, 0.08, 0.02], color: '#0b1020' });

    for (const b of s.blocks) {
      out.push({ id: `blk${b.id}`, shape: 'box', pos: [b.x, b.y + b.size / 2, b.z], rot: [0, b.y * 0.6, 0], size: [b.size, b.size, b.size], color: b.size > 0.55 ? '#ff7043' : '#ffb347' });
      const near = 1 - Math.min(1, b.y / DROP_Y); // 越接近地面影子越黑
      out.push({ id: `shd${b.id}`, shape: 'cylinder', pos: [b.x, FLOOR_Y + 0.005, b.z], size: [b.size * 0.6, 0.01], color: '#000000', opacity: 0.15 + 0.6 * near });
    }
    for (const p of s.sparks) {
      const f = p.age / SPARK_TIME;
      out.push({ id: `spk${p.id}`, shape: 'sphere', pos: [p.x, FLOOR_Y + 0.15, p.z], size: [0.15 + f * 0.35], color: p.color, emissive: p.color, opacity: Math.max(0, 0.8 * (1 - f)) });
    }

    out.push({ id: 'score', shape: 'text', pos: [0, 1.9, Z_MIN - 0.1], size: [0.22], text: `分數 ${Math.floor(s.score)}`, color: '#ffffff' });
    for (let i = 0; i < LIVES; i += 1) out.push({ id: `life${i}`, shape: 'sphere', pos: [-0.25 + i * 0.25, 1.6, Z_MIN - 0.1], size: [0.07], color: i < s.lives ? '#ff4d5e' : '#444444' });
    if (s.phase === 'over') {
      out.push({ id: 'overLabel', shape: 'text', pos: [0, 1.35, 0], size: [0.18], text: '被砸扁了！', color: '#ffd23f' });
      out.push({ id: 'restart', shape: 'box', pos: [0, 0.95, 0.2], size: [0.9, 0.3, 0.08], color: '#38e1ff', emissive: '#0b4f5c' });
      out.push({ id: 'restartLabel', shape: 'text', pos: [0, 0.95, 0.26], size: [0.12], text: '再玩一次', color: '#ffffff' });
    }
    return out;
  },

  hud(s) {
    const hearts = `${'♥'.repeat(Math.max(0, s.lives))}${'♡'.repeat(LIVES - Math.max(0, s.lives))}`;
    if (s.phase === 'over') return [`撐了 ${Math.floor(s.score)} 分（最高 ${s.best} 分）`, '按 action 或點「再玩一次」重新開始'];
    return [`分數 ${Math.floor(s.score)}　生命 ${hearts}　最高 ${s.best}`, `方向鍵或點格子移動・action 衝刺${s.dashCd > 0 ? `（冷卻 ${s.dashCd.toFixed(1)} 秒）` : '（可用）'}`, '看地上的影子，別站在方塊底下！'];
  },

  onEvent(s, ev) {
    if (!ev || ev.type !== 'click' || typeof ev.target !== 'string') return; // 按鍵在 tick 的 input.keys 處理
    if (ev.target === 'restart' || ev.target === 'restartLabel') {
      if (s.phase === 'over') restart(s);
      return;
    }
    const m = /^tile(\d+)_(\d+)$/.exec(ev.target);
    if (m && s.phase === 'play') s.goal = tileCenter(Number(m[1]), Number(m[2]));
  },
});
