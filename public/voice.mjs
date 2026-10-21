// 語音輸入（瀏覽器的 SpeechRecognition，zh-TW、單句）：自由工坊的 🎙 與創作世界共用這一份。
// - 每一句話是一個 utterance：開始說的那一刻就把「在哪個世界、選了什麼、要改哪一版」記下來（context），
//   說到一半換世界、換選取，也不會把「這個」指到別的東西
// - 中間結果只拿來顯示（onPartial）；說完的最終結果每句只交出一次（onFinal），網路重送由伺服器用 utteranceId 去重
// - 取消（cancel）就丟掉這句話：當場結束，之後這個辨識器再送來的結果一律不理（離開眼鏡、切到背景時也走這裡，回來不會補送）
// - 停止（stop）後瀏覽器幾秒都沒結束這句，就自己收尾（有聽到的照樣交出一次）；一句最長 maxMs，到了自動停止
// - 不支援、拒絕麥克風都會回報原因，打字照樣能用
// 瀏覽器的語音辨識不一定在本機處理（可能送到瀏覽器廠商的服務）；這裡不另外錄音、不存音檔、不加付費辨識。
// 啟動限制：規格與 WebKit 都要麥克風授權、頁面看得見；被拒過或很久沒用時，瀏覽器要真的點擊／按鍵才會再問——
// 凝視、捏合（鏡頭手勢）不是瀏覽器認可的使用者手勢，start() 會記下「這次有沒有使用者手勢」（stats），失敗就改請使用者點螢幕。
const uid = () => (globalThis.crypto?.randomUUID?.() || `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`).replace(/[^\w-]/g, '');

export const VOICE_ERRORS = {
  unsupported: '這個瀏覽器不支援語音辨識，請改用打字',
  insecure: '語音要安全連線（https 或這台電腦本機）；現在請改用打字',
  'not-allowed': '麥克風被拒絕：請到瀏覽器網站設定允許麥克風，或改用打字',
  'service-not-allowed': '這個瀏覽器不讓網頁用語音辨識，請改用打字',
  'no-speech': '沒有聽到聲音，再說一次',
  'audio-capture': '找不到麥克風',
  network: '語音辨識連不上服務（網路）',
  aborted: '',
};

export function createVoice({ win = globalThis, lang = 'zh-TW', onPartial = () => {}, onFinal = () => {}, onState = () => {}, onError = () => {}, now = () => Date.now(), stopGraceMs = 4000, maxMs = 20000 } = {}) {
  const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
  const why = !SR ? 'unsupported' : !win.isSecureContext ? 'insecure' : null;
  let recog = null;
  let cur = null; // { id, context, finalText, cancelled, delivered, ended }
  // 只有數字與代碼（給裝盒前檢查與驗收摘要）：不存聽到的字、不存聲音
  const stats = { starts: 0, gestureStarts: 0, nonGestureStarts: 0, nonGestureFailures: 0, finals: 0, cancels: 0, watchdogs: 0, errors: {}, firstResultMs: null, finalMs: null };

  // 這句結束（瀏覽器的 onend、取消、或停止後等太久）：只收尾一次
  function finish(u, r) {
    if (u.ended) return;
    u.ended = true;
    clearTimeout(u.timer);
    if (recog === r) recog = null;
    if (cur === u) cur = null;
    onState('idle', u);
    if (!u.cancelled && !u.delivered && u.finalText.trim()) {
      u.delivered = true;
      stats.finals += 1;
      stats.finalMs = now() - u.startedAt;
      onFinal(u, u.finalText.trim());
    }
  }

  function stop() {
    const r = recog;
    const u = cur;
    if (!r || !u) return;
    try {
      r.stop();
    } catch {
      /* 已經停了 */
    }
    clearTimeout(u.timer);
    u.timer = setTimeout(() => {
      // 瀏覽器一直沒結束這句（不送 onend）：自己收尾，不然下一句開不起來
      stats.watchdogs += 1;
      try {
        r.abort();
      } catch {
        /* 不管 */
      }
      finish(u, r);
    }, stopGraceMs);
  }

  // gesture：這次開始是不是在使用者手勢裡（點螢幕、按鍵）。沒給就問瀏覽器（navigator.userActivation）
  function start(context = {}, { gesture } = {}) {
    if (why) {
      onError(why, VOICE_ERRORS[why]);
      return null;
    }
    if (recog) return cur;
    const g = typeof gesture === 'boolean' ? gesture : (win.navigator?.userActivation?.isActive ?? null);
    const u = { id: uid(), context, finalText: '', cancelled: false, delivered: false, ended: false, startedAt: now(), firstResultAt: null, gesture: g, timer: null };
    const r = new SR();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (ev) => {
      if (u.ended || u.cancelled) return; // 取消、收尾之後才到的結果：不理
      if (u.firstResultAt == null) {
        u.firstResultAt = now();
        stats.firstResultMs = u.firstResultAt - u.startedAt;
      }
      // 每次都從完整的結果清單重算（瀏覽器重送同一個最終結果，也不會變成兩份）
      let fin = '';
      let interim = '';
      for (let i = 0; i < ev.results.length; i += 1) {
        const res = ev.results[i];
        if (res.isFinal) fin += res[0].transcript;
        else interim += res[0].transcript;
      }
      u.finalText = fin;
      onPartial(u, fin + interim);
    };
    r.onerror = (ev) => {
      if (u.ended) return;
      const code = ev.error || 'error';
      stats.errors[code] = (stats.errors[code] || 0) + 1;
      if (code === 'not-allowed' && u.gesture === false) stats.nonGestureFailures += 1;
      if (code !== 'aborted') onError(code, VOICE_ERRORS[code] ?? `語音辨識：${code}`, u);
    };
    r.onend = () => finish(u, r);
    try {
      r.start();
    } catch (e) {
      stats.errors.start = (stats.errors.start || 0) + 1;
      if (u.gesture === false) stats.nonGestureFailures += 1;
      onError('start', `語音辨識開不起來：${e.message}`, u);
      return null;
    }
    recog = r;
    cur = u;
    stats.starts += 1;
    if (u.gesture === true) stats.gestureStarts += 1;
    else if (u.gesture === false) stats.nonGestureStarts += 1;
    u.timer = setTimeout(stop, maxMs); // 一句太長：自動停止（有聽到的照樣交出）
    onState('listening', u);
    return u;
  }

  return {
    get supported() {
      return !why;
    },
    get reason() {
      return why;
    },
    get listening() {
      return !!recog;
    },
    get current() {
      return cur;
    },
    stats() {
      return { ...stats, errors: { ...stats.errors } };
    },
    start,
    // 說完了：停止收音，最終結果交出去
    stop,
    // 不要這句：當場丟掉（之後再到的結果不理、不會送出）；回傳有沒有正在聽的那句
    cancel(reason = 'cancel') {
      const u = cur;
      const r = recog;
      if (!u) return false;
      u.cancelled = true;
      u.cancelReason = reason;
      stats.cancels += 1;
      try {
        r?.abort();
      } catch {
        /* 已經停了 */
      }
      finish(u, r);
      return true;
    },
  };
}
