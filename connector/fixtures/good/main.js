// 協定測試用作品（stateSchema 1）：方向鍵左右移動籃子接星星，點星星也能直接收。
// connector/fixtures/v2-migrate 是它的第 2 版（stateSchema 2），用來測「保留狀態換版」——這裡的 state 形狀不要隨便改。
const SPEED = 2.2;
const HALF = 1.6; // 籃子能走的範圍 ±HALF
const TOP = 3; // 星星從多高掉下來
const MAX_STARS = 8;

vibe.define({
  init() {
    return { t: 0, score: 0, basketX: 0, stars: [], nextId: 1, spawnIn: 0.5 };
  },

  tick(s, dt, input) {
    const k = (input && input.keys) || {};
    s.t += dt;
    s.basketX = Math.max(-HALF, Math.min(HALF, s.basketX + ((k.right ? 1 : 0) - (k.left ? 1 : 0)) * SPEED * dt));
    s.spawnIn -= dt;
    if (s.spawnIn <= 0 && s.stars.length < MAX_STARS) {
      s.spawnIn = 0.9;
      s.stars.push({ id: s.nextId++, x: (vibe.random() * 2 - 1) * HALF, y: TOP });
    }
    const keep = [];
    for (const st of s.stars) {
      st.y -= 1.2 * dt;
      if (st.y < 0.35 && Math.abs(st.x - s.basketX) < 0.35) s.score += 1; // 接到
      else if (st.y > 0) keep.push(st);
    }
    s.stars = keep;
  },

  view(s) {
    const out = [
      { id: 'floor', shape: 'box', pos: [0, 0.02, 0], size: [3.6, 0.04, 1.2], color: '#1d2433' },
      { id: 'basket', shape: 'cylinder', pos: [s.basketX, 0.15, 0], size: [0.3, 0.25], color: '#c58b4c' },
      { id: 'score', shape: 'text', pos: [0, 2.6, -0.5], size: [0.2], text: `星星 ${s.score}`, color: '#ffffff' },
    ];
    for (const st of s.stars) out.push({ id: `star${st.id}`, shape: 'sphere', pos: [st.x, st.y, 0], size: [0.12], color: '#ffd23f', emissive: '#806010' });
    return out;
  },

  hud(s) {
    return [`接到 ${s.score} 顆星星`, '←→ 移動籃子，或直接點星星'];
  },

  onEvent(s, ev) {
    if (!ev || ev.type !== 'click' || typeof ev.target !== 'string') return;
    const i = s.stars.findIndex((st) => `star${st.id}` === ev.target);
    if (i >= 0) {
      s.stars.splice(i, 1);
      s.score += 1;
    }
  },
});
