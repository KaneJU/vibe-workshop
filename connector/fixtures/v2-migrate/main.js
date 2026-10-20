// 協定測試用作品「接星星」第 2 版（stateSchema 2）：給「保留狀態換版」測試用，能從 connector/fixtures/good（stateSchema 1）的存檔遷移。
// 跟第 1 版的差別：state 的 basketX 變成 basket { x, w }、星星多了下落速度 vy、多了 combo／best／missed——所以 stateSchema 加 1 並寫 migrate。
// 實體 id（floor、basket、score、star<id>）跟第 1 版一樣，換版時畫面上的東西原地更新、不會重建。
const SPEED = 2.2;
const HALF = 1.6;
const TOP = 3;
const MAX_STARS = 8;
const BASE_W = 0.3; // 籃子半徑（沒有連擊時）

vibe.define({
  init() {
    return { t: 0, score: 0, basket: { x: 0, w: BASE_W }, stars: [], nextId: 1, spawnIn: 0.5, combo: 0, best: 0, missed: 0 };
  },

  // 舊存檔 → 新的 state（每個舊欄位都檢查型別，缺的補預設值）
  migrate(old, fromSchema) {
    const s = { t: 0, score: 0, basket: { x: 0, w: BASE_W }, stars: [], nextId: 1, spawnIn: 0.5, combo: 0, best: 0, missed: 0 };
    if (fromSchema === 1 && old && typeof old === 'object') {
      s.t = Number(old.t) || 0;
      s.score = Number(old.score) || 0;
      s.best = s.score;
      s.basket.x = Math.max(-HALF, Math.min(HALF, Number(old.basketX) || 0));
      s.stars = (Array.isArray(old.stars) ? old.stars : []).slice(0, MAX_STARS).map((st) => ({ id: Number(st.id) || 0, x: Number(st.x) || 0, y: Number(st.y) || TOP, vy: 1.2 }));
      s.nextId = Math.max(Number(old.nextId) || 1, ...s.stars.map((st) => st.id + 1));
      s.spawnIn = Number(old.spawnIn) || 0.5;
    }
    return s;
  },

  tick(s, dt, input) {
    const k = (input && input.keys) || {};
    s.t += dt;
    s.basket.w = BASE_W + Math.min(0.2, s.combo * 0.02);
    s.basket.x = Math.max(-HALF, Math.min(HALF, s.basket.x + ((k.right ? 1 : 0) - (k.left ? 1 : 0)) * SPEED * dt));
    s.spawnIn -= dt;
    if (s.spawnIn <= 0 && s.stars.length < MAX_STARS) {
      s.spawnIn = 0.9;
      s.stars.push({ id: s.nextId++, x: (vibe.random() * 2 - 1) * HALF, y: TOP, vy: 1.2 + Math.min(1, s.t / 120) });
    }
    const keep = [];
    for (const st of s.stars) {
      st.y -= st.vy * dt;
      if (st.y < 0.35 && Math.abs(st.x - s.basket.x) < s.basket.w + 0.05) {
        s.combo += 1;
        s.score += 1 + Math.floor(s.combo / 5);
        s.best = Math.max(s.best, s.score);
      } else if (st.y > 0) keep.push(st);
      else {
        s.combo = 0;
        s.missed += 1;
      }
    }
    s.stars = keep;
  },

  view(s) {
    const out = [
      { id: 'floor', shape: 'box', pos: [0, 0.02, 0], size: [3.6, 0.04, 1.2], color: '#1d2433' },
      { id: 'basket', shape: 'cylinder', pos: [s.basket.x, 0.15, 0], size: [s.basket.w, 0.25], color: s.combo >= 5 ? '#ffb347' : '#c58b4c' },
      { id: 'score', shape: 'text', pos: [0, 2.6, -0.5], size: [0.2], text: `星星 ${s.score}${s.combo >= 3 ? `　連擊 ${s.combo}` : ''}`, color: '#ffffff' },
    ];
    for (const st of s.stars) out.push({ id: `star${st.id}`, shape: 'sphere', pos: [st.x, st.y, 0], size: [0.12], color: '#ffd23f', emissive: '#806010' });
    return out;
  },

  hud(s) {
    return [`星星 ${s.score}　連擊 ${s.combo}　最高 ${s.best}`, `漏掉 ${s.missed} 顆`, '←→ 移動籃子，或直接點星星'];
  },

  onEvent(s, ev) {
    if (!ev || ev.type !== 'click' || typeof ev.target !== 'string') return;
    const i = s.stars.findIndex((st) => `star${st.id}` === ev.target);
    if (i >= 0) {
      s.stars.splice(i, 1);
      s.combo += 1;
      s.score += 1;
      s.best = Math.max(s.best, s.score);
    }
  },
});
