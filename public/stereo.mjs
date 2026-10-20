// 手機眼鏡模式（紙盒）的雙眼畫面：左右眼各自的視點與投影、鏡片畸變校正、校正圖。
// 不靠 WebXR（iPhone Safari 沒有 immersive-vr）：場景每格只更新一次，畫兩次（左眼、右眼），影子也只算一次。
// 鏡片模型借用 Google Cardboard 的參數：鏡片中心距、鏡片到螢幕距離、徑向畸變 k1、k2——
// 螢幕上離鏡片中心 t（以「鏡片到螢幕距離」為單位的 tan 角）的點，眼睛看到的是 t × (1 + k1·t² + k2·t⁴)。
// 每眼的投影以鏡片光學中心為中心（偏軸投影），兩眼畫面不會是同一張的複製。
// 數學（eyeViews、eyeFrustum）不碰瀏覽器，Node 測試直接驗。

export const LENS_PRESETS = {
  cardboard1: { name: '接近 Cardboard v1', lensSepMm: 60, screenToLensMm: 42, k1: 0.441, k2: 0.156, maxHalfFovDeg: 40 },
  cardboard2: { name: '接近 Cardboard v2', lensSepMm: 64, screenToLensMm: 39.3, k1: 0.34, k2: 0.55, maxHalfFovDeg: 50 },
  flat: { name: '不校正畸變', lensSepMm: 62, screenToLensMm: 42, k1: 0, k2: 0, maxHalfFovDeg: 55 },
};

// 預設值：手機型號、鏡片都還沒指定，是「可以調」的起點，不是已經對好的參數（畫面上標「未校正」）
export const STEREO_DEFAULTS = {
  preset: 'cardboard1',
  ipdMm: 63, // 兩個虛擬眼睛相隔多遠（瞳距）
  lensSepMm: 60, // 紙盒上兩片鏡片的中心距離
  screenToLensMm: 42,
  centerY: 0.5, // 鏡片中心在畫面高度的哪裡（0＝最上、1＝最下）
  k1: 0.441,
  k2: 0.156,
  maxHalfFovDeg: 40, // 鏡片看得到的範圍（超出的地方畫黑色，省得白算）
  pxPerMm: 6.03, // 螢幕密度（CSS px／公釐）：近年的 iPhone 約 6.0，iPhone SE 約 6.4
  distortion: true,
  renderScale: 1.5, // 眼鏡模式的解析度倍數（裝置像素比上限）
};

// 範圍：校正面板的滑桿和讀設定時都用這張表擋掉不合理的值
export const STEREO_RANGE = {
  ipdMm: [50, 76],
  lensSepMm: [45, 80],
  screenToLensMm: [25, 70],
  centerY: [0.2, 0.8],
  k1: [0, 1.2],
  k2: [0, 1.2],
  maxHalfFovDeg: [25, 70],
  pxPerMm: [4, 9],
  renderScale: [0.75, 3],
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function cleanStereo(raw = {}) {
  const s = { ...STEREO_DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const [k, [lo, hi]] of Object.entries(STEREO_RANGE)) if (Number.isFinite(raw[k])) s[k] = clamp(raw[k], lo, hi);
    if (typeof raw.distortion === 'boolean') s.distortion = raw.distortion;
    if (typeof raw.preset === 'string' && (LENS_PRESETS[raw.preset] || raw.preset === 'custom')) s.preset = raw.preset;
  }
  return s;
}

// 畫面切成左右兩半，各自的鏡片中心（px，從那一半的左上角算）與焦距（每個 tan 單位幾 px）
export function eyeViews(width, height, s) {
  const half = width / 2;
  const sepPx = s.lensSepMm * s.pxPerMm;
  const f = s.screenToLensMm * s.pxPerMm;
  const cy = s.centerY * height;
  return [-1, 1].map((side) => {
    const x = side < 0 ? 0 : half;
    return { side, vp: { x, y: 0, w: half, h: height }, center: { x: width / 2 + (side * sepPx) / 2 - x, y: cy }, f };
  });
}

export const distortScale = (r2, k1, k2) => 1 + k1 * r2 + k2 * r2 * r2;

// 這隻眼睛的畫面邊界，換成眼睛看出去的 tan 角（y 往上為正）：投影矩陣與渲染目標都用它。
// 畸變校正是「往外拉」，四個角拉得最多，所以沿著邊界取點找最外圈。
export function eyeFrustum(eye, s) {
  const { vp, center, f } = eye;
  const k1 = s.distortion ? s.k1 : 0;
  const k2 = s.distortion ? s.k2 : 0;
  const x0 = -center.x / f;
  const x1 = (vp.w - center.x) / f;
  const y0 = -(vp.h - center.y) / f; // 下緣
  const y1 = center.y / f; // 上緣
  let left = Infinity;
  let right = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  const N = 12;
  const take = (x, y) => {
    const k = distortScale(x * x + y * y, k1, k2);
    left = Math.min(left, x * k);
    right = Math.max(right, x * k);
    bottom = Math.min(bottom, y * k);
    top = Math.max(top, y * k);
  };
  for (let i = 0; i <= N; i += 1) {
    const u = i / N;
    take(x0 + (x1 - x0) * u, y0);
    take(x0 + (x1 - x0) * u, y1);
    take(x0, y0 + (y1 - y0) * u);
    take(x1, y0 + (y1 - y0) * u);
  }
  if (s.distortion) {
    const lim = Math.tan((s.maxHalfFovDeg * Math.PI) / 180);
    left = Math.max(left, -lim);
    right = Math.min(right, lim);
    bottom = Math.max(bottom, -lim);
    top = Math.min(top, lim);
  }
  return { left, right, bottom, top, screen: { x0, x1, y0, y1 } };
}

