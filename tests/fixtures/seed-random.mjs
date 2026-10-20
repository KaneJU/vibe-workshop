// 只給前後對照拍照用：用 `node --import tests/fixtures/seed-random.mjs server.mjs` 啟動測試伺服器時，
// 讓 crypto.randomInt 變成固定順序（房號一樣 → 標靶位置一樣），通行碼、身分 token 照舊是真亂數。正式服務不會載入這個檔。
import crypto from 'node:crypto';

let s = 20261020;
crypto.randomInt = (min, max, cb) => {
  if (typeof max !== 'number') {
    cb = max;
    max = min;
    min = 0;
  }
  s = (Math.imul(s, 1103515245) + 12345) >>> 0;
  const v = min + ((s >>> 16) % (max - min)); // 用高位元（低位元的週期很短）
  if (typeof cb === 'function') {
    cb(null, v);
    return undefined;
  }
  return v;
};
