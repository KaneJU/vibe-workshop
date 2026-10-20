// 語音輸入（瀏覽器的 SpeechRecognition，zh-TW、單句）：自由工坊的 🎙 與創作世界共用這一份。
// - 每一句話是一個 utterance：開始說的那一刻就把「在哪個世界、選了什麼、要改哪一版」記下來（context），
//   說到一半換世界、換選取，也不會把「這個」指到別的東西
// - 中間結果只拿來顯示（onPartial）；說完的最終結果每句只交出一次（onFinal），網路重送由伺服器用 utteranceId 去重
// - 取消（cancel）就丟掉這句話；不支援、拒絕麥克風都會回報原因，打字照樣能用
// 瀏覽器的語音辨識不一定在本機處理（可能送到瀏覽器廠商的服務）；這裡不另外錄音、不存音檔、不加付費辨識。
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

export function createVoice({ win = globalThis, lang = 'zh-TW', onPartial = () => {}, onFinal = () => {}, onState = () => {}, onError = () => {} } = {}) {
  const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
  const why = !SR ? 'unsupported' : !win.isSecureContext ? 'insecure' : null;
  let recog = null;
  let cur = null; // { id, context, finalText, cancelled, delivered }

  function start(context = {}) {
    if (why) {
      onError(why, VOICE_ERRORS[why]);
      return null;
    }
    if (recog) return cur;
    const u = { id: uid(), context, finalText: '', cancelled: false, delivered: false, startedAt: Date.now() };
    cur = u;
    const r = new SR();
    recog = r;
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const res = ev.results[i];
        if (res.isFinal) u.finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (!u.cancelled) onPartial(u, u.finalText + interim);
    };
    r.onerror = (ev) => {
      const code = ev.error || 'error';
      if (code !== 'aborted') onError(code, VOICE_ERRORS[code] ?? `語音辨識：${code}`);
    };
    r.onend = () => {
      if (recog === r) recog = null;
      if (cur === u) cur = null;
      onState('idle', u);
      if (!u.cancelled && !u.delivered && u.finalText.trim()) {
        u.delivered = true;
        onFinal(u, u.finalText.trim());
      }
    };
    try {
      r.start();
    } catch (e) {
      recog = null;
      cur = null;
      onError('start', `語音辨識開不起來：${e.message}`);
      return null;
    }
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
    start,
    // 說完了：停止收音，最終結果交出去
    stop() {
      recog?.stop();
    },
    // 不要這句：丟掉
    cancel() {
      if (cur) cur.cancelled = true;
      recog?.abort();
    },
  };
}
