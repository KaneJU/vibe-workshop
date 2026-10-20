// 顏色配對球：上方的大燈顯示「目標顏色」，點一顆同色的球得分（連續答對有加分），點錯少一條命。
// 也能用方向鍵 ←→ 移動選取圈、按 action 選球——電腦、手機、眼鏡（捏＝點）都能玩。
// 60 秒一局；時間到或命用完就結束，按 action 或點「再玩一次」重來。

const COLORS = [
  { name: '紅', hex: '#ff4d5e' },
  { name: '黃', hex: '#ffd23f' },
  { name: '綠', hex: '#3ddc84' },
  { name: '藍', hex: '#4da3ff' },
  { name: '紫', hex: '#b46bff' },
];
const SLOTS = 6; // 球的數量（排成一道弧）
const ROUND_TIME = 60; // 一局幾秒
const LIVES = 3;
const BALL_R = 0.2;
const SHUFFLE_EVERY = 4; // 每幾秒有一顆球換顏色
const POP_TIME = 0.5; // 打中後的爆開效果幾秒
const MAX_POPS = 8;

// 第 i 個位置：在玩家前方排成一道弧（玩家大約在 z=4 看向原點），上下輕輕浮動
function slotPos(i, t) {
  const a = (i / (SLOTS - 1) - 0.5) * 1.9;
  return [Math.sin(a) * 1.6, 1.05 + Math.sin(t * 1.7 + i * 1.3) * 0.08, 0.9 - Math.cos(a) * 1.6];
}

function newBall(s, slot) {
  return { id: s.nextId++, slot, c: Math.floor(vibe.random() * COLORS.length), born: s.t };
}

// 目標顏色只從場上現有的顏色挑，保證一定有答案
function pickTarget(s) {
  const have = s.balls.map((b) => b.c);
  s.target = have[Math.floor(vibe.random() * have.length)];
}

function restart(s) {
  s.phase = 'play';
  s.score = 0;
  s.combo = 0;
  s.lives = LIVES;
  s.timeLeft = ROUND_TIME;
  s.shuffleIn = SHUFFLE_EVERY;
  s.balls = [];
  for (let i = 0; i < SLOTS; i += 1) s.balls.push(newBall(s, i));
  pickTarget(s);
}

function endRound(s) {
  s.phase = 'over';
  s.best = Math.max(s.best, s.score);
}

function pick(s, slot) {
  if (s.phase !== 'play') return;
  const b = s.balls[slot];
  if (!b) return;
  if (b.c === s.target) {
    s.combo += 1;
    s.score += 1 + Math.min(4, Math.floor(s.combo / 3)); // 每連續答對 3 顆，多加 1 分
    const p = slotPos(slot, s.t);
    s.pops.push({ id: s.nextId++, x: p[0], y: p[1], z: p[2], c: COLORS[b.c].hex, age: 0 });
    if (s.pops.length > MAX_POPS) s.pops.shift();
    s.balls[slot] = newBall(s, slot);
    s.flash = 0.35;
    s.flashOk = true;
    pickTarget(s);
  } else {
    s.combo = 0;
    s.lives -= 1;
    s.flash = 0.35;
    s.flashOk = false;
    if (s.lives <= 0) endRound(s);
  }
}

