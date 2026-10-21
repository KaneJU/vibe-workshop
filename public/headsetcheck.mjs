// 裝盒前檢查（手機還拿在手上、還沒放進紙盒）：一項一項「實測」——安全連線、語音、後鏡頭（含預覽）、動作感測、
// 方向／左右眼、手勢模型、創作者自己的 Codex connector。只有真的測過、而且有結果的才算通過；沒測的標「未測」，
// 不會因為是 https（isSecureContext）就全部打勾。
// - 語音、鏡頭、動作感測都要在按鈕的 click 裡直接開始（iPhone 這時才會跳權限視窗）；戴上之後要說話還是得點螢幕
//   （或紙盒的觸控鈕）——凝視、捏合不是瀏覽器認可的使用者手勢，見 voice.mjs
// - 驗收摘要只在這台裝置上產生（可以複製、下載），只有數字與狀態：裝置／瀏覽器版本、設定、權限、幀時間、辨識延遲；
//   不放影像、聽到的話、cookie、配對碼、token、創作者 id，也不放 connector 的名稱
const STORE = 'vw_headset_check';
export const SESSION_STORE = 'vw_headset_session';

const ICON = { pass: '✅', warn: '⚠️', fail: '❌', untested: '◻️', manual: '👀', na: '—' };
const WORD = { pass: '通過（實測）', warn: '要注意', fail: '沒通過', untested: '未測', manual: '人工確認', na: '不適用' };

// 從 User-Agent 只取瀏覽器與系統的名字、版本（不整串放進摘要）
export function parseUA(ua = '') {
  const m = (re) => ua.match(re);
  let os = 'unknown';
  let osVersion = null;
  let r;
  if ((r = m(/(iPhone|iPad|iPod).*? OS (\d+[_\d]*)/))) {
    os = r[1] === 'iPad' ? 'iPadOS' : 'iOS';
    osVersion = r[2].replace(/_/g, '.');
  } else if ((r = m(/Android (\d+(?:\.\d+)*)/))) {
    os = 'Android';
    osVersion = r[1];
  } else if ((r = m(/Mac OS X (\d+[_.\d]*)/))) {
    os = 'macOS';
    osVersion = r[1].replace(/_/g, '.');
  } else if ((r = m(/Windows NT (\d+(?:\.\d+)*)/))) {
    os = 'Windows';
    osVersion = r[1];
  } else if (/Linux/.test(ua)) os = 'Linux';
  let browser = 'unknown';
  let browserVersion = null;
  if ((r = m(/CriOS\/(\d+(?:\.\d+)*)/))) [browser, browserVersion] = ['Chrome (iOS)', r[1]];
  else if ((r = m(/FxiOS\/(\d+(?:\.\d+)*)/))) [browser, browserVersion] = ['Firefox (iOS)', r[1]];
  else if ((r = m(/EdgiOS\/(\d+(?:\.\d+)*)/))) [browser, browserVersion] = ['Edge (iOS)', r[1]];
  else if ((r = m(/Edg\/(\d+(?:\.\d+)*)/))) [browser, browserVersion] = ['Edge', r[1]];
  else if ((r = m(/Firefox\/(\d+(?:\.\d+)*)/))) [browser, browserVersion] = ['Firefox', r[1]];
  else if ((r = m(/(?:HeadlessChrome|Chrome)\/(\d+(?:\.\d+)*)/))) [browser, browserVersion] = [/HeadlessChrome/.test(ua) ? 'Chrome (headless)' : 'Chrome', r[1]];
  else if ((r = m(/Version\/(\d+(?:\.\d+)*).*Safari/))) [browser, browserVersion] = ['Safari', r[1]];
  else if (/AppleWebKit/.test(ua)) browser = 'WebKit';
  // iPhone 上不是 Safari（Chrome、Firefox、App 內建瀏覽器）都是 WKWebView：語音辨識常常不能用
  const webview = /(iPhone|iPad|iPod)/.test(ua) && !/Safari\//.test(ua);
  return { browser, browserVersion, os, osVersion, mobile: /Mobi|iPhone|iPad|Android/.test(ua), iosWebView: webview };
}

