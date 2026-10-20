// 協定測試用作品「反應燈」修好的版本（connector --fixture 第 2 輪送這一版）：init 建立 lamp；也加上點燈（onEvent）。
function press(s) {
  if (s.lamp.green) {
    s.score += 1;
    s.lamp.green = false; // 按到了就換回紅燈
    s.lamp.timer = 1 + vibe.random() * 2;
  } else s.misses += 1;
}

vibe.define({
  init() {
    return { t: 0, score: 0, misses: 0, lamp: { green: false, timer: 1.5 }, keys: { action: false } };
  },

  tick(s, dt, input) {
    const k = (input && input.keys) || {};
    s.t += dt;
    s.lamp.timer -= dt;
    if (s.lamp.timer <= 0) {
      s.lamp.green = !s.lamp.green;
      s.lamp.timer = s.lamp.green ? 0.8 : 1 + vibe.random() * 2;
    }
    if (k.action && !s.keys.action) press(s);
    s.keys = { action: !!k.action };
  },

  view(s) {
    return [
      { id: 'pole', shape: 'cylinder', pos: [0, 0.6, 0], size: [0.05, 1.2], color: '#555555' },
      { id: 'lamp', shape: 'sphere', pos: [0, 1.35, 0], size: [0.25], color: s.lamp.green ? '#3ddc84' : '#ff4d5e', emissive: s.lamp.green ? '#1d6e42' : '#6e1d26' },
      { id: 'score', shape: 'text', pos: [0, 1.9, 0], size: [0.16], text: `${s.score} 分`, color: '#ffffff' },
    ];
  },

  hud(s) {
    return [`得分 ${s.score}　按錯 ${s.misses}`, '燈變綠時按 action 或點燈'];
  },

  onEvent(s, ev) {
    if (ev && ev.type === 'click' && ev.target === 'lamp') press(s);
  },
});
