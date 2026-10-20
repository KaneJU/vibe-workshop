const COLORS = ['#ffd34d', '#6de5ff', '#fa8cce', '#b69aff'];
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function starLevel(s) { return 1 + Math.floor(s.caught / 5); }
function restart(s) {
  s.caught = 0;
  s.score = 0; s.lives = 3; s.x = 0; s.goal = null;
  s.elapsed = 0; s.spawnIn = 0.6; s.stars = []; s.effects = [];
  s.over = false; s.flash = 0; s.notice = '接住星光！';
}
function effect(s, x, y, color, label) {
  s.effects.push({ id: s.nextId++, x, y, color, label, age: 0 });
  if (s.effects.length > 6) s.effects.shift();
}
vibe.define({
  init() {
    const s = { best: 0, nextId: 1, keys: { action: false } };
    restart(s);
    return s;
  },
  migrate(old, fromSchema) {
    const source = old && typeof old === 'object' ? old : {};
    const s = { best: 0, nextId: 1, keys: { action: false } };
    restart(s);
    // 舊版分數含金星加分，無法還原顆數；保留分數，從更新後累計。
    for (const key of ['score', 'best', 'nextId', 'lives', 'x', 'elapsed', 'spawnIn', 'flash']) {
      if (typeof source[key] === 'number' && Number.isFinite(source[key])) s[key] = source[key];
    }
    s.x = clamp(s.x, -1.8, 1.8);
    s.lives = clamp(Math.floor(s.lives), 0, 3);
    s.goal = typeof source.goal === 'number' && Number.isFinite(source.goal) ? clamp(source.goal, -1.8, 1.8) : null;
    s.over = typeof source.over === 'boolean' ? source.over : s.lives === 0;
    if (typeof source.notice === 'string') s.notice = source.notice.slice(0, 60);
    s.keys = { action: !!(source.keys && source.keys.action === true) };
    if (fromSchema >= 2 && Number.isSafeInteger(source.caught) && source.caught >= 0) s.caught = source.caught;
    if (Array.isArray(source.stars)) s.stars = source.stars.filter(p => p &&
      Number.isSafeInteger(p.id) && p.id >= 0 && Number.isFinite(p.x) && Math.abs(p.x) <= 1.8 &&
      Number.isFinite(p.y) && p.y >= 0 && p.y <= 2.65 && Number.isFinite(p.speed) && p.speed > 0 &&
      Number.isInteger(p.color) && p.color >= 0 && p.color < 4).slice(0, 6).map(p => ({
        id: p.id, x: p.x, y: p.y, speed: p.speed, color: p.color, crossed: p.crossed === true
      }));
    if (Array.isArray(source.effects)) s.effects = source.effects.filter(p => p &&
      Number.isSafeInteger(p.id) && p.id >= 0 && Number.isFinite(p.x) && Math.abs(p.x) <= 2.5 &&
      Number.isFinite(p.y) && p.y >= 0 && p.y <= 3 && Number.isFinite(p.age) && p.age >= 0 && p.age < 0.7 &&
      typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color) && typeof p.label === 'string'
    ).slice(0, 6).map(p => ({ id: p.id, x: p.x, y: p.y, color: p.color, label: p.label.slice(0, 40), age: p.age }));
    s.nextId = Math.max(1, Math.floor(s.nextId), ...s.stars.map(p => p.id + 1), ...s.effects.map(p => p.id + 1));
    return s;
  },
  tick(s, dt, input) {
    const k = (input && input.keys) || {};
    const pressed = !!k.action && !s.keys.action;
    s.keys = { action: !!k.action };
    for (const p of s.effects) p.age += dt;
    s.effects = s.effects.filter(p => p.age < 0.7);
    s.flash = Math.max(0, s.flash - dt);
    if (s.over) {
      if (pressed) restart(s);
      return;
    }
    s.elapsed += dt;
    const dx = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    if (dx) { s.goal = null; s.x = clamp(s.x + dx * 3.5 * dt, -1.8, 1.8); }
    else if (s.goal !== null) {
      s.x += clamp(s.goal - s.x, -3.5 * dt, 3.5 * dt);
      if (Math.abs(s.goal - s.x) < 0.01) s.goal = null;
    }
    const level = Math.min(1, s.elapsed / 75);
    s.spawnIn -= dt;
    if (s.spawnIn <= 0 && s.stars.length < 6) {
      s.spawnIn = 1.15 - 0.4 * level;
      const color = Math.floor(vibe.random() * 4);
      s.stars.push({ id: s.nextId++, x: (Math.floor(vibe.random() * 5) - 2) * 0.9,
        y: 2.65, speed: 0.85 + level * 0.65, color, crossed: false });
    }
    const keep = [];
    for (const star of s.stars) {
      star.y -= (star.speed + (starLevel(s) - 1) * 0.2) * dt;
      if (!star.crossed && star.y <= 0.6) {
        star.crossed = true;
        if (Math.abs(star.x - s.x) <= 0.43) {
          const points = star.color === 0 ? 3 : 1;
          s.caught += 1;
          s.score += points; s.best = Math.max(s.best, s.score);
          s.flash = 0.35; s.notice = points === 3 ? '金星！＋3' : '接到了！＋1';
          effect(s, star.x, 0.7, COLORS[star.color], '+' + points);
          if (s.caught % 5 === 0) {
            s.notice = '升到 ' + starLevel(s) + ' 級！星星加速！';
            s.flash = 0.6;
            effect(s, 0, 1.5, '#fff09b', '升級！Lv.' + starLevel(s));
          }
          continue;
        }
      }
      if (star.y <= 0.19) {
        s.lives -= 1; s.flash = 0.45; s.notice = '漏接了！';
        effect(s, star.x, 0.3, '#ff5c78', '漏接');
        if (s.lives === 0) { s.over = true; break; }
      } else keep.push(star);
    }
    s.stars = s.over ? [] : keep;
  },
  view(s) {
    const out = [
      { id: 'base', shape: 'box', pos: [0, 0.04, 0], size: [4.7, 0.08, 1.8], color: '#101b35' },
      { id: 'back', shape: 'box', pos: [0, 1.45, -0.55], size: [4.7, 2.8, 0.08], color: '#10162b' },
      { id: 'title', shape: 'text', pos: [0, 2.95, -0.45], size: [0.22], text: '接 星 星', color: '#ffe39b' },
      { id: 'rail', shape: 'box', pos: [0, 0.12, -0.02], size: [4.5, 0.04, 0.08], color: '#5086aa', emissive: '#204466' }
    ];
    for (let i = 0; i < 5; i++) {
      out.push({ id: 'tile' + i, shape: 'box', pos: [(i - 2) * 0.9, 0.1, 0.52], size: [0.84, 0.1, 0.7], color: Math.abs(s.x - (i - 2) * 0.9) < 0.44 ? '#326e92' : '#22344e' });
      out.push({ id: 'tileLabel' + i, shape: 'text', pos: [(i - 2) * 0.9, 0.22, 0.7], size: [0.12], text: '移到這裡', color: '#a4cde9' });
    }
    const basketColor = s.flash > 0 ? (s.notice === '漏接了！' ? '#ff5c78' : '#fff09b') : '#43d8cf';
    out.push({ id: 'basket', shape: 'box', pos: [s.x, 0.24, 0], size: [0.86, 0.14, 0.55], color: basketColor });
    out.push({ id: 'basketFront', shape: 'box', pos: [s.x, 0.39, 0.25], size: [0.86, 0.26, 0.06], color: basketColor, emissive: '#164f50' });
    out.push({ id: 'basketBack', shape: 'box', pos: [s.x, 0.39, -0.25], size: [0.86, 0.26, 0.06], color: basketColor });
    for (let i = 0; i < 2; i++) out.push({ id: 'basketSide' + i, shape: 'box', pos: [s.x + (i ? 0.4 : -0.4), 0.39, 0], size: [0.06, 0.26, 0.55], color: basketColor });
    for (const star of s.stars) {
      const color = COLORS[star.color];
      out.push({ id: 'star' + star.id, shape: 'sphere', pos: [star.x, star.y, 0], size: [0.12], color, emissive: color });
      for (let j = 0; j < 5; j++) {
        const angle = j * Math.PI * 2 / 5;
        out.push({ id: 'star' + star.id + 'tip' + j, shape: 'cone', pos: [star.x + Math.sin(angle) * 0.13, star.y + Math.cos(angle) * 0.13, 0], rot: [0, 0, -angle], size: [0.085, 0.22], color, emissive: color });
      }
    }
    for (const p of s.effects) {
      out.push({ id: 'effect' + p.id, shape: 'text', pos: [p.x, p.y + p.age * 0.65, 0.32], size: [0.2], color: p.color, text: p.label, opacity: 1 - p.age / 0.7 });
    }
    if (s.over) {
      out.push({ id: 'over', shape: 'text', pos: [0, 1.9, 0.25], size: [0.24], text: '遊戲結束！得分 ' + s.score, color: '#ffe39b' });
      out.push({ id: 'restart', shape: 'box', pos: [0, 1.2, 0.25], size: [1.5, 0.48, 0.12], color: '#277a88', emissive: '#123f4a' });
      out.push({ id: 'restartLabel', shape: 'text', pos: [0, 1.2, 0.33], size: [0.2], text: '再玩一次', color: '#ffffff' });
    }
    return out;
  },
  hud(s) {
    return [
      '等級 ' + starLevel(s) + '　分數 ' + s.score + '　剩下機會 ' + s.lives + '/3　最高 ' + s.best,
      s.over ? '遊戲結束！空白鍵／⚡ 或點「再玩一次」' : '左右方向鍵移動籃子，也可點地板移動',
      '金星＋3，其他＋1；漏3顆結束；升級進度 ' + (s.caught % 5) + '/5',
      s.over ? '再挑戰一次，接住更多星星！' : s.notice
    ];
  },
  onEvent(s, ev) {
    if (!ev || ev.type !== 'click' || typeof ev.target !== 'string') return;
    if (s.over) {
      if (ev.target === 'restart' || ev.target === 'restartLabel') restart(s);
      return;
    }
    const m = /^tile(?:Label)?([0-4])$/.exec(ev.target);
    if (m) s.goal = (Number(m[1]) - 2) * 0.9;
  }
});
