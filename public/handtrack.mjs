// 後鏡頭＋手部辨識的生命週期：開鏡頭（getUserMedia）、開 worker（MediaPipe）、每格決定要不要送一張去辨識、收結果。
// - 限頻（預設每秒 20 次）、同時只有一張在辨識；結果回來時已經過期（太久、或鏡頭已經重開過）就丟掉
// - 每張都記下「拍的那一刻頭朝哪裡」，手的位置才換得回世界座標（轉頭時手不會跟著飄）
// - 暫停（切到背景、手機轉直）就停掉鏡頭；恢復時只開一條串流；離開時鏡頭、worker 全部關掉
// 錯誤都有代碼與中文說明（非安全連線、拒絕權限、找不到鏡頭、模型載入失敗…），失敗不影響工坊其他功能。

const ERRORS = {
  insecure: '鏡頭需要安全連線（https 或這台電腦本機）。現在是 http，iPhone 不會開鏡頭。',
  unsupported: '這個瀏覽器不能開鏡頭（沒有 getUserMedia）。',
  denied: '鏡頭權限被拒絕。iPhone：網址列左邊「ᴀA」→ 網站設定 → 相機改成「允許」，再點一下螢幕重試。',
  'no-camera': '找不到可以用的鏡頭。',
  busy: '鏡頭被別的 App 或分頁佔用，關掉它再點一下螢幕重試。',
  'camera-failed': '鏡頭打不開。',
  'worker-failed': '手勢辨識沒辦法在背景執行緒啟動（需要 iOS 17 以上）。',
  'model-missing': '伺服器上還沒有手勢模型檔：在電腦上執行 npm run fetch:models。',
  'model-corrupt': '手勢模型檔損壞（大小或 SHA-256 不符）：在電腦上重新執行 npm run fetch:models。',
  'model-network': '手勢模型下載失敗（網路），點一下螢幕重試。',
  'model-http': '手勢模型下載失敗。',
  'runtime-missing': '手勢辨識程式載入失敗。',
  'runtime-init': '手勢辨識啟動失敗。',
  'no-simd': '這個瀏覽器太舊（WebAssembly 沒有 SIMD，需要 iOS 16.4 以上）。',
  hung: '手勢辨識沒有回應，已經停止。',
};

export function cameraErrorCode(err) {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'no-camera';
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'busy';
  return 'camera-failed';
}

