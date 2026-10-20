// 手部辨識（MediaPipe Hand Landmarker）：worker 和主執行緒共用的那一段。
// 影像只在這台裝置上推論：模型、WASM 都由工坊自己的伺服器提供，不連外、不上傳、不存檔。
// 版本鎖在 @mediapipe/tasks-vision 0.10.35：1.x 起內建每 60 秒把使用量指標送到 Google（odml.pa.googleapis.com），這裡不要。
// 模型：hand_landmarker.task（float16 第 1 版，Apache-2.0），載入前核對大小與 SHA-256。

export const VISION = {
  version: '0.10.35',
  bundle: '/vendor/mediapipe/vision_bundle.mjs',
  wasmBase: '/vendor/mediapipe/wasm',
  model: {
    url: '/vendor/models/hand_landmarker.task',
    bytes: 7819105,
    sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
  },
};

// 失敗分類：畫面上的說明照這個代碼寫，不把英文錯誤直接丟給玩家
export class HandInitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function sha256Hex(buf) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null; // 非安全連線沒有 crypto.subtle（那種情況本來就開不了鏡頭）
  const d = new Uint8Array(await subtle.digest('SHA-256', buf));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function loadModel(fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(VISION.model.url);
  } catch (e) {
    throw new HandInitError('model-network', `連不到伺服器下載手勢模型（${e.message}）`);
  }
  if (res.status === 404) throw new HandInitError('model-missing', '伺服器上還沒有手勢模型檔（在電腦上執行 npm run fetch:models）');
  if (!res.ok) throw new HandInitError('model-http', `手勢模型下載失敗（HTTP ${res.status}）`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== VISION.model.bytes) throw new HandInitError('model-corrupt', `手勢模型檔大小不對（${buf.byteLength} bytes）`);
  const hash = await sha256Hex(buf);
  if (hash && hash !== VISION.model.sha256) throw new HandInitError('model-corrupt', '手勢模型檔內容不對（SHA-256 不符）');
  return new Uint8Array(buf);
}

export async function simdSupported() {
  // 跟 MediaPipe 自己的檢查同一段最小 WASM（含 SIMD 指令）
  const probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
  try {
    await WebAssembly.instantiate(probe);
    return true;
  } catch {
    return false;
  }
}

// inWorker：module worker 只能用 ES module 版的 WASM 載入器（它一定要 SIMD：iOS 16.4 以上）
export async function createLandmarker({ delegate = 'CPU', numHands = 2, inWorker = false } = {}) {
  const simd = await simdSupported();
  if (inWorker && !simd) throw new HandInitError('no-simd', '這個瀏覽器的 WebAssembly 不支援 SIMD（需要 iOS 16.4 以上）');
  let vision;
  try {
    vision = await import(VISION.bundle);
  } catch (e) {
    throw new HandInitError('runtime-missing', `手勢辨識程式載入失敗（${e.message}）`);
  }
  const model = await loadModel();
  const name = inWorker ? 'vision_wasm_module_internal' : simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
  const fileset = { wasmLoaderPath: `${VISION.wasmBase}/${name}.js`, wasmBinaryPath: `${VISION.wasmBase}/${name}.wasm` };
  try {
    return await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model, delegate },
      runningMode: 'VIDEO',
      numHands,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.5,
    });
  } catch (e) {
    throw new HandInitError('runtime-init', `手勢辨識啟動失敗（${delegate}：${String(e?.message || e).slice(0, 160)}）`);
  }
}

// 推論結果壓成可以轉移的 Float32Array（每隻手 21 點 × xyz）
export function packResult(r) {
  return (r.landmarks || []).map((lm, i) => {
    const w = r.worldLandmarks?.[i];
    const L = new Float32Array(63);
    const W = w ? new Float32Array(63) : null;
    for (let k = 0; k < 21; k += 1) {
      L[k * 3] = lm[k].x;
      L[k * 3 + 1] = lm[k].y;
      L[k * 3 + 2] = lm[k].z;
      if (W) {
        W[k * 3] = w[k].x;
        W[k * 3 + 1] = w[k].y;
        W[k * 3 + 2] = w[k].z;
      }
    }
    const h = r.handedness?.[i]?.[0];
    return { lm: L, world: W, handedness: h?.categoryName || null, score: h?.score ?? null };
  });
}