const num = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));

// 一次戴著的紀錄（離開眼鏡模式時存）：只留數字
export function sessionRecord(st, extra = {}) {
  const t = st.tracker || {};
  return {
    at: new Date().toISOString(),
    durationS: num(extra.durationS, 0),
    frames: st.stats?.frames ?? null,
    frameMs: num(st.stats?.frameMs),
    fps: st.stats?.frameMs ? Math.round(1000 / Math.max(1, st.stats.frameMs)) : null,
    pixelRatio: num(st.pixelRatio, 2),
    eyesRendered: st.stereo?.eyesRendered ?? st.stats?.eyesAtEnter ?? null,
    head: st.head ? { state: st.head.state, hz: st.head.hz } : null,
    tracker: { state: t.state ?? null, inferMs: num(t.inferMs), latencyMs: num(t.latencyMs), hz: t.hz ?? null, hzTarget: t.hzTarget ?? null, stale: t.stale ?? null, camera: t.camera ? pick(t.camera, ['width', 'height']) : null, delegate: t.delegate ?? null, initMs: t.initMs ?? null },
    safeDrops: st.stats?.safeDrops ?? 0,
    menu: st.stats?.menu ? { ...st.stats.menu } : null,
    pad: st.stats?.pad ? { presses: st.stats.pad.presses, releases: { ...st.stats.pad.releases } } : null,
    align: st.stats?.align ? { checks: st.stats.align.checks, applied: st.stats.align.applied, lastErrorCm: st.stats.align.lastErrorCm } : null,
    voice: extra.voice ? pick(extra.voice, ['starts', 'gestureStarts', 'nonGestureStarts', 'nonGestureFailures', 'finals', 'cancels', 'watchdogs', 'firstResultMs', 'finalMs']) : null,
  };
}

