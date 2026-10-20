// 開火閃光大小（不用瀏覽器）：用真的 createTools，鏡頭、槍口位置照第一人稱持槍（手機直拿槍口在鏡頭前約 0.73 公尺），
// 以不同幀率（120／60／30／20 fps）開火、打 10 公尺外的標靶、也打 2 公尺內的東西，逐格看每顆閃光在畫面上的張角。
// 槍口閃光、近距離命中閃光都不能脹成蓋住大半畫面的一團；10 公尺外標靶上的命中閃光維持原本大小（最大半徑約 0.56 公尺）。
//   node tests/flash-unit.mjs                    （TOOLS=<別的 tools.mjs 路徑> 可以拿舊版比較）
import * as THREE from 'three';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { createTools } = await import(pathToFileURL(path.resolve(process.env.TOOLS || path.join(HERE, '..', 'public', 'tools.mjs'))).href);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// 開一槍打 dist 公尺外的板子，逐格記下每顆閃光的半徑、離鏡頭距離、張角
function shoot({ fps, dist, muzzle = [0.07, -0.172, -0.698] }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(82, 390 / 844, 0.03, 200);
  camera.position.set(0, 1.6, 1.5);
  scene.add(camera);
  const gun = new THREE.Group();
  const m = new THREE.Object3D();
  m.position.set(...muzzle);
  gun.add(m);
  gun.userData.muzzle = m;
  camera.add(gun);
  const board = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.1), new THREE.MeshBasicMaterial());
  board.position.set(0, 1.6, 1.5 - dist);
  scene.add(board);
  scene.updateMatrixWorld(true);
  const input = { actionPressed: true, actionHeld: false };
  const engine = { active: true, mode: 'wear', session: { inst: { partId: 'gun', object: gun } }, input };
  const parts = new Map([['gun', { tool: { kind: 'blaster' } }]]);
  const tools = createTools({ THREE, scene, camera, engine, partOf: (id) => parts.get(id), hittables: () => [{ object: board }] });
  const cam = camera.getWorldPosition(new THREE.Vector3());
  const seen = { 槍口: [], 命中: [] };
  for (let f = 0; f < fps * 1.5; f += 1) {
    tools.update(1 / fps);
    input.actionPressed = false;
    for (const o of scene.children) {
      if (!o.isMesh || o.userData?.kind !== 'flash') continue;
      const r = o.scale.x;
      const D = o.position.distanceTo(cam);
      seen[o.userData.max <= 0.1 ? '槍口' : '命中'].push({ r, D, deg: THREE.MathUtils.radToDeg(D > r ? Math.asin(r / D) : Math.PI / 2) });
    }
  }
  const peak = (k) => seen[k].reduce((a, b) => (b.deg > a.deg ? b : a), { r: 0, D: 0, deg: 0 });
  return { muzzle: peak('槍口'), hit: peak('命中'), frames: { 槍口: seen.槍口.length, 命中: seen.命中.length } };
}
const fmt = (p) => `半徑 ${p.r.toFixed(3)} m、離鏡頭 ${p.D.toFixed(2)} m、張角 ${p.deg.toFixed(1)}°`;

for (const fps of [120, 60, 30, 20]) {
  const far = shoot({ fps, dist: 10 });
  const near = shoot({ fps, dist: 2 });
  console.log(`\n${fps} fps：槍口閃光畫了 ${far.frames.槍口} 格、命中閃光 ${far.frames.命中} 格`);
  if (far.frames.槍口) check(`  ${fps} fps 第一人稱槍口閃光是小小一團（張角 ≤ 5°）`, far.muzzle.deg <= 5.01, fmt(far.muzzle));
  check(`  ${fps} fps 10 公尺外標靶的命中閃光維持原本大小（最大半徑 ≥ 0.5 m）`, far.hit.r >= 0.5 && far.hit.deg <= 5.01, fmt(far.hit));
  check(`  ${fps} fps 2 公尺內打中東西，命中閃光也不會脹滿畫面（張角 ≤ 5°）`, near.hit.deg <= 5.01, fmt(near.hit));
}
// 槍拿得更靠近眼睛（例如頭戴、手伸到眼前 0.3 公尺）：閃光跟著縮小，不會糊在臉上
const close = shoot({ fps: 60, dist: 10, muzzle: [0.05, -0.08, -0.3] });
check('槍口在眼前 0.3 公尺，槍口閃光張角仍 ≤ 5°', close.muzzle.deg <= 5.01, fmt(close.muzzle));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);