export function createHandTracker({
  win = globalThis,
  doc = globalThis.document,
  now = () => performance.now(),
  makeWorker = () => new Worker('/handworker.mjs', { type: 'module' }),
  maxAgeMs = 350,
  hungMs = 4000,
  onResult = () => {},
  onState = () => {},
} = {}) {
  let state = 'off'; // off → starting → running ⇄ paused；error
  let error = null;
  let gen = 0; // 每次開／關鏡頭加一：舊的結果一律丟掉
  let stream = null;
  let video = null;
  let worker = null;
  let workerReady = null; // Promise
  let rejectWorker = null; // worker 被關掉時，讓還在等它啟動的人收到失敗（不然會永遠等下去）
  let attempt = null; // 正在進行的那一次「開」：{ gen, held（拿到但還沒接管的串流）, abandoned }
  let delegateUsed = null;
  let inflight = null;
  let lastSend = -Infinity;
  let starting = null;
  let opts = { hz: 20, delegate: 'CPU', deviceId: null };
  let restarts = 0;
  const stats = {
    streamsOpened: 0,
    framesSent: 0,
    results: 0,
    stale: 0,
    errors: 0,
    inferMs: 0, // 平均（指數平均）
    latencyMs: 0, // 拍下 → 結果拿到
    hz: 0,
    windowStart: 0,
    windowCount: 0,
    initMs: null,
    camera: null,
  };

  const setState = (s, err = null) => {
    state = s;
    error = err ? { code: err, message: ERRORS[err] || err } : null;
    onState(state, error);
  };

  function ensureVideo() {
    if (video) return video;
    video = doc.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.muted = true;
    video.autoplay = true;
    // iPhone：藏起來（display:none）的影片可能不更新畫格，所以是一個看不到的 1 px
    Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
    video.id = 'handCam';
    doc.body.appendChild(video);
    return video;
  }

  const stopTracks = (s) => {
    for (const t of s?.getTracks?.() || []) t.stop();
  };

  // 放棄正在進行的那一次「開」：已經拿到、還沒接管的串流立刻關掉；之後才拿到的也會直接關
  function abandon(a) {
    if (!a) return;
    a.abandoned = true;
    stopTracks(a.held);
    a.held = null;
    if (attempt === a) attempt = null;
  }

  function stopStream() {
    stopTracks(stream);
    stream = null;
    if (video) {
      video.pause?.();
      video.srcObject = null;
    }
  }

  function startWorker() {
    if (workerReady) return workerReady;
    workerReady = new Promise((resolve, reject) => {
      rejectWorker = reject;
      let w;
      try {
        w = makeWorker();
      } catch (e) {
        reject(Object.assign(new Error(e.message), { code: 'worker-failed' }));
        return;
      }
      worker = w;
      const t0 = now();
      w.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'ready') {
          delegateUsed = m.delegate;
          stats.initMs = Math.round(now() - t0);
          rejectWorker = null;
          resolve();
        } else if (m.type === 'error' && m.stage === 'init') reject(Object.assign(new Error(m.message), { code: m.code || 'runtime-init' }));
        else onWorkerMessage(m);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        reject(Object.assign(new Error(e.message || 'worker error'), { code: 'worker-failed' }));
      };
      w.postMessage({ type: 'init', delegate: opts.delegate, numHands: 2 });
    });
    return workerReady;
  }

  function killWorker() {
    if (worker) {
      try {
        worker.postMessage({ type: 'close' });
      } catch {
        /* 已經結束 */
      }
      worker.terminate();
    }
    rejectWorker?.(Object.assign(new Error('stopped'), { code: 'stopped' }));
    rejectWorker = null;
    worker = null;
    workerReady = null;
    inflight = null;
  }

  async function openCamera() {
    if (!win.isSecureContext) throw Object.assign(new Error('insecure'), { code: 'insecure' });
    const md = win.navigator?.mediaDevices;
    if (!md?.getUserMedia) throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
    const video = opts.deviceId
      ? { deviceId: { exact: opts.deviceId } }
      : { facingMode: { ideal: 'environment' } };
    Object.assign(video, { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } });
    try {
      return await md.getUserMedia({ audio: false, video });
    } catch (e) {
      throw Object.assign(e, { code: cameraErrorCode(e) });
    }
  }

  // 開鏡頭＋worker（同時進行）。重複呼叫會等同一次，不會開兩條串流。
  // 拿到的每一條串流都一定有人負責：接管成目前的 stream，否則立刻關掉——
  // worker 先失敗、鏡頭先成功但 worker 後失敗、權限視窗還開著就被暫停／停止、重開後舊的那次才拿到，都一樣。
  // 每一次「開」有自己的 attempt：舊的晚到只會關掉自己拿到的那條，不會碰到新的串流
  function start(next = {}) {
    opts = { ...opts, ...next };
    if (state === 'running') return Promise.resolve(true);
    if (starting) return starting;
    const myGen = ++gen;
    const a = { gen: myGen, held: null, abandoned: false };
    attempt = a;
    setState('starting');
    const cam = openCamera().then((s) => {
      if (a.abandoned || myGen !== gen) stopTracks(s); // 已經放棄了：晚到的直接關
      else a.held = s;
      return s;
    });
    starting = (async () => {
      try {
        await Promise.all([cam, startWorker()]);
        if (myGen !== gen || a.abandoned) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        const s = a.held;
        a.held = null; // 接管
        if (attempt === a) attempt = null;
        stream = s;
        stats.streamsOpened += 1;
        const v = ensureVideo();
        v.srcObject = s;
        await v.play().catch(() => {});
        if (myGen !== gen) return false; // 播放途中被暫停／停止：那時 stopStream 已經關了這條
        const track = s.getVideoTracks()[0];
        const st = track?.getSettings?.() || {};
        stats.camera = { label: track?.label || '', facingMode: st.facingMode || null, width: st.width || v.videoWidth, height: st.height || v.videoHeight, deviceId: st.deviceId || null };
        track?.addEventListener?.('ended', () => {
          if (stream === s && state === 'running') {
            stopStream();
            setState('error', 'camera-failed');
          }
        });
        restarts = 0;
        setState('running');
        return true;
      } catch (e) {
        abandon(a); // 鏡頭先成功、另一邊失敗（或被取消）：還沒接管的那條關掉；之後才到的也會被關
        if (myGen !== gen) return false;
        stopStream();
        const code = e.code || 'camera-failed';
        if (code.startsWith('model') || code.startsWith('runtime') || code === 'worker-failed' || code === 'no-simd') killWorker();
        setState('error', code);
        return false;
      } finally {
        if (myGen === gen) starting = null;
      }
    })();
    return starting;
  }

  // 暫停：關鏡頭（燈會熄），模型留著，恢復時快一點
  function pause() {
    if (state !== 'running' && state !== 'starting') return;
    gen += 1;
    starting = null;
    inflight = null;
    abandon(attempt); // 權限視窗還開著、或 worker 還在啟動：拿到的那條也要關
    stopStream();
    setState('paused');
  }

  function stop() {
    gen += 1;
    starting = null;
    abandon(attempt);
    stopStream();
    killWorker();
    if (video) {
      video.remove();
      video = null;
    }
    setState('off');
  }

  function onWorkerMessage(m) {
    if (m.type !== 'result' && m.type !== 'error') return;
    const req = inflight;
    if (!req || req.seq !== m.seq) {
      stats.stale += 1; // 已經被放棄的那一張
      return;
    }
    inflight = null;
    if (m.type === 'error') {
      stats.errors += 1;
      return;
    }
    const t = now();
    stats.results += 1;
    stats.inferMs = stats.inferMs ? stats.inferMs * 0.85 + m.ms * 0.15 : m.ms;
    const age = t - req.captureT;
    if (req.gen !== gen || age > maxAgeMs) {
      stats.stale += 1;
      return;
    }
    stats.latencyMs = stats.latencyMs ? stats.latencyMs * 0.85 + age * 0.15 : age;
    stats.windowCount += 1;
    if (t - stats.windowStart > 1000) {
      stats.hz = Math.round((stats.windowCount * 1000) / (t - stats.windowStart || 1));
      stats.windowStart = t;
      stats.windowCount = 0;
    }
    onResult({ t: req.captureT, hands: m.hands, width: req.width, height: req.height, headQ: req.headQ, receivedAt: t });
  }

  // 每格呼叫：該送下一張了，就把現在的畫格（＋拍下那一刻的頭部姿勢）送去辨識
  function pump(headQ) {
    if (state !== 'running' || !worker || !video) return;
    const t = now();
    if (inflight) {
      if (t - inflight.sentAt > hungMs) {
        // worker 卡住：重開一次；再卡就停
        inflight = null;
        killWorker();
        if (restarts++ >= 1) {
          stopStream();
          setState('error', 'hung');
          return;
        }
        const g = gen;
        startWorker().catch(() => g === gen && setState('error', 'runtime-init'));
      }
      return;
    }
    if (t - lastSend < 1000 / opts.hz - 2) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    const req = { seq: stats.framesSent + 1, gen, captureT: t, sentAt: t, headQ: headQ ? headQ.clone() : null, width: video.videoWidth, height: video.videoHeight };
    inflight = req;
    lastSend = t;
    stats.framesSent += 1;
    win.createImageBitmap(video).then(
      (bitmap) => {
        if (inflight !== req || req.gen !== gen || !worker) {
          bitmap.close();
          if (inflight === req) inflight = null;
          return;
        }
        worker.postMessage({ type: 'detect', seq: req.seq, ts: req.captureT, bitmap }, [bitmap]);
      },
      () => {
        if (inflight === req) inflight = null;
        stats.errors += 1;
      },
    );
  }

  return {
    start,
    pause,
    stop,
    pump,
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    get video() {
      return video;
    },
    get delegate() {
      return delegateUsed;
    },
    get options() {
      return { ...opts };
    },
    set hz(v) {
      opts.hz = Math.max(5, Math.min(30, Number(v) || 20));
    },
    liveTracks() {
      return stream ? stream.getTracks().filter((t) => t.readyState === 'live').length : 0;
    },
    stats() {
      return { ...stats, state, error: error?.code || null, delegate: delegateUsed, inflight: !!inflight, hzTarget: opts.hz };
    },
    async cameras() {
      try {
        return (await win.navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').map((d) => ({ id: d.deviceId, label: d.label || '鏡頭' }));
      } catch {
        return [];
      }
    },
  };
}

export const HAND_ERRORS = ERRORS;
