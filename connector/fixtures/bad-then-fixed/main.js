// 協定測試用作品「反應燈」第一版——故意壞掉：init 忘了建立 lamp，tick 第 1 步讀 s.lamp.timer 就丟 TypeError。
// connector 第 1 輪送這一版（伺服器影子試跑會回診斷），第 2 輪改送 attempt2/ 修好的版本。
vibe.define({
  init() {
    return { t: 0, score: 0, misses: 0, keys: { action: false } };
  },

  tick(s, dt, input) {
    const k = (input && input.keys) || {};
    s.t += dt;
    s.lamp.timer -= dt;
    if (s.lamp.timer <= 0) {
      s.lamp.green = !s.lamp.green;
      s.lamp.timer = s.lamp.green ? 0.8 : 1 + vibe.random() * 2;
    }
    if (k.action && !s.keys.action) {
      if (s.lamp.green) s.score += 1;
      else s.misses += 1;
    }
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
});