export function createReadyCheck({ win = window, doc = document, storage = win.localStorage, mode = 'workshop', getSettings = () => ({}), connectorStatus = async () => null, voiceStats = () => null }) {
  let saved = {};
  try {
    saved = JSON.parse(storage?.getItem(STORE) || '{}') || {};
  } catch {
    saved = {};
  }
  const results = {
    voice: saved.voice || null,
    camera: saved.camera || null,
    motion: saved.motion || null,
    eyes: saved.eyes || null,
  };
  let live = {}; // 每次打開都重新量：secure、orientation、handModel、connector、權限
  let box = null;
  let camStream = null;
  let camVideo = null;
  let recog = null;
  let motionOff = null;
  const persist = () => {
    try {
      storage?.setItem(STORE, JSON.stringify(results));
    } catch {
      /* 私密瀏覽 */
    }
  };
  const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
  const md = win.navigator?.mediaDevices;
  const ua = parseUA(win.navigator?.userAgent || '');

  async function permission(name) {
    try {
      const p = await win.navigator.permissions?.query({ name });
      return p?.state || 'unknown';
    } catch {
      return 'unknown'; // Safari 舊版、Firefox 不認得這個名字
    }
  }

  async function measureLive() {
    const host = win.location.hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    live.secure = { status: win.isSecureContext ? 'pass' : 'fail', protocol: win.location.protocol, host: local ? 'this-computer' : /\.local$|^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host) ? 'lan' : 'other', text: win.isSecureContext ? (local ? '安全連線（這台電腦本機）' : '安全連線（https）') : '不是安全連線（http）：iPhone 不給鏡頭、動作感測、語音' };
    const landscape = win.innerWidth > win.innerHeight;
    live.orientation = { status: landscape ? 'pass' : 'warn', landscape, angle: win.screen?.orientation?.angle ?? win.orientation ?? null, type: win.screen?.orientation?.type || null, text: landscape ? '橫放' : '現在是直的：放進紙盒前要橫放（畫面不轉就關掉「直向鎖定」）' };
    live.micPermission = await permission('microphone');
    live.camPermission = await permission('camera');
    try {
      const r = await win.fetch('/vendor/models/hand_landmarker.task', { method: 'HEAD', cache: 'no-store' });
      live.handModel = r.ok ? { status: 'pass', text: '伺服器上有手勢模型' } : { status: 'fail', text: r.status === 404 ? '伺服器上還沒有手勢模型（在電腦上執行 npm run fetch:models）' : `手勢模型讀不到（HTTP ${r.status}）` };
    } catch {
      live.handModel = { status: 'fail', text: '連不到伺服器，讀不到手勢模型' };
    }
    if (mode === 'create') {
      let s = null;
      try {
        s = await connectorStatus();
      } catch {
        s = null;
      }
      live.connector = !s ? { status: 'untested', text: '讀不到 connector 狀態' } : s.online ? { status: 'pass', text: '你的 Codex connector 在線' } : s.paired ? { status: 'warn', text: '已配對，但 connector 沒在跑（在你的電腦執行 run）' } : { status: 'fail', text: '還沒連接你自己的 Codex：可以戴著看、玩，但說了也只會排隊（不會借用別人的 Codex）' };
    } else live.connector = { status: 'na', text: '自由工坊的「打造」是伺服器主人自己的 Codex；用自己的 Codex 請到創作世界' };
  }

  function statusOf(k) {
    if (k === 'secure' || k === 'orientation' || k === 'handModel' || k === 'connector') return live[k]?.status || 'untested';
    if (k === 'voice') {
      if (!SR) return 'fail';
      if (!win.isSecureContext) return 'fail';
      const r = results.voice;
      if (!r) return 'untested';
      return r.ok ? 'pass' : 'fail';
    }
    if (k === 'camera') {
      if (!md?.getUserMedia) return 'fail';
      const r = results.camera;
      if (!r) return 'untested';
      return r.ok ? (r.facingMode && r.facingMode !== 'environment' ? 'warn' : 'pass') : 'fail';
    }
    if (k === 'motion') {
      if (!win.DeviceOrientationEvent) return 'fail';
      const r = results.motion;
      if (!r) return 'untested';
      return r.ok ? 'pass' : 'fail';
    }
    if (k === 'eyes') return results.eyes?.confirmed ? 'manual' : 'untested';
    return 'untested';
  }

  function textOf(k) {
    const r = results[k];
    if (k === 'voice') {
      if (!SR) return '這個瀏覽器沒有語音辨識（iPhone 請用 Safari 本身，不是 App 內建瀏覽器）：可以打字';
      if (!win.isSecureContext) return '要 https 或這台電腦本機才能用語音';
      if (!r) return `還沒試（麥克風權限：${live.micPermission || '未知'}）`;
      if (r.ok) return `聽得到：第一個字 ${r.firstResultMs ?? '—'} ms、整句 ${r.finalMs ?? '—'} ms（${r.chars} 個字，只顯示不保存）`;
      return `沒聽到：${r.error || '沒有結果'}`;
    }
    if (k === 'camera') {
      if (!md?.getUserMedia) return '這個瀏覽器不能開鏡頭';
      if (!r) return `還沒試（鏡頭權限：${live.camPermission || '未知'}）`;
      if (r.ok) return `${r.width}×${r.height}、約 ${r.fps} 張／秒、${r.facingMode === 'environment' ? '後鏡頭' : r.facingMode === 'user' ? '前鏡頭（要的是後鏡頭）' : '分不出前後鏡頭'}`;
      return `打不開：${r.error}`;
    }
    if (k === 'motion') {
      if (!win.DeviceOrientationEvent) return '這個瀏覽器沒有動作感測：戴著只能拖曳畫面看';
      if (!r) return '還沒試';
      if (r.ok) return `收到 ${r.events} 次（約 ${r.hz} 次／秒）`;
      return r.permission === 'denied' ? '動作感測被拒絕：戴著只能拖曳畫面看' : '沒有收到感測訊號（電腦通常沒有）';
    }
    if (k === 'eyes') return results.eyes?.confirmed ? '你確認過：校正圖左眼只看到 L、右眼只看到 R' : '要人看：勾「進去先看校正圖」，戴上後左眼只看到 L、右眼只看到 R';
    return live[k]?.text || '';
  }

  const ROWS = [
    ['secure', '🔒 安全連線'],
    ['voice', '🎙 語音'],
    ['camera', '📷 後鏡頭'],
    ['motion', '🧭 動作感測'],
    ['orientation', '📱 方向'],
    ['eyes', '👀 左右眼'],
    ['handModel', '✋ 手勢模型'],
    ['connector', '🔌 你的 Codex'],
  ];

  function render() {
    if (!box) return;
    const list = box.querySelector('.hs-checks');
    list.innerHTML = ROWS.map(([k, label]) => {
      const s = statusOf(k);
      const btn = { voice: '<button data-act="voice">說一句試試</button>', camera: camStream ? '<button data-act="camstop">關掉預覽</button>' : '<button data-act="camera">開鏡頭預覽</button>', motion: '<button data-act="motion">轉一轉手機</button>', eyes: `<label class="hs-inline"><input type="checkbox" data-act="eyes" ${results.eyes?.confirmed ? 'checked' : ''}/> 看過了</label>` }[k] || '';
      return `<li data-k="${k}" data-s="${s}"><span class="hs-ci">${ICON[s]}</span><b>${label}</b><span class="hs-cs">${WORD[s]}</span><span class="hs-ct">${escapeHtml(textOf(k))}</span>${btn}</li>`;
    }).join('');
    const counts = { pass: 0, manual: 0, warn: 0, fail: 0, untested: 0, na: 0 };
    for (const [k] of ROWS) counts[statusOf(k)] += 1;
    const ok = counts.fail === 0 && counts.untested === 0 && counts.warn === 0;
    box.querySelector('.hs-verdict').textContent = ok ? '都實測過了：可以放進紙盒（仍要戴上確認清楚、舒服）' : `還不能說準備好：通過 ${counts.pass + counts.manual}、要注意 ${counts.warn}、沒通過 ${counts.fail}、未測 ${counts.untested}`;
    box.querySelector('.hs-verdict').className = `hs-verdict ${ok ? 'ok' : 'no'}`;
    list.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.dataset.act;
      if (act === 'eyes') el.onchange = () => {
        results.eyes = el.checked ? { confirmed: true, at: new Date().toISOString() } : null;
        persist();
        render();
      };
      else el.onclick = () => run(act); // 直接在 click 裡（權限視窗）
    });
    if (camVideo) list.querySelector('[data-k="camera"]').appendChild(camVideo);
  }

  function run(act) {
    if (act === 'voice') return testVoice();
    if (act === 'camera') return testCamera();
    if (act === 'camstop') {
      stopCamera();
      return render();
    }
    if (act === 'motion') return testMotion();
  }

  // 語音：在 click 裡直接 start()（第一次會問麥克風與語音辨識權限）；聽到的字只顯示在這裡、不保存
  function testVoice() {
    if (!SR || !win.isSecureContext) return render();
    try {
      recog?.abort();
    } catch {
      /* 不管 */
    }
    const r = new SR();
    recog = r;
    r.lang = 'zh-TW';
    r.interimResults = true;
    r.continuous = false;
    const t0 = win.performance.now();
    const out = { ok: false, firstResultMs: null, finalMs: null, chars: 0, error: null, at: new Date().toISOString(), gesture: win.navigator?.userActivation?.isActive ?? null };
    let text = '';
    const show = (s) => {
      const el = box?.querySelector('[data-k="voice"] .hs-ct');
      if (el) el.textContent = s;
    };
    r.onresult = (ev) => {
      if (out.firstResultMs == null) out.firstResultMs = Math.round(win.performance.now() - t0);
      text = '';
      for (let i = 0; i < ev.results.length; i += 1) {
        text += ev.results[i][0].transcript;
        if (ev.results[i].isFinal) out.finalMs = Math.round(win.performance.now() - t0);
      }
      show(`聽到：「${text}」`);
    };
    r.onerror = (ev) => {
      out.error = ev.error || 'error';
    };
    r.onend = () => {
      if (recog === r) recog = null;
      out.chars = [...text.trim()].length;
      out.ok = out.chars > 0;
      if (!out.ok && !out.error) out.error = '沒有辨識到字';
      results.voice = out;
      persist();
      render();
    };
    try {
      r.start();
      show('🎙 聽著…說一句話（例如「做一顆會跳的球」）');
    } catch (e) {
      recog = null;
      results.voice = { ...out, error: `開不起來：${e.message}` };
      persist();
      render();
    }
  }

  // 鏡頭：在 click 裡直接 getUserMedia（偏好後鏡頭）、放預覽、量 1.5 秒實際幾張／秒；關掉預覽就停掉串流
  async function testCamera() {
    if (!md?.getUserMedia) return render();
    stopCamera();
    const out = { ok: false, width: null, height: null, facingMode: null, fps: null, error: null, at: new Date().toISOString() };
    let stream;
    try {
      stream = await md.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    } catch (e) {
      out.error = e?.name === 'NotAllowedError' ? '鏡頭權限被拒絕（網址列 ᴀA → 網站設定 → 相機）' : e?.name === 'NotFoundError' ? '找不到鏡頭' : `打不開（${e?.name || e?.message || e}）`;
      results.camera = out;
      persist();
      return render();
    }
    camStream = stream;
    const v = doc.createElement('video');
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.autoplay = true;
    v.className = 'hs-preview';
    v.srcObject = stream;
    camVideo = v;
    render();
    try {
      await v.play();
    } catch {
      /* 自動播放被擋：畫面可能是黑的 */
    }
    const s = stream.getVideoTracks()[0]?.getSettings?.() || {};
    let frames = 0;
    const t0 = win.performance.now();
    await new Promise((res) => {
      const done = () => res();
      if (typeof v.requestVideoFrameCallback === 'function') {
        const f = () => {
          frames += 1;
          if (win.performance.now() - t0 < 1500 && camStream === stream) v.requestVideoFrameCallback(f);
          else done();
        };
        v.requestVideoFrameCallback(f);
        win.setTimeout(done, 2500);
      } else {
        let last = -1;
        const id = win.setInterval(() => {
          if (v.currentTime !== last) {
            frames += 1;
            last = v.currentTime;
          }
          if (win.performance.now() - t0 > 1500) {
            win.clearInterval(id);
            done();
          }
        }, 16);
      }
    });
    const secs = Math.max(0.5, (win.performance.now() - t0) / 1000);
    Object.assign(out, { ok: frames > 3 && (v.videoWidth || s.width) > 0, width: v.videoWidth || s.width || null, height: v.videoHeight || s.height || null, facingMode: s.facingMode || null, fps: Math.round(frames / secs) });
    if (!out.ok) out.error = '鏡頭開了但沒有畫面';
    results.camera = out;
    persist();
    render();
  }
  function stopCamera() {
    for (const t of camStream?.getTracks?.() || []) t.stop();
    camStream = null;
    if (camVideo) {
      camVideo.srcObject = null;
      camVideo.remove();
    }
    camVideo = null;
  }

  // 動作感測：iPhone 要在 click 裡直接問權限；量 1.5 秒收到幾次
  function testMotion() {
    const DOE = win.DeviceOrientationEvent;
    if (!DOE) return render();
    motionOff?.();
    const out = { ok: false, events: 0, hz: 0, permission: 'granted', at: new Date().toISOString() };
    const listen = () => {
      const t0 = win.performance.now();
      const on = (e) => {
        if (e.alpha == null && e.beta == null && e.gamma == null) return;
        out.events += 1;
      };
      win.addEventListener('deviceorientation', on);
      const timer = win.setTimeout(finish, 1500);
      function finish() {
        win.removeEventListener('deviceorientation', on);
        win.clearTimeout(timer);
        motionOff = null;
        out.hz = Math.round(out.events / Math.max(0.5, (win.performance.now() - t0) / 1000));
        out.ok = out.events > 0;
        results.motion = out;
        persist();
        render();
      }
      motionOff = finish;
    };
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then(
        (r) => {
          out.permission = r;
          if (r === 'granted') listen();
          else {
            results.motion = out;
            persist();
            render();
          }
        },
        () => {
          out.permission = 'denied';
          results.motion = out;
          persist();
          render();
        },
      );
    } else listen();
  }

  // 驗收摘要：白名單欄位，只有數字與狀態
  function summary() {
    const s = getSettings() || {};
    let session = null;
    try {
      session = JSON.parse(storage?.getItem(SESSION_STORE) || 'null');
    } catch {
      session = null;
    }
    const v = voiceStats?.() || null;
    const checks = {};
    for (const [k] of ROWS) {
      const st = statusOf(k);
      const base = { status: st, text: textOf(k) };
      if (k === 'voice') checks.voice = { ...base, api: !!SR, permission: live.micPermission || 'unknown', measured: results.voice ? pick(results.voice, ['ok', 'firstResultMs', 'finalMs', 'chars', 'error', 'at', 'gesture']) : null };
      else if (k === 'camera') checks.camera = { ...base, api: !!md?.getUserMedia, permission: live.camPermission || 'unknown', measured: results.camera ? pick(results.camera, ['ok', 'width', 'height', 'facingMode', 'fps', 'error', 'at']) : null };
      else if (k === 'motion') checks.motion = { ...base, api: !!win.DeviceOrientationEvent, needsPermission: typeof win.DeviceOrientationEvent?.requestPermission === 'function', measured: results.motion ? pick(results.motion, ['ok', 'events', 'hz', 'permission', 'at']) : null };
      else if (k === 'eyes') checks.eyes = { ...base, measured: results.eyes ? { confirmedByPerson: true, at: results.eyes.at } : null };
      else if (k === 'secure') checks.secure = { ...base, protocol: live.secure?.protocol, host: live.secure?.host };
      else if (k === 'orientation') checks.orientation = { ...base, ...pick(live.orientation, ['landscape', 'angle', 'type']) };
      else checks[k] = base;
    }
    // 凝視／捏合（不是使用者手勢）開始說話：實際試過才有結論
    const g = v || session?.voice || null;
    const gaze = !g || !g.nonGestureStarts ? { status: 'untested', text: '還沒在眼鏡裡用凝視／捏合開始說話過' } : g.nonGestureFailures ? { status: 'fail', text: `凝視／捏合開始說話被瀏覽器擋了 ${g.nonGestureFailures} 次：要點螢幕（或紙盒觸控鈕）` } : { status: 'pass', text: `凝視／捏合開始說話成功 ${g.nonGestureStarts} 次（這個瀏覽器有授權時允許）` };
    const untested = ROWS.filter(([k]) => statusOf(k) === 'untested').map(([, label]) => label.replace(/^\S+\s/, ''));
    if (gaze.status === 'untested') untested.push('凝視／捏合開始說話');
    if (!session) untested.push('戴著的幀時間與辨識延遲（還沒戴過）');
    return {
      format: 'vibe-headset-check/1',
      generatedAt: new Date().toISOString(),
      privacy: '在這台裝置上產生、不上傳；只有數字與狀態（沒有影像、聽到的話、帳號、cookie、配對碼、token）',
      realDevice: '未確認：這是瀏覽器自己量到的能力；裝置與瀏覽器名稱是 User-Agent 自己報的（可以被模擬），是不是真的 iPhone＋紙盒＋鏡片，要由人確認',
      app: { mode },
      device: { ...ua, touch: (win.navigator?.maxTouchPoints || 0) > 0, screen: { width: win.screen?.width ?? null, height: win.screen?.height ?? null, dpr: num(win.devicePixelRatio, 2) }, viewport: { width: win.innerWidth, height: win.innerHeight } },
      checks,
      gazeVoiceStart: gaze,
      settings: { stereo: s.stereo || null, cam: s.cam || null },
      lastSession: session,
      untested,
    };
  }

  function summaryText(o = summary()) {
    const L = [`Vibe 工坊眼鏡模式驗收摘要（${o.generatedAt}）`, `裝置：${o.device.os} ${o.device.osVersion || ''}／${o.device.browser} ${o.device.browserVersion || ''}${o.device.iosWebView ? '（App 內建瀏覽器）' : ''}，畫面 ${o.device.viewport.width}×${o.device.viewport.height} @${o.device.screen.dpr}x`, o.realDevice];
    for (const [k, label] of ROWS) L.push(`${ICON[o.checks[k].status]} ${label}：${WORD[o.checks[k].status]}｜${o.checks[k].text}`);
    L.push(`${ICON[o.gazeVoiceStart.status]} 凝視／捏合開始說話：${WORD[o.gazeVoiceStart.status]}｜${o.gazeVoiceStart.text}`);
    if (o.lastSession) {
      const ss = o.lastSession;
      L.push(`上次戴著（${ss.at}，${ss.durationS ?? '—'} 秒）：畫面 ${ss.frameMs ?? '—'} ms（${ss.fps ?? '—'} fps）、解析度 ×${ss.pixelRatio ?? '—'}、手勢辨識 ${ss.tracker?.inferMs ?? '—'} ms／延遲 ${ss.tracker?.latencyMs ?? '—'} ms（${ss.tracker?.hz ?? '—'}/${ss.tracker?.hzTarget ?? '—'} 次/秒）、頭部 ${ss.head?.state ?? '—'} ${ss.head?.hz ?? '—'} Hz、語音第一個字 ${ss.voice?.firstResultMs ?? '—'} ms／整句 ${ss.voice?.finalMs ?? '—'} ms`);
    }
    const c = o.settings.cam || {};
    const st = o.settings.stereo || {};
    L.push(`設定：鏡片 ${st.preset ?? '—'}、瞳距 ${st.ipdMm ?? '—'} mm、鏡片中心距 ${st.lensSepMm ?? '—'} mm、鏡片到螢幕 ${st.screenToLensMm ?? '—'} mm、鏡頭偏移 左右 ${c.offsetX ?? '—'}／上下 ${c.offsetY ?? '—'}／前後 ${c.offsetZ ?? '—'} m`);
    L.push(`未測：${o.untested.length ? o.untested.join('、') : '無'}`);
    return L.join('\n');
  }

  function mount(container) {
    box = doc.createElement('section');
    box.className = 'hs-ready';
    box.id = 'hsReady';
    box.innerHTML = `<h3>裝盒前檢查（手機還在手上時一項一項試）</h3>
      <ul class="hs-checks"></ul>
      <p class="hs-verdict"></p>
      <p class="hs-note">戴上之後：<b>點一下螢幕</b>（或紙盒的觸控鈕）開始／停止說話；低頭的選單用盯著或捏一下操作。凝視、捏合不是瀏覽器認可的「使用者手勢」，有些瀏覽器只接受點螢幕才開始聽。</p>
      <div class="hs-btns"><button id="hsSummary">📋 驗收摘要</button></div>
      <div id="hsSummaryBox" hidden><pre></pre><div class="hs-btns"><button id="hsCopy">複製</button><button id="hsDownload">下載 JSON</button></div></div>`;
    container.appendChild(box);
    box.querySelector('#hsSummary').onclick = () => {
      const o = summary();
      const sb = box.querySelector('#hsSummaryBox');
      sb.hidden = false;
      sb.querySelector('pre').textContent = summaryText(o);
      box.querySelector('#hsCopy').onclick = () => win.navigator.clipboard?.writeText(`${summaryText(o)}\n\n${JSON.stringify(o, null, 2)}`).catch(() => {});
      box.querySelector('#hsDownload').onclick = () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' }));
        const a = doc.createElement('a');
        a.href = url;
        a.download = `vibe-headset-check-${o.generatedAt.slice(0, 10)}.json`;
        a.click();
        win.setTimeout(() => URL.revokeObjectURL(url), 2000);
      };
    };
    render();
    measureLive().then(render);
  }

  // 關掉面板、要戴上了：預覽的鏡頭、還在聽的語音、量到一半的感測全部停掉（鏡頭要讓給手勢辨識）
  function stopAll() {
    stopCamera();
    try {
      recog?.abort();
    } catch {
      /* 不管 */
    }
    recog = null;
    motionOff?.();
    box = null;
  }

  return { mount, stopAll, summary, summaryText, get results() {
    return results;
  }, measureLive, statusOf };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
