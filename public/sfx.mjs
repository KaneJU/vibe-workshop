// 音效（很小聲、短促）：用 WebAudio 現場合成，沒有音檔。只有玩家自己按了（開火、命中）才會響，不會自動播放；
// 可以靜音（記在這台裝置上）。每個聲音用完就丟，不會累積節點。
export function createSfx() {
  let ctx = null;
  let muted = (() => {
    try {
      return localStorage.getItem('vw_sound') === 'off';
    } catch {
      return false;
    }
  })();
  function ac() {
    if (muted) return null;
    try {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    } catch {
      return null;
    }
  }
  function env(g, t0, peak, dur) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }
  let noiseBuf = null;
  function noise(a) {
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, Math.floor(a.sampleRate * 0.2), a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
    }
    const n = a.createBufferSource();
    n.buffer = noiseBuf;
    return n;
  }
  return {
    // 開火：短的「咻」＋一點氣流聲
    fire() {
      const a = ac();
      if (!a) return;
      const t = a.currentTime;
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(220, t + 0.09);
      env(g, t, 0.05, 0.1);
      const f = a.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2400;
      o.connect(f).connect(g).connect(a.destination);
      o.start(t);
      o.stop(t + 0.11);
      const n = noise(a);
      const ng = a.createGain();
      const hp = a.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      env(ng, t, 0.035, 0.06);
      n.connect(hp).connect(ng).connect(a.destination);
      n.start(t);
      n.stop(t + 0.07);
    },
    // 命中：清脆的「叮」
    hit() {
      const a = ac();
      if (!a) return;
      const t = a.currentTime;
      for (const [freq, peak] of [[1320, 0.05], [1980, 0.03]]) {
        const o = a.createOscillator();
        const g = a.createGain();
        o.type = 'triangle';
        o.frequency.value = freq;
        env(g, t, peak, 0.16);
        o.connect(g).connect(a.destination);
        o.start(t);
        o.stop(t + 0.17);
      }
    },
    // 伺服器確認得分：兩個音往上
    score() {
      const a = ac();
      if (!a) return;
      [880, 1175].forEach((freq, i) => {
        const t = a.currentTime + i * 0.07;
        const o = a.createOscillator();
        const g = a.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        env(g, t, 0.05, 0.18);
        o.connect(g).connect(a.destination);
        o.start(t);
        o.stop(t + 0.2);
      });
    },
    get muted() {
      return muted;
    },
    setMuted(v) {
      muted = !!v;
      try {
        localStorage.setItem('vw_sound', muted ? 'off' : 'on');
      } catch {
        /* 私密瀏覽 */
      }
      if (muted && ctx) ctx.suspend?.();
    },
  };
}
