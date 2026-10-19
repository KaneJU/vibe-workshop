# Vibe 工坊

[English](README.md) · **繁體中文** · [हिन्दी](README.hi.md)

在 3D／VR 世界裡跟 AI 說話打造東西，就像鋼鐵人在自己的工作室。
說一句「給我一個發光的能量方塊」，幾十秒後它就出現在你面前。
把做好的東西疊起來、存成新零件，再叫 AI 拿這些零件**當材料**做出新東西。
不用重新整理、不用重新打包，你一直待在這個世界裡。

![Vibe 工坊電腦版畫面](docs/screenshot-desktop.jpg)

## 功能

- **用說的或打字就能打造**：[OpenAI Codex CLI](https://github.com/openai/codex) 當場寫出一個 three.js「零件」，通過驗收後直接放進正在跑的世界。
- **疊起來、組起來**：把物件拖到另一個上面就會疊上去；選好幾個，就能存成可以重複使用的零件。
- **拿做好的東西再做新的**：AI 做的零件可以用 `ctx.spawn(...)` 叫出其他零件，最多套 8 層。
- **原地改造**：選一個 AI 做的物件，說「改成紅色」，新版本會在原位置換上。
- **全部自動存檔**：場景和工具箱都會自動儲存，關掉分頁之後再開都還在。
- **電腦、手機、VR 都能用**：滑鼠鍵盤、適合手機的觸控版面，以及實驗中的 WebXR 模式（用手把抓起來、疊上去）。

<img src="docs/screenshot-mobile.jpg" width="260" alt="Vibe 工坊手機版畫面">

## AI 是怎麼做出 3D 模型的

Codex 不是在生成網格或圖片，而是**寫 60～80 行的 JavaScript**，用基本形狀（方塊、圓柱、球、圓環、旋轉曲面、擠出形狀）照公尺尺寸一塊塊組出物件，再加上金屬或發光材質，需要的話還會寫動畫。

每次打造都會開一個小小的工作資料夾，裡面有四樣東西：

| | 內容 | 作用 |
|---|---|---|
| 1 | 任務單（[`server.mjs`](server.mjs) 的 `taskPrompt()`） | 只有四行：使用者說了什麼、要新做還是改造、「寫出 `part.js` 和 `meta.json`，跑驗收直到 PASS」。 |
| 2 | [`fabricator/AGENTS.md`](fabricator/AGENTS.md) | 施工規格書：單位公尺、原點在底部中心、正面朝 +Z、`ctx` 介面、動畫寫法、效能預算、禁止使用的功能、擺放規則。 |
| 3 | `context.json` | 使用者說的話、目前選了什麼、附近有什麼、使用者站在哪，以及工具箱裡每個零件的名字和尺寸。 |
| 4 | [`fabricator/validate.mjs`](fabricator/validate.mjs) | 真的在 Node 裡把零件組出來、跑 90 格動畫，檢查尺寸、有沒有貼地、面數和燈光預算、有沒有用到禁止的功能，卡住超過 10 秒就判失敗。Codex 自己跑、沒過就改；伺服器收件前會再驗一次。 |

「套層」其實就是程式。八個能量方塊排成一圈，核心大概就是這樣：

```js
for (let i = 0; i < 8; i++) {
  const angle = (i / 8) * Math.PI * 2;
  const cube = ctx.spawn('藍光能量方塊'); // 工具箱裡現成的零件
  cube.position.set(Math.sin(angle) * 2.2, 0, -Math.cos(angle) * 2.2);
}
```

## 需要什麼

- Node.js 20 以上
- 已安裝並登入的 [OpenAI Codex CLI](https://github.com/openai/codex)（終端機打 `codex` 找得到）。每次打造都會用掉你的 Codex 額度。
- 新版瀏覽器（Chrome、Edge 或 Safari）
- 選用：支援 WebXR 的頭盔瀏覽器（例如 Meta Quest），需要 HTTPS，見下方「限制與接下來」

## 快速開始

```sh
git clone https://github.com/KaneJU/vibe-workshop.git
cd vibe-workshop
npm install
npm start
```

打開 <http://localhost:5310>。第一次啟動會載入一組示範場景（`examples/starter`）。在下方輸入框打你想要的東西，按 Enter。

## 操作

| 動作 | 電腦 | 手機 |
|---|---|---|
| 看 | 拖曳空白處轉視角；右鍵拖曳平移；滾輪縮放 | 一指轉視角；兩指縮放、平移 |
| 選取 | 點一下；Shift＋點可多選 | 點一下；要選好幾個先按「多選」 |
| 移動／疊放 | 拖曳物件，放到別的物件上就會疊上去 | 按住拖曳 |
| 旋轉／縮放 | Q / E、R / F | 上方動作列的 ⟲ ⟳ ＋ － |
| 刪除／複製／復原 | Delete、⌘D、⌘Z | 上方動作列 |
| 存成零件 | G 或「存成零件」 | 上方動作列 |
| 打造 | 打字後按 Enter，或按 🎙 用說的 | 打字，或用鍵盤上的聽寫 |
| 改造 | 選一個 AI 做的物件，勾「改造選取的物件」，再說要怎麼改 | 同左 |

不經過 AI、直接執行的指令：「把這疊存成零件，叫砲台」「復原」「刪除」「拆開」「複製 3 個」（英文也可以：*save as part called turret*、*undo*、*delete*、*ungroup*、*duplicate 3*）。

用什麼語言下指令都可以，零件名稱會跟著你用的語言。

## 用手機看（同一個網路）

1. 用 `HOST=0.0.0.0 npm start` 啟動（或安裝背景服務時加 `--lan`）。
2. 會在 `data/access-key` 產生一組通行碼。
3. 手機打開 `http://<電腦的 IP>:5310/?key=<通行碼>` 一次，之後這支手機會記住一年。

在電腦本機開不需要通行碼。其他裝置都要通行碼，而且不是私人網段的位址一律擋掉。

## 設定

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `5310` | 網頁埠號 |
| `HOST` | `127.0.0.1` | 設成 `0.0.0.0` 讓同網路的手機連得到（要通行碼） |
| `DATA_DIR` | `./data` | 場景、工具箱、生成的零件、通行碼 |
| `CODEX_BIN` | `codex` | Codex CLI 的路徑 |
| `CODEX_MODEL` | Codex 預設 | 傳給 `codex exec -m` 的模型 |

## 在背景常駐（macOS）

```sh
./launchd/install-macos.sh          # 只有這台電腦能用
./launchd/install-macos.sh --lan    # 同網路的手機也能用
```

會裝一個 LaunchAgent：開機登入後自動啟動，當掉會自己重開。移除方法：

```sh
launchctl bootout gui/$(id -u)/com.vibeworkshop.server
rm ~/Library/LaunchAgents/com.vibeworkshop.server.plist
```

## 安全須知

- AI 寫的程式會在你的瀏覽器分頁裡執行。這是給自己玩的創作工具，不是給陌生人用的沙盒。
- Codex 以 `--sandbox workspace-write` 執行，只能寫入 `jobs/` 底下該次任務的資料夾。
- 伺服器預設只聽本機。區網模式要通行碼，而且網址必須指名這台電腦（防 DNS rebinding）。
- 不要開放到公開網路上。

## 測試

測試會改動場景，所以要對一個用完即丟的資料夾跑（空資料夾第一次啟動時，會自動放入測試會用到的示範零件）：

```sh
npx playwright install chromium
rm -rf /tmp/vw-test-data
DATA_DIR=/tmp/vw-test-data PORT=5311 HOST=0.0.0.0 npm start &
npm test                 # 電腦版：疊放、存成零件、刪除與復原、重新整理還在
npm run test:mobile      # 模擬 iPhone 走區網：通行碼、抽屜、手指拖曳、多選
WITH_CODEX=1 npm test    # 再加跑一次真的打造和改造（會用 Codex 額度）
```

## 專案結構

```
server.mjs              網頁伺服器、存檔、派工給 Codex、通行碼
fabricator/AGENTS.md    給 Codex 的零件規格書
fabricator/validate.mjs 零件驗收程式（Codex 也會自己跑）
public/runtime.mjs      瀏覽器和驗收共用的零件組裝核心（套層與數量上限）
public/app.js           工坊本體：場景、選取、拖曳疊放、工具箱、語音、WebXR
public/index.html       頁面與操作說明
examples/starter/       第一次啟動時載入的示範零件與場景
launchd/                macOS 背景服務範本與安裝腳本
tests/                  Playwright 測試（電腦版與手機版）
```

## 限制與接下來

- 介面目前只有繁體中文。
- VR 模式（進入 VR、用手把抓起來疊）還沒在真的頭盔上測過，VR 裡也還不能用說的打造。
- 頭盔要 HTTPS 才能進 WebXR，瀏覽器也要 HTTPS 才給網頁用麥克風。在區網用 http 連時，請改用手機鍵盤的聽寫。
- AI 看不到自己做出來的樣子，只看得到驗收回報的數字。下一步想讓它截圖、自己看、自己修。
- 還沒有物理效果：東西不會掉落，也不會倒。

## 授權

[MIT](LICENSE)。使用 [three.js](https://threejs.org/) 與 [OpenAI Codex CLI](https://github.com/openai/codex) 打造。
