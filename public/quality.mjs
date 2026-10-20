// 自動畫質（首頁、遊戲房）：一層一層的畫質階梯，慢就往下一階、順了很久才往上一階。
// - 降：每格超過 40 ms 累積 2 秒 → 降一階。先降解析度、影子留到最後才關：關影子第一次要重新編譯 shader
//   （SwiftShader 手機畫面實測那一格卡 1–1.7 秒），而且只省一到兩成；解析度 1 → 0.75 省四成多。
//   很慢的時候一次多降幾階解析度：每格時間大約跟解析度平方成正比，直接挑預估 30 ms 以內的那一階
//   （軟體繪圖每換一次解析度、重新配置畫布就卡 1–5 秒，少換幾次；GPU 上換解析度那一格不到 30 ms）。
// - 升（遲滯）：22 ms 內的格累積 6 秒才升；22–40 ms 的格會倒扣、超過 40 ms 歸零。
//   卡在中間的裝置就停在原地，不會升上去又掉下來。
// - 預算：升上去 15 秒內又被降回來，算那一階失敗一次，下次要等兩倍久（6 → 12 秒）；
//   同一階失敗 2 次，這次就不再試。影子關掉再打開用的是已經編好的 shader，不會再編一次。
// - 開關影子挑時間：canSwitchShadows() 說不行（比賽中）就先記著，等可以的時候（結算、大廳）再換，
//   編譯卡的那一下不會出現在瞄準的時候；換解析度不用編譯 shader，比賽中也照換。
// 不碰 three.js：只算「現在該用哪一階」，真的換解析度／影子交給 apply（app.js），這樣可以單獨測。
export const SLOW = 0.04;
export const FAST = 0.022;
const TARGET = 0.03;
const LADDER = [
  [2, true],
  [1.5, true],
  [1, true],
  [0.75, true],
  [0.75, false],
];

// 這台裝置的階梯：最上面是它自己的像素比（最多 2），往下接比它低的階
export function levelsFor(max) {
  const out = [{ pr: max, shadows: true }];
  for (const [pr, shadows] of LADDER) {
    const last = out[out.length - 1];
    if (pr > last.pr || (pr === last.pr && shadows === last.shadows)) continue;
    out.push({ pr, shadows });
  }
  return out;
}

export function createQuality({ max, apply, canSwitchShadows = () => true, base = 6, budget = 2, retryWindow = 15 }) {
  const levels = levelsFor(max);
  const s = { level: 0, slow: 0, fast: 0, t: 0, upAt: -Infinity, pending: null, win: [], wait: levels.map(() => base), fails: levels.map(() => 0), log: [] };
  const needsSwitch = (level) => levels[level].shadows !== levels[s.level].shadows;
  function go(level, why) {
    const from = levels[s.level];
    s.level = level;
    s.win = [];
    apply(levels[level], from);
    s.log.push({ t: +s.t.toFixed(2), level, ...levels[level], why });
    if (s.log.length > 50) s.log.shift();
  }
  return {
    levels,
    get state() {
      return { level: s.level, ...levels[s.level], max, pending: s.pending === null ? null : { ...levels[s.pending] }, fails: [...s.fails], wait: [...s.wait], log: s.log.map((e) => ({ ...e })) };
    },
    update(dt) {
      s.t += dt;
      s.win.push(Math.min(dt, 0.25));
      if (s.win.length > 40) s.win.shift();
      if (dt > SLOW) {
        s.slow += Math.min(dt, 0.25);
        s.fast = 0;
      } else if (dt < FAST) {
        s.fast += dt;
        s.slow = Math.max(0, s.slow - dt);
      } else {
        s.fast = Math.max(0, s.fast - dt * 3);
      }
      // 等著關影子：可以的時候就換；等的時候變順了 6 秒以上就不用換了
      if (s.pending !== null) {
        if (s.fast > base) s.pending = null;
        else if (canSwitchShadows()) {
          const level = s.pending;
          s.pending = null;
          go(level, 'slow');
        }
        return;
      }
      if (s.slow > 2) {
        s.slow = 0;
        s.fast = 0;
        if (s.level >= levels.length - 1) return;
        if (s.t - s.upAt < retryWindow) {
          s.fails[s.level] += 1;
          s.wait[s.level] *= 2;
        }
        // 這一階的每格時間（中位數，不受偶爾一格卡住影響）→ 解析度要降到哪一階才會在 30 ms 內（影子那一步不跳過）
        const med = [...s.win].sort((a, b) => a - b)[s.win.length >> 1] || SLOW;
        const cur = levels[s.level];
        let next = s.level + 1;
        while (next + 1 < levels.length && levels[next + 1].shadows === cur.shadows && med * (levels[next].pr / cur.pr) ** 2 > TARGET) next += 1;
        if (needsSwitch(next) && !canSwitchShadows()) s.pending = next;
        else go(next, 'slow');
      } else if (s.level > 0 && s.fails[s.level - 1] < budget && s.fast > s.wait[s.level - 1] && (!needsSwitch(s.level - 1) || canSwitchShadows())) {
        s.fast = 0;
        s.upAt = s.t;
        go(s.level - 1, 'fast');
      }
    },
  };
}
