// 手部辨識的 worker：推論不卡住畫面（雙眼畫面要穩在 60 fps 才不會暈）。
// 一次只處理一張；主執行緒負責限頻與丟掉過期的結果。
// 只准連回工坊自己的伺服器：伺服器給這支檔案的 CSP 是 connect-src 'self'，這裡再擋一次（就算之後換版本也不會偷偷外送）。
import { createLandmarker, packResult, HandInitError } from './handinfer.mjs';

const sameOrigin = (u) => {
  try {
    return new URL(String(u?.url ?? u), self.location.href).origin === self.location.origin;
  } catch {
    return false;
  }
};
const nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => (sameOrigin(input) ? nativeFetch(input, init) : Promise.reject(new TypeError('手勢辨識不連外')));
if (self.navigator && 'sendBeacon' in self.navigator) self.navigator.sendBeacon = () => false;
if (self.XMLHttpRequest) {
  const open = self.XMLHttpRequest.prototype.open;
  self.XMLHttpRequest.prototype.open = function guardedOpen(method, url, ...rest) {
    if (!sameOrigin(url)) throw new TypeError('手勢辨識不連外');
    return open.call(this, method, url, ...rest);
  };
}
self.WebSocket = undefined;

let landmarker = null;
let lastTs = 0;

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    const t0 = performance.now();
    try {
      landmarker?.close();
      landmarker = await createLandmarker({ delegate: msg.delegate || 'CPU', numHands: msg.numHands || 2, inWorker: true });
      self.postMessage({ type: 'ready', ms: Math.round(performance.now() - t0), delegate: msg.delegate || 'CPU' });
    } catch (err) {
      self.postMessage({ type: 'error', stage: 'init', code: err instanceof HandInitError ? err.code : 'runtime-init', message: String(err?.message || err) });
    }
    return;
  }
  if (msg.type === 'detect') {
    const { seq, bitmap } = msg;
    if (!landmarker) {
      bitmap?.close?.();
      self.postMessage({ type: 'error', stage: 'detect', seq, code: 'not-ready', message: 'not ready' });
      return;
    }
    const t0 = performance.now();
    try {
      const ts = Math.max(lastTs + 1, Math.round(msg.ts)); // VIDEO 模式的時間戳一定要遞增
      lastTs = ts;
      const hands = packResult(landmarker.detectForVideo(bitmap, ts));
      const transfer = [];
      for (const h of hands) transfer.push(h.lm.buffer, ...(h.world ? [h.world.buffer] : []));
      self.postMessage({ type: 'result', seq, ms: performance.now() - t0, hands }, transfer);
    } catch (err) {
      self.postMessage({ type: 'error', stage: 'detect', seq, code: 'detect', message: String(err?.message || err).slice(0, 200) });
    } finally {
      bitmap?.close?.();
    }
    return;
  }
  if (msg.type === 'close') {
    landmarker?.close();
    landmarker = null;
    self.close();
  }
};