// 給校正面板看的：這組參數下，每眼看出去大約幾度
export function fovSummary(width, height, s) {
  const [L] = eyeViews(width, height, s);
  const fr = eyeFrustum(L, s);
  const deg = (t) => Math.round((Math.atan(Math.abs(t)) * 180) / Math.PI);
  return { horizontal: deg(fr.left) + deg(fr.right), vertical: deg(fr.top) + deg(fr.bottom) };
}

const DISTORT_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const DISTORT_FRAG = /* glsl */ `
uniform sampler2D tEye;
uniform vec2 uCenter;
uniform vec2 uScale;
uniform vec2 uK;
uniform vec4 uFrustum; // left, right, bottom, top（tan 角）
uniform float uLim;
varying vec2 vUv;
void main() {
  vec2 t = (vUv - uCenter) * uScale;
  float r2 = dot(t, t);
  vec2 T = t * (1.0 + uK.x * r2 + uK.y * r2 * r2);
  vec2 uv = (T - uFrustum.xz) / (uFrustum.yw - uFrustum.xz);
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float edge = 1.0 - smoothstep(uLim * 0.94, uLim, max(abs(T.x), abs(T.y)));
  gl_FragColor = vec4(texture2D(tEye, clamp(uv, 0.0, 1.0)).rgb * inside * edge, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createStereo({ THREE, renderer, maxTexture = 2048 }) {
  let s = { ...STEREO_DEFAULTS };
  const eyes = [new THREE.PerspectiveCamera(), new THREE.PerspectiveCamera()];
  eyes[0].name = 'eye-left';
  eyes[1].name = 'eye-right';
  // 校正圖：左眼才看得到的「L」放第 1 層、右眼的「R」放第 2 層（跟 three.js 的 StereoCamera 一樣的分法）
  eyes[0].layers.enable(1);
  eyes[1].layers.enable(2);
  const size = new THREE.Vector2();
  const headPos = new THREE.Vector3();
  const headQ = new THREE.Quaternion();
  const headScale = new THREE.Vector3();
  const offset = new THREE.Vector3();
  let rt = null;
  let calib = null;
  const near = 0.03;
  const far = 200;
  const info = { eyesRendered: 0, lastFrustums: null, rt: null, mode: 'direct' };

  const quadMat = new THREE.ShaderMaterial({
    uniforms: {
      tEye: { value: null },
      uCenter: { value: new THREE.Vector2() },
      uScale: { value: new THREE.Vector2() },
      uK: { value: new THREE.Vector2() },
      uFrustum: { value: new THREE.Vector4() },
      uLim: { value: 1 },
    },
    vertexShader: DISTORT_VERT,
    fragmentShader: DISTORT_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function ensureTarget(w, h) {
    if (rt && rt.width === w && rt.height === h) return rt;
    rt?.dispose();
    const isGL2 = renderer.capabilities?.isWebGL2 !== false;
    rt = new THREE.WebGLRenderTarget(w, h, {
      type: isGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType, // 先不做色調對映，留到畫到螢幕時才做（跟單眼畫面一樣亮）
      samples: isGL2 ? 4 : 0,
      depthBuffer: true,
    });
    rt.texture.name = 'stereo-eye';
    info.rt = { width: w, height: h };
    return rt;
  }

  function placeEye(cam, head, side, fr) {
    head.updateMatrixWorld(true);
    head.matrixWorld.decompose(headPos, headQ, headScale);
    offset.set((side * s.ipdMm) / 2000, 0, 0).applyQuaternion(headQ);
    cam.position.copy(headPos).add(offset);
    cam.quaternion.copy(headQ);
    cam.updateMatrixWorld(true);
    cam.projectionMatrix.makePerspective(fr.left * near, fr.right * near, fr.top * near, fr.bottom * near, near, far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  function calibScene() {
    if (calib) return calib;
    // 頭固定的校正圖：10 公尺外一片格線（每 10°）、中央十字、5°／15°／30° 的圓；鏡片中心距對了，兩眼的十字會疊成一個
    const g = new THREE.Scene();
    g.background = new THREE.Color(0x02040a);
    const D = 10;
    const pts = [];
    for (let deg = -60; deg <= 60; deg += 10) {
      const t = Math.tan((deg * Math.PI) / 180) * D;
      pts.push(-D * 2, t, -D, D * 2, t, -D, t, -D * 2, -D, t, D * 2, -D);
    }
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
      new THREE.LineBasicMaterial({ color: 0x2c7a99 }),
    );
    g.add(grid);
    const cross = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-0.6, 0, -D, 0.6, 0, -D, 0, -0.6, -D, 0, 0.6, -D], 3)),
      new THREE.LineBasicMaterial({ color: 0xfff36b }),
    );
    g.add(cross);
    for (const deg of [5, 15, 30]) {
      const r = Math.tan((deg * Math.PI) / 180) * D;
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.025, r + 0.025, 96), new THREE.MeshBasicMaterial({ color: deg === 5 ? 0xfff36b : 0x38e1ff }));
      ring.position.z = -D;
      g.add(ring);
    }
    for (const [label, layer, x] of [['L', 1, -2.6], ['R', 2, 2.6]]) {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#38e1ff';
      ctx.font = 'bold 96px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 64, 68);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      m.position.set(x, 1.6, -D);
      m.layers.set(layer);
      g.add(m);
    }
    calib = g;
    return g;
  }

  const headOnly = new THREE.Object3D(); // 校正圖用：頭在原點、不轉

  // 畫一格：world 已經更新好，這裡只負責畫左右眼
  function render(scene, head, { calibration = false } = {}) {
    renderer.getSize(size);
    const views = eyeViews(size.x, size.y, s);
    const target = calibration ? calibScene() : scene;
    const pose = calibration ? headOnly : head;
    const useRT = s.distortion;
    info.mode = useRT ? 'distort' : 'direct';
    const pr = renderer.getPixelRatio();
    const frs = views.map((v) => eyeFrustum(v, s));
    info.lastFrustums = frs;
    // 影子只畫一次：兩隻眼睛共用同一張陰影圖
    const autoShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    const autoClear = renderer.autoClear;
    let w = 0;
    let h = 0;
    if (useRT) {
      for (const fr of frs) {
        w = Math.max(w, Math.ceil((fr.right - fr.left) * views[0].f * pr));
        h = Math.max(h, Math.ceil((fr.top - fr.bottom) * views[0].f * pr));
      }
      const k = Math.min(1, maxTexture / Math.max(w, h));
      ensureTarget(Math.max(16, Math.round(w * k)), Math.max(16, Math.round(h * k)));
    }
    const autoMatrix = target.matrixWorldAutoUpdate;
    try {
      views.forEach((v, i) => {
        const cam = eyes[i];
        const fr = frs[i];
        placeEye(cam, pose, v.side, fr);
        if (i === 1) target.matrixWorldAutoUpdate = false; // 場景的矩陣第一眼已經更新過，第二眼不用再算一次
        renderer.autoClear = true;
        if (useRT) {
          renderer.setRenderTarget(rt);
          renderer.render(target, cam);
          renderer.setRenderTarget(null);
          renderer.setScissorTest(true);
          renderer.setViewport(v.vp.x, v.vp.y, v.vp.w, v.vp.h);
          renderer.setScissor(v.vp.x, v.vp.y, v.vp.w, v.vp.h);
          const u = quadMat.uniforms;
          u.tEye.value = rt.texture;
          u.uCenter.value.set(v.center.x / v.vp.w, 1 - v.center.y / v.vp.h);
          u.uScale.value.set(v.vp.w / v.f, v.vp.h / v.f);
          u.uK.value.set(s.k1, s.k2);
          u.uFrustum.value.set(fr.left, fr.right, fr.bottom, fr.top);
          u.uLim.value = Math.tan((s.maxHalfFovDeg * Math.PI) / 180);
          renderer.render(quadScene, quadCam);
        } else {
          renderer.setScissorTest(true);
          renderer.setViewport(v.vp.x, v.vp.y, v.vp.w, v.vp.h);
          renderer.setScissor(v.vp.x, v.vp.y, v.vp.w, v.vp.h);
          renderer.render(target, cam);
        }
        info.eyesRendered += 1;
      });
    } finally {
      target.matrixWorldAutoUpdate = autoMatrix;
      renderer.setRenderTarget(null);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, size.x, size.y);
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = autoShadow;
    }
  }

  return {
    eyes,
    info,
    get settings() {
      return s;
    },
    setSettings(next) {
      s = cleanStereo(next);
    },
    render,
    // 離開眼鏡模式：還原成單眼畫面要用的狀態，放掉渲染目標
    reset() {
      renderer.setRenderTarget(null);
      renderer.setScissorTest(false);
      renderer.getSize(size);
      renderer.setViewport(0, 0, size.x, size.y);
      rt?.dispose();
      rt = null;
      info.rt = null;
    },
    dispose() {
      this.reset();
      quad.geometry.dispose();
      quadMat.dispose();
      if (calib) {
        calib.traverse((o) => {
          o.geometry?.dispose?.();
          o.material?.map?.dispose?.();
          o.material?.dispose?.();
        });
        calib = null;
      }
    },
  };
}