vibe.define({
  init() {
    const s = { phase: 'play', t: 0, score: 0, best: 0, combo: 0, lives: LIVES, timeLeft: ROUND_TIME, shuffleIn: SHUFFLE_EVERY, target: 0, cursor: 0, balls: [], pops: [], nextId: 1, flash: 0, flashOk: true, keys: { left: false, right: false, action: false } };
    restart(s);
    return s;
  },

  tick(s, dt, input) {
    const k = (input && input.keys) || {};
    const pressed = (name) => !!k[name] && !s.keys[name]; // 這一步才按下去（不是一直按著）
    s.t += dt;
    s.flash = Math.max(0, s.flash - dt);
    for (const p of s.pops) p.age += dt;
    s.pops = s.pops.filter((p) => p.age < POP_TIME);

    if (s.phase === 'play') {
      if (pressed('left')) s.cursor = (s.cursor + SLOTS - 1) % SLOTS;
      if (pressed('right')) s.cursor = (s.cursor + 1) % SLOTS;
      if (pressed('action')) pick(s, s.cursor);
      s.timeLeft -= dt;
      if (s.timeLeft <= 0) {
        s.timeLeft = 0;
        endRound(s);
      }
      s.shuffleIn -= dt;
      if (s.shuffleIn <= 0) {
        s.shuffleIn = SHUFFLE_EVERY;
        const b = s.balls[Math.floor(vibe.random() * SLOTS)];
        b.c = Math.floor(vibe.random() * COLORS.length);
        if (!s.balls.some((x) => x.c === s.target)) pickTarget(s);
      }
    } else if (pressed('action')) restart(s);

    s.keys = { left: !!k.left, right: !!k.right, action: !!k.action };
  },

  view(s) {
    const out = [];
    const ok = s.flashOk ? '#3ddc84' : '#ff4d5e';
    out.push({ id: 'base', shape: 'cylinder', pos: [0, 0.05, 0], size: [2.2, 0.1], color: s.flash > 0 ? ok : '#1d2433', emissive: s.flash > 0 ? ok : '#000000' });
    const tc = COLORS[s.target].hex;
    out.push({ id: 'target', shape: 'sphere', pos: [0, 2.15, -0.6], size: [0.3], color: tc, emissive: tc });
    out.push({ id: 'targetRing', shape: 'torus', pos: [0, 2.15, -0.6], size: [0.42, 0.03], color: '#ffffff', emissive: '#555555' });
    out.push({ id: 'targetLabel', shape: 'text', pos: [0, 2.68, -0.6], size: [0.16], text: s.phase === 'play' ? `點${COLORS[s.target].name}色的球` : '時間到！', color: '#ffffff' });

    for (const b of s.balls) {
      const grow = Math.min(1, (s.t - b.born) * 4); // 新的球從小長大
      out.push({ id: `ball${b.id}`, shape: 'sphere', pos: slotPos(b.slot, s.t), size: [BALL_R * (0.3 + 0.7 * grow)], color: COLORS[b.c].hex });
    }
    if (s.phase === 'play') out.push({ id: 'cursor', shape: 'torus', pos: slotPos(s.cursor, s.t), size: [BALL_R + 0.07, 0.02], color: '#ffffff', emissive: '#888888' });
    for (const p of s.pops) {
      const f = p.age / POP_TIME;
      out.push({ id: `pop${p.id}`, shape: 'sphere', pos: [p.x, p.y, p.z], size: [BALL_R * (1 + f * 1.5)], color: p.c, emissive: p.c, opacity: Math.max(0, 0.7 * (1 - f)) });
    }

    const frac = Math.max(0, s.timeLeft / ROUND_TIME);
    out.push({ id: 'timerBack', shape: 'box', pos: [0, 0.35, 0.9], size: [2, 0.08, 0.04], color: '#333a4a' });
    out.push({ id: 'timer', shape: 'box', pos: [-(1 - frac), 0.35, 0.92], size: [Math.max(0.01, 2 * frac), 0.1, 0.05], color: frac > 0.25 ? '#3ddc84' : '#ff4d5e', emissive: '#202020' });
    out.push({ id: 'score', shape: 'text', pos: [0, 0.6, 0.9], size: [0.14], text: `分數 ${s.score}${s.combo >= 3 ? `　連擊 ×${s.combo}` : ''}`, color: '#ffffff' });
    for (let i = 0; i < LIVES; i += 1) {
      out.push({ id: `life${i}`, shape: 'sphere', pos: [-1.3 + i * 0.2, 0.6, 0.9], size: [0.06], color: i < s.lives ? '#ff4d5e' : '#444444' });
    }
    if (s.phase === 'over') {
      out.push({ id: 'restart', shape: 'box', pos: [0, 1.0, 0.6], size: [0.9, 0.3, 0.08], color: '#38e1ff', emissive: '#0b4f5c' });
      out.push({ id: 'restartLabel', shape: 'text', pos: [0, 1.0, 0.66], size: [0.12], text: '再玩一次', color: '#ffffff' });
    }
    return out;
  },

  hud(s) {
    if (s.phase === 'over') return [`這局 ${s.score} 分（最高 ${s.best} 分）`, '按 action 或點「再玩一次」重新開始'];
    return [`分數 ${s.score}　連擊 ×${s.combo}　生命 ${'♥'.repeat(s.lives)}`, `目標：${COLORS[s.target].name}色　剩 ${Math.ceil(s.timeLeft)} 秒`, '點同色的球；或用 ←→ 選、action 確定'];
  },

  onEvent(s, ev) {
    if (!ev || ev.type !== 'click' || typeof ev.target !== 'string') return; // 按鍵在 tick 的 input.keys 處理
    if (ev.target === 'restart' || ev.target === 'restartLabel') {
      if (s.phase === 'over') restart(s);
      return;
    }
    const m = /^ball(\d+)$/.exec(ev.target);
    if (!m) return;
    const slot = s.balls.findIndex((b) => b.id === Number(m[1]));
    if (slot >= 0) {
      s.cursor = slot;
      pick(s, slot);
    }
  },

  // 存檔不用存爆開效果（短暫的畫面效果）
  snapshot(s) {
    return { ...s, pops: [] };
  },
});
