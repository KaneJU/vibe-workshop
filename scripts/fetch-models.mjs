// 下載手勢辨識模型（MediaPipe Hand Landmarker，float16 第 1 版，Apache-2.0）到 models/，核對大小與 SHA-256。
//   npm run fetch:models                  從 Google 官方位置下載
//   npm run fetch:models -- --from <檔案>  改用手上已有的檔案（一樣要核對）
// 模型 7.8 MB，不放進 git；伺服器從 /vendor/models/ 提供給瀏覽器，瀏覽器載入前會再核對一次。
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISION } from '../public/handinfer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const DIR = process.env.MODELS_DIR ? path.resolve(process.env.MODELS_DIR) : path.join(ROOT, 'models');
const DEST = path.join(DIR, 'hand_landmarker.task');
const { bytes, sha256 } = VISION.model;

const check = (buf) => {
  if (buf.length !== bytes) return `大小不對（${buf.length}，應該是 ${bytes}）`;
  const h = createHash('sha256').update(buf).digest('hex');
  return h === sha256 ? null : `SHA-256 不符（${h}）`;
};

try {
  const have = await fs.readFile(DEST);
  if (!check(have)) {
    console.log(`已經有正確的模型：${DEST}`);
    process.exit(0);
  }
} catch {
  /* 還沒有 */
}

const i = process.argv.indexOf('--from');
let buf;
if (i > 0 && process.argv[i + 1]) {
  buf = await fs.readFile(path.resolve(process.argv[i + 1]));
} else {
  console.log(`下載 ${SOURCE}`);
  const res = await fetch(SOURCE);
  if (!res.ok) {
    console.error(`下載失敗：HTTP ${res.status}`);
    process.exit(1);
  }
  buf = Buffer.from(await res.arrayBuffer());
}
const bad = check(buf);
if (bad) {
  console.error(`模型檔不對：${bad}`);
  process.exit(1);
}
await fs.mkdir(DIR, { recursive: true });
const tmp = `${DEST}.${process.pid}.tmp`;
await fs.writeFile(tmp, buf);
await fs.rename(tmp, DEST);
console.log(`完成：${DEST}（${bytes} bytes，SHA-256 ${sha256}）`);
